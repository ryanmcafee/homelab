package verify

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// SyncWaveAnnotation orders objects within an ArgoCD sync.
const SyncWaveAnnotation = "argocd.argoproj.io/sync-wave"

// repositorySecretLabel marks a Secret as an ArgoCD repository credential.
const repositorySecretLabel = "argocd.argoproj.io/secret-type"

// GitOpsRules are the rule ids emitted by LintGitOps, in declaration order.
// Check names are "gitops/<env>/<rule>".
var GitOpsRules = []string{
	"paths",
	"waves",
	"crd-order",
	"repo-secrets",
	"secret-refs",
	"namespaces",
	"ssa",
	"unique-names",
}

// LintGitOps turns the repo's GitOps conventions into executable checks over
// one environment's rendered manifests. rendered maps a chart directory name
// to the objects it produced (as written by the renderer and read back by
// LoadRenderDir). repoRoot is used only to stat Application source paths.
//
// It always returns exactly one Check per entry in GitOpsRules, so a caller
// can report a stable check set whether or not anything is wrong.
func LintGitOps(env string, rendered map[string][]Doc, reg *GitOpsRegistry, repoRoot string) []Check {
	if reg == nil {
		reg = &GitOpsRegistry{SystemNamespaces: DefaultSystemNamespaces}
	}
	g := buildGitOpsGraph(env, rendered)
	return []Check{
		g.rulePaths(repoRoot),
		g.ruleWaves(),
		g.ruleCRDOrder(reg),
		g.ruleRepoSecrets(),
		g.ruleSecretRefs(reg),
		g.ruleNamespaces(reg),
		g.ruleSSA(reg),
		g.ruleUniqueNames(),
	}
}

// orderKey is an object's position in the app-of-apps sync order: the wave of
// the parent Application that owns it, then its own wave. ArgoCD only orders
// waves within a single Application, so the parent wave dominates.
type orderKey struct {
	parent int
	wave   int
}

func (a orderKey) less(b orderKey) bool {
	if a.parent != b.parent {
		return a.parent < b.parent
	}
	return a.wave < b.wave
}

func (a orderKey) String() string { return fmt.Sprintf("parent wave %d, wave %d", a.parent, a.wave) }

// gitopsGraph is the rendered app-of-apps graph for one environment.
type gitopsGraph struct {
	env        string
	chartNames []string // sorted, for deterministic iteration
	rendered   map[string][]Doc
	docs       []Doc // every rendered object, chart-sorted
	apps       []Doc // every rendered Application, chart-sorted
	appByName  map[string]Doc
	// parentWave maps a parent chart name (bootstrap/addons/applications) to
	// the wave of its Application in the rendered gitops chart.
	parentWave map[string]int
	// chartOwner maps a chart directory name to the Application whose
	// spec.source.path is charts/<name>.
	chartOwner map[string]Doc
	namespaces map[string]bool
}

func buildGitOpsGraph(env string, rendered map[string][]Doc) *gitopsGraph {
	g := &gitopsGraph{
		env:        env,
		rendered:   rendered,
		appByName:  map[string]Doc{},
		parentWave: map[string]int{},
		chartOwner: map[string]Doc{},
		namespaces: map[string]bool{},
	}
	for name := range rendered {
		g.chartNames = append(g.chartNames, name)
	}
	sort.Strings(g.chartNames)

	for _, chart := range g.chartNames {
		for _, d := range rendered[chart] {
			if d.Kind() == "" {
				continue
			}
			g.docs = append(g.docs, d)
			if isApplication(d) {
				g.apps = append(g.apps, d)
				if _, dup := g.appByName[d.Name()]; !dup {
					g.appByName[d.Name()] = d
				}
			}
			if d.Kind() == "Namespace" && d.Group() == "" {
				g.namespaces[d.Name()] = true
			}
		}
	}

	for _, app := range g.apps {
		for _, src := range appSources(app) {
			p := strings.TrimSuffix(strings.TrimSpace(src.GetString("path")), "/")
			chart, ok := chartNameFromPath(p)
			if !ok {
				continue
			}
			if _, dup := g.chartOwner[chart]; !dup {
				g.chartOwner[chart] = app
			}
		}
	}

	for _, parent := range []string{"bootstrap", "addons", "applications"} {
		for _, d := range rendered["gitops"] {
			if isApplication(d) && d.Name() == parent {
				w, _ := docWave(d)
				g.parentWave[parent] = w
			}
		}
	}
	return g
}

