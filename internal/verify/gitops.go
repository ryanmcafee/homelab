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

// ArgoCDNamespace is where ArgoCD reads repository credentials from.
const ArgoCDNamespace = "argocd"

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
// LoadRenderDir). repoRoot is used to stat Application source paths and to
// read the env's Env.SeededSecretsDir, when it has one.
//
// It always returns exactly one Check per entry in GitOpsRules, so a caller
// can report a stable check set whether or not anything is wrong. A rule the
// env lists in Env.SkipGitOpsRules is reported as a skip with that detail.
func LintGitOps(env string, rendered map[string][]Doc, reg *GitOpsRegistry, repoRoot string) []Check {
	if reg == nil {
		reg = &GitOpsRegistry{SystemNamespaces: DefaultSystemNamespaces}
	}
	g := buildGitOpsGraph(env, rendered)
	checks := []Check{
		g.rulePaths(repoRoot),
		g.ruleWaves(),
		g.ruleCRDOrder(reg),
		g.ruleRepoSecrets(),
		g.ruleSecretRefs(reg, repoRoot),
		g.ruleNamespaces(reg),
		g.ruleSSA(reg),
		g.ruleUniqueNames(),
	}
	if e, ok := EnvByName(env); ok {
		for i, c := range checks {
			if detail, skip := e.SkipGitOpsRules[strings.TrimPrefix(c.Name, "gitops/"+env+"/")]; skip {
				checks[i] = SkipCheck(c.Name, detail)
			}
		}
	}
	return checks
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
	// spec.source.path is charts/<name>. First claim wins; pathClaims records
	// every claim so unique-names can report a contested path.
	chartOwner map[string]Doc
	// pathClaims maps a source path to every Application declaring it.
	pathClaims map[string][]Doc
	// pathOrder is pathClaims' key order, for deterministic findings.
	pathOrder  []string
	namespaces map[string]bool
}