func isApplication(d Doc) bool { return d.Kind() == "Application" && d.Group() == "argoproj.io" }

// chartNameFromPath extracts "x" from "charts/x". Deeper paths (for example
// charts/secrets/onepassword, a kustomize tree) are not chart directories.
func chartNameFromPath(p string) (string, bool) {
	parts := strings.Split(p, "/")
	if len(parts) != 2 || parts[0] != "charts" || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

// docWave reads the sync-wave annotation. The second result is false when the
// annotation is absent or not an integer; ArgoCD then treats the object as
// wave 0.
func docWave(d Doc) (int, bool) {
	s, ok := d.Annotations()[SyncWaveAnnotation]
	if !ok || strings.TrimSpace(s) == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0, false
	}
	return n, true
}

// appSources yields spec.source plus every spec.sources entry, each wrapped in
// a Doc so the Get* helpers apply.
func appSources(app Doc) []Doc {
	var out []Doc
	if v, ok := app.Get("spec", "source"); ok {
		if m, ok := v.(map[string]any); ok {
			out = append(out, Doc{Object: m, Chart: app.Chart, Env: app.Env})
		}
	}
	for _, v := range app.GetSlice("spec", "sources") {
		if m, ok := v.(map[string]any); ok {
			out = append(out, Doc{Object: m, Chart: app.Chart, Env: app.Env})
		}
	}
	return out
}

// appKey is an Application's own sync position.
func (g *gitopsGraph) appKey(app Doc) orderKey {
	w, _ := docWave(app)
	return orderKey{parent: g.parentWave[app.Chart], wave: w}
}

// objectKey is a rendered object's sync position. ok is false when the object
// is not part of this environment's graph: an orphan child chart (rendered for
// completeness but owned by no Application in this env) or an object of the
// gitops chart itself.
func (g *gitopsGraph) objectKey(d Doc) (orderKey, bool) {
	if d.Chart == "gitops" {
		return orderKey{}, false
	}
	if ParentCharts[d.Chart] {
		w, _ := docWave(d)
		return orderKey{parent: g.parentWave[d.Chart], wave: w}, true
	}
	owner, ok := g.chartOwner[d.Chart]
	if !ok {
		return orderKey{}, false
	}
	return g.appKey(owner), true
}

// destNamespace resolves the namespace an object lands in: its own, or the
// destination namespace of the Application that deploys its chart.
func (g *gitopsGraph) destNamespace(d Doc) string {
	if ns := d.Namespace(); ns != "" {
		return ns
	}
	if owner, ok := g.chartOwner[d.Chart]; ok {
		return owner.GetString("spec", "destination", "namespace")
	}
	return ""
}

// result builds the Check for one rule.
func (g *gitopsGraph) result(rule string, start time.Time, detail string, findings []string) Check {
	name := "gitops/" + g.env + "/" + rule
	if len(findings) == 0 {
		return PassCheck(name, start, detail)
	}
	sort.Strings(findings)
	return FailCheck(name, start, detail, findings...)
}

// -------------------------------------------------------------------------
// Rule: paths
// -------------------------------------------------------------------------

// rulePaths verifies every Application source path exists in the repo and
// every declared Helm value file exists inside it.
func (g *gitopsGraph) rulePaths(repoRoot string) Check {
	start := time.Now()
	var findings []string
	paths := 0

	for _, app := range g.apps {
		for _, src := range appSources(app) {
			p := strings.TrimSpace(src.GetString("path"))
			if p == "" || p == "." {
				continue
			}
			paths++
			clean := filepath.Clean(filepath.FromSlash(p))
			if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || filepath.IsAbs(clean) {
				findings = append(findings, fmt.Sprintf("%s: spec.source.path %q escapes the repository root", app.ID(), p))
				continue
			}
			abs := filepath.Join(repoRoot, clean)
			fi, err := os.Stat(abs)
			if err != nil || !fi.IsDir() {
				findings = append(findings, fmt.Sprintf("%s: spec.source.path %q is not a directory in the repository", app.ID(), p))
				continue
			}
			if src.GetString("helm", "ignoreMissingValueFiles") == "true" {
				continue
			}
			for _, vf := range src.GetStringSlice("helm", "valueFiles") {
				vf = strings.TrimSpace(vf)
				// $ref value files come from another source in a multi-source
				// Application and are resolved by ArgoCD, not from this path.
				if vf == "" || strings.HasPrefix(vf, "$") {
					continue
				}
				if _, err := os.Stat(filepath.Join(abs, filepath.FromSlash(vf))); err != nil {
					findings = append(findings, fmt.Sprintf(
						"%s: spec.source.helm.valueFiles entry %q does not exist in %s (set helm.ignoreMissingValueFiles: true if intended)",
						app.ID(), vf, p))
				}
			}
		}
	}
	return g.result("paths", start, fmt.Sprintf("%d Application source paths checked", paths), findings)
}

// -------------------------------------------------------------------------
// Rule: waves
// -------------------------------------------------------------------------

// ruleWaves enforces the repo's sibling-wave convention: an Application's
// -dependencies sibling syncs strictly earlier, and its -config sibling never
// shares its wave. Config charts that only create OnePasswordItems may run
// before the chart that consumes them, so only equality is forbidden there.
func (g *gitopsGraph) ruleWaves() Check {
	start := time.Now()
	var findings []string
	compared := 0

	for _, chart := range g.chartNames {
		byName := map[string]Doc{}
		var names []string
		for _, d := range g.rendered[chart] {
			if !isApplication(d) {
				continue
			}
			byName[d.Name()] = d
			names = append(names, d.Name())
		}
		sort.Strings(names)

		for _, name := range names {
			app := byName[name]
			wave, ok := docWave(app)
			if !ok {
				findings = append(findings, fmt.Sprintf("%s: missing or non-numeric %s annotation", app.ID(), SyncWaveAnnotation))
				continue
			}
			if dep, found := byName[name+"-dependencies"]; found {
				if depWave, okDep := docWave(dep); okDep {
					compared++
					if depWave >= wave {
						findings = append(findings, fmt.Sprintf(
							"%s: sync-wave %d must be lower than %s (wave %d)", dep.ID(), depWave, name, wave))
					}
				}
			}
			if cfg, found := byName[name+"-config"]; found {
				if cfgWave, okCfg := docWave(cfg); okCfg {
					compared++
					if cfgWave == wave {
						findings = append(findings, fmt.Sprintf(
							"%s: sync-wave %d must differ from %s (wave %d)", cfg.ID(), cfgWave, name, wave))
					}
				}
			}
		}
	}
	return g.result("waves", start, fmt.Sprintf("%d Applications, %d sibling wave comparisons", len(g.apps), compared), findings)
}

// -------------------------------------------------------------------------
// Rule: crd-order
// -------------------------------------------------------------------------