func buildGitOpsGraph(env string, rendered map[string][]Doc) *gitopsGraph {
	g := &gitopsGraph{
		env:        env,
		rendered:   rendered,
		appByName:  map[string]Doc{},
		parentWave: map[string]int{},
		chartOwner: map[string]Doc{},
		pathClaims: map[string][]Doc{},
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
			if p == "" {
				continue
			}
			if _, seen := g.pathClaims[p]; !seen {
				g.pathOrder = append(g.pathOrder, p)
			}
			g.pathClaims[p] = append(g.pathClaims[p], app)

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

// chartInGraph reports whether this environment actually deploys the chart: a
// parent chart (an app-of-apps root's target) or a child chart some
// Application's spec.source.path points at. The renderer renders every chart
// for every environment, so a chart whose parent toggle is off still produces
// manifests that never reach a cluster. crd-order and secret-refs both skip
// those and disclose the skip, rather than judging objects that never deploy.
//
// The gitops chart is excluded: it holds the roots of the graph it defines and
// has no position inside it.
func (g *gitopsGraph) chartInGraph(chart string) bool {
	if chart == "gitops" {
		return false
	}
	if ParentCharts[chart] {
		return true
	}
	_, ok := g.chartOwner[chart]
	return ok
}

// objectKey is a rendered object's sync position. ok is false when the
// object's chart is not part of this environment's graph.
func (g *gitopsGraph) objectKey(d Doc) (orderKey, bool) {
	if !g.chartInGraph(d.Chart) {
		return orderKey{}, false
	}
	if ParentCharts[d.Chart] {
		w, _ := docWave(d)
		return orderKey{parent: g.parentWave[d.Chart], wave: w}, true
	}
	return g.appKey(g.chartOwner[d.Chart]), true
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
	// With no providers registered the rule checks nothing, so reporting a
	// pass would claim CR ordering was verified when it was not. Name the
	// file that has to be populated.
	if len(reg.CRDProviders) == 0 {
		return SkipCheck("gitops/"+g.env+"/crd-order",
			fmt.Sprintf("no CRD providers registered in %s/crd-providers.yaml; custom-resource ordering was not checked", GitOpsRegistryDir))
	}
	var findings []string
	seen := map[string]bool{}
	checked := 0
	// Objects from charts no Application in this env references have no
	// position in the sync order, so they cannot be checked. That is normal
	// (a chart whose parent toggle is off still renders) but it must be
	// visible rather than silent, so it is counted per chart and reported in
	// the check detail.
	skipped := skipTally{}

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
			skipped.add(d.Chart)
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
		provKey := g.appKey(p)
		if !provKey.less(objKey) {
			findings = append(findings, fmt.Sprintf(
				"%s: %s at (%s) must sync after provider Application %s at (%s)",
				d.ID(), d.Kind(), objKey, providerApp, provKey))
		}
	}
	detail := fmt.Sprintf("%d custom resources ordered against %d CRD providers", checked, len(reg.CRDProviders))
	detail += skipped.detail("object(s)")
	return g.result("crd-order", start, detail, findings)
}

// -------------------------------------------------------------------------
// Rule: repo-secrets
// -------------------------------------------------------------------------

// ruleRepoSecrets verifies every OCI Helm repository an Application pulls from
// has a matching ArgoCD repository Secret with enableOCI set.
//
// Scope, stated because it is narrower than issue #261 asked for: only oci://
// sources are checked. A plain http/https Helm repository needs no ArgoCD
// repository Secret — ArgoCD fetches an anonymous index.yaml, and every
// http/https repo this repository pulls from is public — so requiring a Secret
// for those would be a rule nothing could satisfy. The count of skipped
// https sources is reported in the check detail so the narrowing is visible
// in the level-0 output rather than only here. A private http/https repo
// would need credentials and is therefore NOT covered by this rule.
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
		url := secretValue(d, "url")
		if url == "" {
			continue
		}
		key := normalizeRepoURL(url)
		// A Secret in the right namespace always wins, so a stray duplicate
		// elsewhere cannot mask the real credential.
		if prev, dup := repoSecrets[key]; dup && prev.Namespace() == ArgoCDNamespace {
			continue
		}
		repoSecrets[key] = d
	}

	ociRepos := 0
	// httpRepos counts the distinct public http/https chart repositories this
	// rule deliberately does not check, so the detail can disclose it.
	httpRepos := map[string]bool{}
	reported := map[string]bool{}
	for _, app := range g.apps {
		for _, src := range appSources(app) {
			if strings.TrimSpace(src.GetString("chart")) == "" {
				continue
			}
			repo := strings.TrimSpace(src.GetString("repoURL"))
			if repo == "" {
				continue
			}
			if isHTTPRepo(repo) {
				httpRepos[normalizeRepoURL(repo)] = true
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
			report := func(msg string) {
				if !reported[msg] {
					reported[msg] = true
					findings = append(findings, msg)
				}
			}
			if secretValue(sec, "enableOCI") != "true" {
				report(fmt.Sprintf("%s: repository Secret for %q must set enableOCI: \"true\"", sec.ID(), repo))
			}
			// ArgoCD only reads repository credentials from its own namespace.
			if sec.Namespace() != ArgoCDNamespace {
				report(fmt.Sprintf("%s: repository Secret for %q must live in the %s namespace, not %q",
					sec.ID(), repo, ArgoCDNamespace, sec.Namespace()))
			}
		}
	}
	detail := fmt.Sprintf("%d OCI chart sources, %d repository Secrets", ociRepos, len(repoSecrets))
	if n := len(httpRepos); n > 0 {
		detail += fmt.Sprintf("; %d https %s not checked (public Helm repos need no Secret)",
			n, plural(n, "repository", "repositories"))
	}
	return g.result("repo-secrets", start, detail, findings)
}