// ruleCRDOrder verifies every custom resource syncs strictly after the
// Application that installs its CRDs.
func (g *gitopsGraph) ruleCRDOrder(reg *GitOpsRegistry) Check {
	start := time.Now()
	var findings []string
	seen := map[string]bool{}
	checked := 0

	for _, d := range g.docs {
		group := d.Group()
		if group == "" {
			continue
		}
		prov, ok := reg.CRDProviders[group]
		if !ok {
			continue
		}
		if prov.Skips(d.Kind()) || (group == "argoproj.io" && appFamilyKinds[d.Kind()]) {
			continue
		}
		providerApp := prov.AppFor(d.Kind())
		if providerApp == "" {
			continue
		}
		objKey, inGraph := g.objectKey(d)
		if !inGraph {
			continue
		}
		checked++

		p, found := g.appByName[providerApp]
		if !found {
			msg := fmt.Sprintf("%s: API group %s needs provider Application %q, which this environment does not render",
				d.ID(), group, providerApp)
			if !seen[msg] {
				seen[msg] = true
				findings = append(findings, msg)
			}
			continue
		}
		if d.Name() == providerApp && isApplication(d) {
			continue
		}
		provKey := g.appKey(p)
		if !provKey.less(objKey) {
			findings = append(findings, fmt.Sprintf(
				"%s: %s at (%s) must sync after provider Application %s at (%s)",
				d.ID(), d.Kind(), objKey, providerApp, provKey))
		}
	}
	return g.result("crd-order", start, fmt.Sprintf("%d custom resources ordered against %d CRD providers", checked, len(reg.CRDProviders)), findings)
}

// -------------------------------------------------------------------------
// Rule: repo-secrets
// -------------------------------------------------------------------------

// ruleRepoSecrets verifies every OCI Helm repository an Application pulls from
// has a matching ArgoCD repository Secret with enableOCI set.
func (g *gitopsGraph) ruleRepoSecrets() Check {
	start := time.Now()
	var findings []string

	repoSecrets := map[string]Doc{}
	for _, d := range g.docs {
		if d.Kind() != "Secret" || d.Group() != "" {
			continue
		}
		if d.Labels()[repositorySecretLabel] != "repository" {
			continue
		}
		if url := secretValue(d, "url"); url != "" {
			repoSecrets[normalizeRepoURL(url)] = d
		}
	}

	ociRepos := 0
	reported := map[string]bool{}
	for _, app := range g.apps {
		for _, src := range appSources(app) {
			if strings.TrimSpace(src.GetString("chart")) == "" {
				continue
			}
			repo := strings.TrimSpace(src.GetString("repoURL"))
			if repo == "" || isHTTPRepo(repo) {
				continue
			}
			ociRepos++
			key := normalizeRepoURL(repo)
			sec, found := repoSecrets[key]
			if !found {
				findings = append(findings, fmt.Sprintf(
					"%s: OCI chart repository %q has no rendered Secret labelled %s=repository with url %q",
					app.ID(), repo, repositorySecretLabel, repo))
				continue
			}
			if secretValue(sec, "enableOCI") != "true" {
				msg := fmt.Sprintf("%s: repository Secret for %q must set enableOCI: \"true\"", sec.ID(), repo)
				if !reported[msg] {
					reported[msg] = true
					findings = append(findings, msg)
				}
			}
		}
	}
	return g.result("repo-secrets", start, fmt.Sprintf("%d OCI chart sources, %d repository Secrets", ociRepos, len(repoSecrets)), findings)
}

// secretValue reads a key from stringData, falling back to base64 data.
func secretValue(d Doc, key string) string {
	if v := d.GetString("stringData", key); v != "" {
		return v
	}
	if enc := d.GetString("data", key); enc != "" {
		if raw, err := base64.StdEncoding.DecodeString(enc); err == nil {
			return string(raw)
		}
	}
	return ""
}

// normalizeRepoURL makes OCI repository URLs comparable across the oci://
// prefix and a trailing slash.
func normalizeRepoURL(u string) string {
	u = strings.TrimSpace(u)
	u = strings.TrimPrefix(u, "oci://")
	return strings.TrimSuffix(u, "/")
}

func isHTTPRepo(u string) bool {
	l := strings.ToLower(strings.TrimSpace(u))
	return strings.HasPrefix(l, "http://") || strings.HasPrefix(l, "https://")
}

// -------------------------------------------------------------------------
// Rule: secret-refs
// -------------------------------------------------------------------------

// secretRef is one consumer reference to a Secret.
type secretRef struct {
	owner Doc
	ns    string
	name  string
	where string
}

// ruleSecretRefs verifies every Secret a rendered object or Helm value block
// consumes is produced somewhere in the same environment and namespace.
func (g *gitopsGraph) ruleSecretRefs(reg *GitOpsRegistry) Check {
	start := time.Now()

	producers := map[string]bool{}
	produce := func(ns, name string) {
		if ns != "" && name != "" {
			producers[ns+"/"+name] = true
		}
	}
	for _, d := range g.docs {
		ns := g.destNamespace(d)
		switch {
		case d.Kind() == "Secret" && d.Group() == "":
			produce(ns, d.Name())
		case d.Kind() == "OnePasswordItem":
			produce(ns, d.Name())
		case d.Kind() == "Certificate" && d.Group() == "cert-manager.io":
			produce(ns, d.GetString("spec", "secretName"))
		case d.Kind() == "ExternalSecret" || d.Kind() == "SealedSecret":
			// Both materialise a Secret of the same name.
			produce(ns, d.Name())
		}
	}

	var refs []secretRef
	for _, d := range g.docs {
		if isApplication(d) {
			// An Application's own object holds no Secret references; the
			// workload references live in its Helm values and land in the
			// Application's destination namespace, not in argocd.
			ns := d.GetString("spec", "destination", "namespace")
			for _, src := range appSources(d) {
				if vo, ok := src.Get("helm", "valuesObject"); ok {
					collectSecretRefs(vo, "spec.source.helm.valuesObject", d, ns, &refs)
				}
				if raw := src.GetString("helm", "values"); strings.TrimSpace(raw) != "" {
					var parsed any
					if err := yaml.Unmarshal([]byte(raw), &parsed); err == nil {
						collectSecretRefs(parsed, "spec.source.helm.values", d, ns, &refs)
					}
				}
			}
			continue
		}
		collectSecretRefs(d.Object, "", d, g.destNamespace(d), &refs)
	}

	var findings []string
	reported := map[string]bool{}
	for _, r := range refs {
		if r.ns == "" {
			continue
		}
		if producers[r.ns+"/"+r.name] || reg.KnownSecret(r.ns, r.name) {
			continue
		}
		key := r.owner.ID() + "|" + r.ns + "/" + r.name
		if reported[key] {
			continue
		}
		reported[key] = true
		findings = append(findings, fmt.Sprintf(
			"%s: references Secret %s/%s at %s, which no rendered Secret, OnePasswordItem or Certificate produces (register it in %s/known-secrets.yaml if it is created outside the rendered charts)",
			r.owner.ID(), r.ns, r.name, r.where, GitOpsRegistryDir))
	}
	return g.result("secret-refs", start, fmt.Sprintf("%d secret references, %d rendered producers", len(refs), len(producers)), findings)
}

// collectSecretRefs walks a decoded manifest subtree and records every
// consumer reference to a Secret. Ingress-style tls[].secretName is
// deliberately not collected: cert-manager creates those on demand.
func collectSecretRefs(node any, path string, owner Doc, ns string, out *[]secretRef) {
	switch v := node.(type) {
	case map[string]any:
		for _, key := range sortedKeys(v) {
			child := v[key]
			childPath := joinRefPath(path, key)
			switch key {
			case "secretKeyRef", "secretRef":
				if n := refName(child); n != "" {
					appendSecretRef(out, owner, ns, n, childPath)
				}
			case "existingSecret", "existingSecretName":
				if n := refName(child); n != "" {
					appendSecretRef(out, owner, ns, n, childPath)
				}
			case "secret":
				if m, ok := child.(map[string]any); ok {
					if sn, ok := m["secretName"].(string); ok && sn != "" {
						appendSecretRef(out, owner, ns, sn, joinRefPath(childPath, "secretName"))
					}
				}
			}
			collectSecretRefs(child, childPath, owner, ns, out)
		}
	case []any:
		for i, item := range v {
			collectSecretRefs(item, fmt.Sprintf("%s[%d]", path, i), owner, ns, out)
		}
	}
}