// plural picks the singular or plural word for n.
func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
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
//
// The rule deliberately also asserts producer validity — an OnePasswordItem
// with an empty spec.itemPath is reported, not counted — because a producer
// that cannot produce is indistinguishable from a missing one at sync time,
// and this is the only rule that looks at secret wiring at all.
//
// An env with Env.SeededSecretsDir (localdev) also counts the core Secrets in
// that directory's YAML files as producers: they are applied to the cluster
// outside ArgoCD, so a render that references one really finds it. repoRoot
// locates that directory.
func (g *gitopsGraph) ruleSecretRefs(reg *GitOpsRegistry, repoRoot string) Check {
	start := time.Now()

	var findings []string
	reported := map[string]bool{}
	report := func(msg string) {
		if !reported[msg] {
			reported[msg] = true
			findings = append(findings, msg)
		}
	}

	// Charts this environment does not deploy are skipped on both sides of the
	// rule: their objects consume nothing and produce nothing here.
	skipped := skipTally{}

	producers := map[string]bool{}
	produce := func(ns, name string) {
		if ns != "" && name != "" {
			producers[ns+"/"+name] = true
		}
	}

	// Secrets seeded outside ArgoCD are kept apart from rendered producers
	// so the detail can disclose each count.
	seededDir := ""
	if e, ok := EnvByName(g.env); ok {
		seededDir = e.SeededSecretsDir
	}
	seeded := map[string]bool{}
	if seededDir != "" {
		docs, err := loadSeededDocs(repoRoot, seededDir)
		if err != nil {
			report(fmt.Sprintf("%s: %v", seededDir, err))
		}
		for _, d := range docs {
			if d.Kind() == "Secret" && d.Group() == "" && d.Namespace() != "" && d.Name() != "" {
				seeded[d.Namespace()+"/"+d.Name()] = true
			}
		}
	}

	for _, d := range g.docs {
		if !g.chartInGraph(d.Chart) {
			continue
		}
		ns := g.destNamespace(d)
		switch {
		case d.Kind() == "Secret" && d.Group() == "":
			produce(ns, d.Name())
		case d.Kind() == "OnePasswordItem":
			// An OnePasswordItem with no itemPath renders but is inert: the
			// operator has nothing to fetch, so no Secret ever appears while
			// the manifest still reads like a working producer.
			if strings.TrimSpace(d.GetString("spec", "itemPath")) == "" {
				report(fmt.Sprintf("%s: empty spec.itemPath — will never produce a Secret", d.ID()))
				continue
			}
			produce(ns, d.Name())
		case d.Kind() == "Certificate" && d.Group() == "cert-manager.io":
			produce(ns, d.GetString("spec", "secretName"))
		case d.Kind() == "ExternalSecret" || d.Kind() == "SealedSecret":
			// Both materialise a Secret of the same name.
			produce(ns, d.Name())
		}
	}

	c := secretRefCollector{reg: reg}
	for _, d := range g.docs {
		if isApplication(d) {
			// An Application's own object holds no Secret references; the
			// workload references live in its Helm values and land in the
			// Application's destination namespace, not in argocd.
			ns := d.GetString("spec", "destination", "namespace")
			for _, src := range appSources(d) {
				if vo, ok := src.Get("helm", "valuesObject"); ok {
					c.walk(vo, "spec.source.helm.valuesObject", d, ns)
				}
				if raw := src.GetString("helm", "values"); strings.TrimSpace(raw) != "" {
					var parsed any
					if err := yaml.Unmarshal([]byte(raw), &parsed); err == nil {
						c.walk(parsed, "spec.source.helm.values", d, ns)
					}
				}
			}
			continue
		}
		c.walk(d.Object, "", d, g.destNamespace(d))
	}

	checked := 0
	for _, r := range c.refs {
		if !g.chartInGraph(r.owner.Chart) {
			skipped.add(r.owner.Chart)
			continue
		}
		checked++
		if r.ns == "" {
			// The chart does deploy, but nothing says where: a cluster-scoped
			// object, or an Application with no spec.destination.namespace.
			// This one is a real gap, so it fails rather than being skipped.
			report(fmt.Sprintf(
				"%s: cannot resolve a namespace for the Secret reference %q at %s (the chart deploys but declares no destination namespace)",
				r.owner.ID(), r.name, r.where))
			continue
		}
		if producers[r.ns+"/"+r.name] || seeded[r.ns+"/"+r.name] || reg.KnownSecret(r.ns, r.name) {
			continue
		}
		hint := fmt.Sprintf("register it in %s/known-secrets.yaml if it is created outside the rendered charts", GitOpsRegistryDir)
		if seededDir != "" {
			hint += fmt.Sprintf(", or seed it in %s/ for %s", seededDir, g.env)
		}
		report(fmt.Sprintf(
			"%s: references Secret %s/%s at %s, which no rendered Secret, OnePasswordItem or Certificate produces (%s)",
			r.owner.ID(), r.ns, r.name, r.where, hint))
	}

	detail := fmt.Sprintf("%d secret references, %d rendered producers", checked, len(producers))
	if seededDir != "" {
		detail += fmt.Sprintf(", %d seeded by %s", len(seeded), seededDir)
	}
	detail += skipped.detail("reference(s)")
	return g.result("secret-refs", start, detail, findings)
}

// loadSeededDocs parses every *.yaml file directly under <repoRoot>/<dir>
// (multi-document). A missing directory yields no docs and no error: test
// repo layouts and fresh checkouts need not have one. A file that fails to
// parse is an error, because a broken seed file silently un-produces every
// Secret in it.
func loadSeededDocs(repoRoot, dir string) ([]Doc, error) {
	abs := filepath.Join(repoRoot, filepath.FromSlash(dir))
	entries, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var docs []Doc
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".yaml") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(abs, e.Name()))
		if err != nil {
			return docs, err
		}
		parsed, err := ParseMultiDoc(e.Name(), "", data)
		if err != nil {
			return docs, err
		}
		docs = append(docs, parsed...)
	}
	return docs, nil
}