// refName extracts a Secret name from either a bare string or a {name: x} map.
func refName(v any) string {
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case map[string]any:
		if n, ok := t["name"].(string); ok {
			return strings.TrimSpace(n)
		}
	}
	return ""
}

func appendSecretRef(out *[]secretRef, owner Doc, ns, name, where string) {
	// Unresolved templating is not a reference we can verify.
	if name == "" || strings.Contains(name, "{{") || strings.Contains(name, "$(") {
		return
	}
	*out = append(*out, secretRef{owner: owner, ns: ns, name: name, where: strings.TrimPrefix(where, ".")})
}

func joinRefPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// -------------------------------------------------------------------------
// Rule: namespaces
// -------------------------------------------------------------------------

// ruleNamespaces verifies every Application destination namespace is created
// by the graph, by CreateNamespace=true, or by the cluster itself.
func (g *gitopsGraph) ruleNamespaces(reg *GitOpsRegistry) Check {
	start := time.Now()
	var findings []string
	system := reg.SystemNamespaceSet()
	checked := 0

	for _, app := range g.apps {
		ns := strings.TrimSpace(app.GetString("spec", "destination", "namespace"))
		if ns == "" {
			continue
		}
		checked++
		if g.namespaces[ns] || system[ns] || hasSyncOption(app, "CreateNamespace=true") {
			continue
		}
		findings = append(findings, fmt.Sprintf(
			"%s: destination namespace %q has no rendered Namespace, no CreateNamespace=true sync option and is not a system namespace",
			app.ID(), ns))
	}
	return g.result("namespaces", start, fmt.Sprintf("%d Application destination namespaces, %d rendered Namespaces", checked, len(g.namespaces)), findings)
}

func hasSyncOption(app Doc, want string) bool {
	for _, o := range app.GetStringSlice("spec", "syncPolicy", "syncOptions") {
		if strings.TrimSpace(o) == want {
			return true
		}
	}
	return false
}

// -------------------------------------------------------------------------
// Rule: ssa
// -------------------------------------------------------------------------

// ruleSSA verifies charts with oversized CRDs use server-side apply, which is
// the only way their CRDs fit inside the last-applied-configuration budget.
func (g *gitopsGraph) ruleSSA(reg *GitOpsRegistry) Check {
	start := time.Now()
	var findings []string
	huge := reg.HugeCRDChartSet()
	matched := 0

	for _, app := range g.apps {
		hit := huge[app.Name()]
		if !hit {
			for _, src := range appSources(app) {
				if huge[strings.TrimSpace(src.GetString("chart"))] {
					hit = true
					break
				}
			}
		}
		if !hit {
			continue
		}
		matched++
		if !hasSyncOption(app, "ServerSideApply=true") {
			findings = append(findings, fmt.Sprintf(
				"%s: chart has oversized CRDs and must set ServerSideApply=true in spec.syncPolicy.syncOptions", app.ID()))
		}
	}
	return g.result("ssa", start, fmt.Sprintf("%d of %d Applications require ServerSideApply", matched, len(g.apps)), findings)
}

// -------------------------------------------------------------------------
// Rule: unique-names
// -------------------------------------------------------------------------

// ruleUniqueNames verifies no two rendered Applications collide on
// namespace/name — two charts claiming the same Application would fight over
// it forever.
func (g *gitopsGraph) ruleUniqueNames() Check {
	start := time.Now()
	charts := map[string][]string{}
	var order []string
	for _, app := range g.apps {
		key := app.Namespace() + "/" + app.Name()
		if _, seen := charts[key]; !seen {
			order = append(order, key)
		}
		charts[key] = append(charts[key], app.Chart)
	}
	var findings []string
	for _, key := range order {
		if len(charts[key]) < 2 {
			continue
		}
		findings = append(findings, fmt.Sprintf(
			"Application/%s: rendered %d times, by charts %s", key, len(charts[key]), strings.Join(charts[key], ", ")))
	}
	return g.result("unique-names", start, fmt.Sprintf("%d distinct Applications", len(order)), findings)
}