// skipTally counts objects skipped per chart so a rule can disclose what it
// did not look at.
type skipTally struct {
	counts map[string]int
	order  []string
}

func (s *skipTally) add(chart string) {
	if s.counts == nil {
		s.counts = map[string]int{}
	}
	if _, seen := s.counts[chart]; !seen {
		s.order = append(s.order, chart)
	}
	s.counts[chart]++
}

// detail renders the "; skipped N <unit> from charts no Application
// references: a, b" suffix, or "" when nothing was skipped.
func (s *skipTally) detail(unit string) string {
	if len(s.order) == 0 {
		return ""
	}
	charts := append([]string(nil), s.order...)
	sort.Strings(charts)
	total := 0
	for _, c := range charts {
		total += s.counts[c]
	}
	return fmt.Sprintf("; skipped %d %s from charts no Application references: %s",
		total, unit, strings.Join(charts, ", "))
}

// secretRefCollector walks decoded manifest subtrees and accumulates every
// consumer reference to a Secret. Ingress-style tls[].secretName is
// deliberately not collected: cert-manager creates those on demand.
type secretRefCollector struct {
	reg  *GitOpsRegistry
	refs []secretRef
}

func (c *secretRefCollector) walk(node any, path string, owner Doc, ns string) {
	switch v := node.(type) {
	case map[string]any:
		for _, key := range sortedKeys(v) {
			child := v[key]
			childPath := joinRefPath(path, key)
			switch {
			case c.isSecretRefKey(key), key == "existingSecret", key == "existingSecretName":
				if n := refName(child); n != "" {
					c.add(owner, ns, n, childPath)
				}
			case key == "secret":
				if m, ok := child.(map[string]any); ok {
					if sn, ok := m["secretName"].(string); ok && sn != "" {
						c.add(owner, ns, sn, joinRefPath(childPath, "secretName"))
					}
				}
			}
			c.walk(child, childPath, owner, ns)
		}
	case []any:
		for i, item := range v {
			c.walk(item, fmt.Sprintf("%s[%d]", path, i), owner, ns)
		}
	}
}

// isSecretRefKey reports whether a map key names a Secret the object reads.
// Kubernetes and its operators spell this a dozen ways — secretRef,
// secretKeyRef, apiTokenSecretRef, tokenSecretRef — so anything ending in
// SecretRef counts, minus the output keys the registry declares.
func (c *secretRefCollector) isSecretRefKey(key string) bool {
	if c.reg != nil && c.reg.IsOutputRefKey(key) {
		return false
	}
	return key == "secretRef" || key == "secretKeyRef" || strings.HasSuffix(key, "SecretRef")
}

func (c *secretRefCollector) add(owner Doc, ns, name, where string) {
	// Unresolved templating is not a reference we can verify.
	if name == "" || strings.Contains(name, "{{") || strings.Contains(name, "$(") {
		return
	}
	c.refs = append(c.refs, secretRef{owner: owner, ns: ns, name: name, where: strings.TrimPrefix(where, ".")})
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

func joinRefPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
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
	// An empty list means the rule matched nothing by construction, which is
	// not the same as every Application being correct.
	if len(reg.HugeCRDCharts) == 0 {
		return SkipCheck("gitops/"+g.env+"/ssa",
			fmt.Sprintf("no charts registered in %s/huge-crd-charts.yaml; ServerSideApply was not checked", GitOpsRegistryDir))
	}
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
// it forever — and that no two Applications claim the same source path, which
// would make chart ownership, and therefore every ordering key derived from
// it, ambiguous.
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

	for _, path := range g.pathOrder {
		claims := g.pathClaims[path]
		if len(claims) < 2 {
			continue
		}
		others := make([]string, 0, len(claims)-1)
		for _, a := range claims[1:] {
			others = append(others, a.Name())
		}
		sort.Strings(others)
		findings = append(findings, fmt.Sprintf(
			"Application/%s/%s: source path %q is also claimed by %s, so chart ownership is ambiguous",
			claims[0].Namespace(), claims[0].Name(), path, strings.Join(others, ", ")))
	}

	detail := fmt.Sprintf("%d distinct Applications, %d distinct source paths", len(order), len(g.pathOrder))
	return g.result("unique-names", start, detail, findings)
}
