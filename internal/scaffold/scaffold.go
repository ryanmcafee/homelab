// Package scaffold generates a new app in one of the repository's three
// ArgoCD Application patterns (issue #261 item 21):
//
//	operator          one Application for an upstream operator chart that installs
//	                  CRDs (reference: cloudnative-pg); registers the CRD group,
//	                  vendors-to-be schema source and health Lua for its kinds
//	helm              one Application for an upstream chart with an Ingress and a
//	                  PostSync smoke hook, no -config child (reference: sonarr)
//	deps-main-config  <name>-dependencies < <name> < <name>-config, children fed
//	                  through helm.valuesObject (reference: traefik-external, ADR-010)
//
// Build computes every file it would create or change as a Plan (nothing is
// written); Plan.Diff renders it as a git-style patch for --dry-run, Plan.Apply
// writes it, and Regenerate rewrites what those sources feed: the committed
// localdev values (ADR-011) and the golden snapshots of the touched charts.
package scaffold

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"text/template"

	"gopkg.in/yaml.v3"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/verify"
)

//go:embed templates
var templatesFS embed.FS

// Patterns.
const (
	PatternOperator       = "operator"
	PatternHelm           = "helm"
	PatternDepsMainConfig = "deps-main-config"
)

// Tiers are the parent charts an app can live in.
const (
	TierAddons       = "addons"
	TierApplications = "applications"
)

// Patterns lists the supported patterns in help order.
var Patterns = []string{PatternOperator, PatternHelm, PatternDepsMainConfig}

// Tiers lists the supported tiers.
var Tiers = []string{TierAddons, TierApplications}

// tierExport is the config export template that generates a tier's values.
var tierExport = map[string]string{TierAddons: "helm-addons.tmpl", TierApplications: "helm-apps.tmpl"}

// tierSchema is where a tier's derived hostname keys are declared.
var tierSchema = map[string]string{TierAddons: "network.schema.yaml", TierApplications: "applications.schema.yaml"}

// defaultWave is the main Application's sync wave per tier: after the
// operators and ingress controllers in addons (cloudnative-pg is 10), next to
// the media apps in applications (sonarr is 13).
var defaultWave = map[string]int{TierAddons: 10, TierApplications: 13}

// MaxNameLen keeps <name>-dependencies (the longest derived Application,
// chart and namespace-scoped object name) inside a 63-character DNS label.
const MaxNameLen = 63 - len("-dependencies")

// reservedNames collide with parent charts or with the parents' own values keys.
var reservedNames = map[string]bool{
	"gitops": true, "bootstrap": true, "addons": true, "applications": true,
	"secrets": true, "global": true,
}

// traefikGateway is the in-cluster Service the e2e curl Job connects through
// for the internal IngressClass (tests/e2e/README.md).
const traefikGateway = "traefik-internal.traefik.svc.cluster.local"

// trueChartsRepo is the TrueCharts OCI registry as ArgoCD spells it.
const trueChartsRepo = "oci.trueforge.org/truecharts"

var (
	dnsLabelRe   = regexp.MustCompile(`^[a-z]([-a-z0-9]*[a-z0-9])?$`)
	nsRe         = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	chartNameRe  = regexp.MustCompile(`^[a-z0-9]([-a-z0-9._]*[a-z0-9])?$`)
	versionRe    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_-]*$`)
	groupRe      = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$`)
	kindRe       = regexp.MustCompile(`^[A-Z][A-Za-z0-9]*$`)
	expectRe     = regexp.MustCompile(`^[1-5][0-9][0-9]$`)
	healthPathRe = regexp.MustCompile(`^/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$`)
	repoRe       = regexp.MustCompile(`^(https?|oci)://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~%/-]*)?$`)
)

// Options are the scaffolder inputs. Zero values take the documented defaults
// (see Normalize).
type Options struct {
	// RepoRoot is the repository root (the directory holding Taskfile.yml).
	RepoRoot string
	// Name is the app name: a DNS label, the Application name, the values key
	// and the configuration/versions.yaml charts key.
	Name string
	// Pattern is operator, helm or deps-main-config.
	Pattern string
	// Tier is addons or applications (default: addons, applications for helm).
	Tier string
	// Namespace is the destination namespace (default: Name).
	Namespace string
	// ChartRepo is the upstream Helm repository: https://... or oci://<registry path>
	// (without the chart name).
	ChartRepo string
	// ChartName defaults to Name.
	ChartName string
	// ChartVersion is written to configuration/versions.yaml.
	ChartVersion string
	// Port is the Service port the smoke hook and the -config Ingress use
	// (default 80; 0 for operator, which disables the smoke hook).
	Port *int
	// Wave is the main Application's sync wave (default 10 in addons, 13 in
	// applications); -dependencies is Wave-1, -config is Wave+2.
	Wave *int
	// HealthPath is the unauthenticated path the smoke hook and e2e test hit.
	HealthPath string
	// Expect lists the accepted HTTP codes (default 200).
	Expect []string
	// CRDGroup is the API group the chart installs CRDs for (required for operator).
	CRDGroup string
	// CRDKinds are the kinds of CRDGroup to vendor schemas and health Lua for.
	CRDKinds []string
	// HugeCRDs registers the chart in tests/gitops/huge-crd-charts.yaml.
	HugeCRDs bool
	// PreviewAware: the tier is applications, whose templates must go through
	// the homelab.preview.* helpers (charts/applications/templates/_preview.tpl).
	PreviewAware bool
	// Tier-specific Helm expressions used by the shared mainApp partial.
	AppNameExpr, AppNamespaceExpr, ProjectExpr, DestNSExpr string
	ValuesExpr, ValuesBody, SmokeNSExpr, SmokeExpr         string
}

// InputError is a problem with the caller's input (a bad flag value, a name
// that already exists). The command maps it to exit code 2.
type InputError struct{ Err error }

func (e *InputError) Error() string { return e.Err.Error() }
func (e *InputError) Unwrap() error { return e.Err }

func inputErrorf(format string, args ...any) error {
	return &InputError{Err: fmt.Errorf(format, args...)}
}

// IsInputError reports whether err (or anything it wraps) is an InputError.
func IsInputError(err error) bool {
	var ie *InputError
	return errors.As(err, &ie)
}

// Change is one file the scaffold creates (Old == nil) or modifies.
type Change struct {
	// Path is repo-relative and slash-separated.
	Path string
	Old  []byte
	New  []byte
}

// Created reports whether the change creates the file.
func (c Change) Created() bool { return c.Old == nil }

// Plan is everything a scaffold run would write, computed without writing.
type Plan struct {
	// Options are the normalized inputs.
	Options Options
	// Changes are sorted by path.
	Changes []Change
	// SnapshotCharts are the charts whose golden snapshots the change alters
	// (the tier parent, new child charts, bootstrap for new health Lua).
	SnapshotCharts []string
	// Notes are warnings about things the scaffold could not do itself.
	Notes []string
}

// Normalize fills defaults and validates every input that does not depend on
// the repository state. It returns an *InputError on bad input.
func (o *Options) Normalize() error {
	o.Name = strings.TrimSpace(o.Name)
	switch {
	case o.Name == "":
		return inputErrorf("an app name is required")
	case !dnsLabelRe.MatchString(o.Name):
		return inputErrorf("app name %q must be a DNS label: lowercase letters, digits and '-', starting with a letter and ending with a letter or digit", o.Name)
	case len(o.Name) > MaxNameLen:
		return inputErrorf("app name %q is %d characters; at most %d keep %s-dependencies a valid DNS label", o.Name, len(o.Name), MaxNameLen, o.Name)
	case strings.HasSuffix(o.Name, "-config") || strings.HasSuffix(o.Name, "-dependencies"):
		return inputErrorf("app name %q must not end in -config or -dependencies (those suffixes mark child charts)", o.Name)
	case reservedNames[o.Name]:
		return inputErrorf("app name %q is reserved (parent chart or values key)", o.Name)
	}

	if !contains(Patterns, o.Pattern) {
		return inputErrorf("--pattern must be one of %s (got %q)", strings.Join(Patterns, ", "), o.Pattern)
	}
	if o.Tier == "" {
		o.Tier = TierAddons
		if o.Pattern == PatternHelm {
			o.Tier = TierApplications
		}
	}
	if !contains(Tiers, o.Tier) {
		return inputErrorf("--tier must be one of %s (got %q)", strings.Join(Tiers, ", "), o.Tier)
	}

	if o.Namespace == "" {
		o.Namespace = o.Name
	}
	if !nsRe.MatchString(o.Namespace) || len(o.Namespace) > 63 {
		return inputErrorf("--namespace %q must be a DNS label", o.Namespace)
	}

	o.ChartRepo = strings.TrimRight(strings.TrimSpace(o.ChartRepo), "/")
	if o.ChartRepo == "" {
		return inputErrorf("--chart-repo is required (https://... Helm repository or oci://<registry path>)")
	}
	if !repoRe.MatchString(o.ChartRepo) {
		return inputErrorf("--chart-repo %q must be an https://, http:// or oci:// URL", o.ChartRepo)
	}
	if o.ChartName == "" {
		o.ChartName = o.Name
	}
	if !chartNameRe.MatchString(o.ChartName) {
		return inputErrorf("--chart-name %q is not a valid chart name", o.ChartName)
	}
	if strings.HasPrefix(o.ChartRepo, "oci://") && strings.HasSuffix(o.ChartRepo, "/"+o.ChartName) {
		return inputErrorf("--chart-repo %q must name the registry path without the chart (%s)", o.ChartRepo, strings.TrimSuffix(o.ChartRepo, "/"+o.ChartName))
	}
	o.ChartVersion = strings.TrimSpace(o.ChartVersion)
	if o.ChartVersion == "" {
		return inputErrorf("--chart-version is required (it becomes configuration/versions.yaml charts.%s)", o.Name)
	}
	if !versionRe.MatchString(o.ChartVersion) {
		return inputErrorf("--chart-version %q may contain only letters, digits and . + _ -", o.ChartVersion)
	}

	if o.Port == nil {
		p := 80
		if o.Pattern == PatternOperator {
			p = 0
		}
		o.Port = &p
	}
	switch {
	case *o.Port < 0 || *o.Port > 65535:
		return inputErrorf("--port %d is out of range", *o.Port)
	case *o.Port == 0 && o.Pattern != PatternOperator:
		return inputErrorf("--port is required for the %s pattern (the smoke hook and Ingress target it)", o.Pattern)
	}
	if o.Wave == nil {
		w := defaultWave[o.Tier]
		o.Wave = &w
	}
	if *o.Wave < -50 || *o.Wave > 100 {
		return inputErrorf("--wave %d is outside -50..100", *o.Wave)
	}

	if o.HealthPath == "" {
		o.HealthPath = "/"
	}
	if !healthPathRe.MatchString(o.HealthPath) {
		return inputErrorf("--health-path %q must be an absolute URL path", o.HealthPath)
	}
	if len(o.Expect) == 0 {
		o.Expect = []string{"200"}
	}
	for _, e := range o.Expect {
		if !expectRe.MatchString(e) {
			return inputErrorf("--expect %q is not an HTTP status code", e)
		}
	}

	o.CRDKinds = dedupe(o.CRDKinds)
	switch {
	case o.CRDGroup == "" && len(o.CRDKinds) > 0:
		return inputErrorf("--crd-kinds needs --crd-group")
	case o.CRDGroup != "" && len(o.CRDKinds) == 0:
		return inputErrorf("--crd-group needs --crd-kinds (the kinds to vendor schemas and health checks for)")
	case o.Pattern == PatternOperator && o.CRDGroup == "":
		return inputErrorf("the operator pattern needs --crd-group and --crd-kinds")
	}
	if o.CRDGroup != "" && !groupRe.MatchString(o.CRDGroup) {
		return inputErrorf("--crd-group %q must be a DNS subdomain such as example.com", o.CRDGroup)
	}
	for _, k := range o.CRDKinds {
		if !kindRe.MatchString(k) {
			return inputErrorf("--crd-kinds entry %q must be a Kind such as Cluster", k)
		}
	}
	return nil
}

// tmplData feeds every template.
type tmplData struct {
	Name, EnvKey, HostnameKey        string
	Pattern, PatternTitle, Tier      string
	ExportFile, Command              string
	Namespace                        string
	CreateNamespace, RepoSecret      bool
	ChartRepo, RepoURL               string
	ChartName, ChartVersion          string
	OCI, TrueCharts                  bool
	RenovateMarker                   string
	Port                             int
	HealthPath                       string
	Expect                           []string
	Smoke                            bool
	SmokeURL                         string
	Ingress                          bool
	LocaldevHost, Gateway, CurlImage string
	Wave, DepsWave, ConfigWave       int
	CRDGroup                         string
	CRDKinds                         []string
	AppNames                         []string
	DocRows                          []docRow
	HugeCRDs                         bool
	// PreviewAware: the tier is applications, whose templates must go through
	// the homelab.preview.* helpers (charts/applications/templates/_preview.tpl).
	PreviewAware bool
	// Tier-specific Helm expressions emitted by the shared mainApp partial.
	AppNameExpr, AppNamespaceExpr, ProjectExpr, DestNSExpr string
	ValuesExpr, ValuesBody, SmokeNSExpr, SmokeExpr         string
}

type docRow struct{ Path, Purpose string }

// healthData feeds the health Lua and its fixtures.
type healthData struct{ App, Group, Kind, Version, Namespace string }

var funcs = template.FuncMap{
	// flowList renders ["200", "401"].
	"flowList": func(xs []string) string {
		q := make([]string, len(xs))
		for i, x := range xs {
			q[i] = strconv.Quote(x)
		}
		return "[" + strings.Join(q, ", ") + "]"
	},
	// flowListBare renders [Widget, Gadget].
	"flowListBare": func(xs []string) string { return "[" + strings.Join(xs, ", ") + "]" },
	"join":         strings.Join,
}

// sharedPartials are parsed alongside every template file.
var sharedPartials = []string{"templates/common/partials.tmpl", "templates/common/entries.tmpl"}

// execFile renders one embedded template file.
func execFile(path string, data any) (string, error) {
	t, err := template.New("").Delims("[[", "]]").Funcs(funcs).Option("missingkey=error").
		ParseFS(templatesFS, append(append([]string{}, sharedPartials...), path)...)
	if err != nil {
		return "", fmt.Errorf("parsing %s: %w", path, err)
	}
	var buf bytes.Buffer
	if err := t.ExecuteTemplate(&buf, filepath.Base(path), data); err != nil {
		return "", fmt.Errorf("rendering %s: %w", path, err)
	}
	return buf.String(), nil
}

// execDefine renders one {{define}} block from the shared partials.
func execDefine(name string, data any) (string, error) {
	t, err := template.New("").Delims("[[", "]]").Funcs(funcs).Option("missingkey=error").
		ParseFS(templatesFS, sharedPartials...)
	if err != nil {
		return "", fmt.Errorf("parsing partials: %w", err)
	}
	var buf bytes.Buffer
	if err := t.ExecuteTemplate(&buf, name, data); err != nil {
		return "", fmt.Errorf("rendering %s: %w", name, err)
	}
	return buf.String(), nil
}

// Build validates the options against the repository and computes the Plan.
// Nothing is written.
func Build(o Options) (*Plan, error) {
	if err := o.Normalize(); err != nil {
		return nil, err
	}
	if o.RepoRoot == "" {
		return nil, fmt.Errorf("repository root is required")
	}
	r := &repo{root: o.RepoRoot, files: map[string][]byte{}, orig: map[string][]byte{}}
	if err := r.checkAbsent(o); err != nil {
		return nil, err
	}
	d, err := r.templateData(o)
	if err != nil {
		return nil, err
	}

	plan := &Plan{Options: o}
	create := func(path, tmpl string, data any) error {
		out, err := execFile(tmpl, data)
		if err != nil {
			return err
		}
		return r.create(path, out)
	}

	// 1. Application template(s) in the tier parent.
	appPath := fmt.Sprintf("charts/%s/templates/%s.yaml", o.Tier, o.Name)
	if err := create(appPath, "templates/"+o.Pattern+"/application.yaml.tmpl", d); err != nil {
		return nil, err
	}

	// 2. Placeholder values block in the tier parent.
	valuesPath := fmt.Sprintf("charts/%s/values.yaml", o.Tier)
	block, err := execFile("templates/common/values-block.yaml.tmpl", d)
	if err != nil {
		return nil, err
	}
	if err := r.edit(valuesPath, func(b []byte) ([]byte, error) { return appendBlock(b, block), nil }); err != nil {
		return nil, err
	}

	// 3. Export-template block: the real values for every environment.
	exportPath := "configuration/templates/" + d.ExportFile
	block, err = execFile("templates/"+o.Pattern+"/export.tmpl", d)
	if err != nil {
		return nil, err
	}
	if err := r.edit(exportPath, func(b []byte) ([]byte, error) { return appendBlock(b, block), nil }); err != nil {
		return nil, err
	}

	// 4. Version pin with its Renovate marker.
	entry, err := execDefine("versionsEntry", d)
	if err != nil {
		return nil, err
	}
	if err := r.edit("configuration/versions.yaml", func(b []byte) ([]byte, error) {
		return insertAtEndOfBlock(b, "charts", entry, false)
	}); err != nil {
		return nil, err
	}

	// 5. Hostname schema key for apps with an Ingress.
	if d.Ingress {
		key, err := execDefine("schemaKey", d)
		if err != nil {
			return nil, err
		}
		if err := r.edit("configuration/schema/"+tierSchema[o.Tier], func(b []byte) ([]byte, error) {
			return insertAtEndOfBlock(b, "keys", key, true)
		}); err != nil {
			return nil, err
		}
	}

	// 6. Child charts of deps-main-config.
	if o.Pattern == PatternDepsMainConfig {
		for _, child := range []string{"dependencies", "config"} {
			files := []string{"Chart.yaml", "values.yaml", "values-homelab.yaml", "values-localdev.yaml"}
			if child == "dependencies" {
				files = append(files, "templates/secrets.yaml")
			} else {
				files = append(files, "templates/ingress.yaml")
			}
			for _, f := range files {
				dest := fmt.Sprintf("charts/%s-%s/%s", o.Name, child, f)
				if err := create(dest, fmt.Sprintf("templates/%s/%s/%s.tmpl", o.Pattern, child, f), d); err != nil {
					return nil, err
				}
			}
		}
	}

	// 7. Operator registries: CRD provider, schema source, health Lua + fixtures.
	if o.CRDGroup != "" {
		prov, err := execDefine("crdProvider", d)
		if err != nil {
			return nil, err
		}
		if err := r.edit("tests/gitops/crd-providers.yaml", func(b []byte) ([]byte, error) {
			return insertAtEndOfBlock(b, "providers", prov, false)
		}); err != nil {
			return nil, err
		}
		src, err := execDefine("schemaSource", d)
		if err != nil {
			return nil, err
		}
		if err := r.edit("tests/schemas/sources.yaml", func(b []byte) ([]byte, error) {
			return insertAtEndOfBlock(b, "sources", src, true)
		}); err != nil {
			return nil, err
		}
		for _, kind := range o.CRDKinds {
			hd := healthData{App: o.Name, Group: o.CRDGroup, Kind: kind, Version: "v1", Namespace: o.Namespace}
			stem := o.CRDGroup + "_" + kind
			if err := create("charts/bootstrap/files/health/"+stem+".lua", "templates/common/health.lua.tmpl", hd); err != nil {
				return nil, err
			}
			for _, fx := range []string{"healthy", "progressing", "degraded"} {
				if err := create(fmt.Sprintf("tests/health/%s/%s.yaml", stem, fx), "templates/common/health-"+fx+".yaml.tmpl", hd); err != nil {
					return nil, err
				}
			}
		}
	}
	if o.HugeCRDs {
		if err := r.edit("tests/gitops/huge-crd-charts.yaml", func(b []byte) ([]byte, error) {
			return insertSortedListItem(b, "charts", o.Name)
		}); err != nil {
			return nil, err
		}
	}

	// 8. TrueCharts apps join the weekend Renovate group.
	if d.TrueCharts {
		pkg, err := execDefine("renovatePackage", d)
		if err != nil {
			return nil, err
		}
		if err := r.edit(".github/renovate.json5", func(b []byte) ([]byte, error) {
			out, ok := insertRenovatePackage(b, "TrueCharts applications", strings.TrimSpace(pkg))
			if !ok {
				plan.Notes = append(plan.Notes, fmt.Sprintf(
					"could not find the 'TrueCharts applications' matchPackageNames list in .github/renovate.json5; add %s by hand", strings.TrimSpace(pkg)))
			}
			return out, nil
		}); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}

	// 9. e2e test and doc stub (the doc lists every other change, so it goes last).
	if err := create(fmt.Sprintf("tests/e2e/%s/chainsaw-test.yaml", o.Name), "templates/common/e2e.yaml.tmpl", d); err != nil {
		return nil, err
	}
	docPath := fmt.Sprintf("docs/apps/%s.md", o.Name)
	d.DocRows = docRows(r.paths(), r.orig, docPath, d)
	if err := create(docPath, "templates/common/doc.md.tmpl", d); err != nil {
		return nil, err
	}

	for _, p := range r.paths() {
		plan.Changes = append(plan.Changes, Change{Path: p, Old: r.orig[p], New: r.files[p]})
	}
	plan.SnapshotCharts = []string{o.Tier}
	if o.Pattern == PatternDepsMainConfig {
		plan.SnapshotCharts = append(plan.SnapshotCharts, o.Name+"-config", o.Name+"-dependencies")
	}
	if len(o.CRDKinds) > 0 {
		plan.SnapshotCharts = append(plan.SnapshotCharts, "bootstrap")
	}
	sort.Strings(plan.SnapshotCharts)
	return plan, nil
}

// docRows describes every changed file for the doc stub's table.
func docRows(paths []string, orig map[string][]byte, docPath string, d *tmplData) []docRow {
	purpose := func(p string) string {
		switch {
		case strings.HasPrefix(p, "charts/"+d.Tier+"/templates/"):
			return fmt.Sprintf("ArgoCD Application(s): %s", strings.Join(d.AppNames, ", "))
		case p == "charts/"+d.Tier+"/values.yaml":
			return "placeholder values block"
		case strings.HasPrefix(p, "configuration/templates/"):
			return "values for every environment (version, sizing, hostname, smoke URL)"
		case p == "configuration/versions.yaml":
			return "chart version with its Renovate marker"
		case strings.HasPrefix(p, "configuration/schema/"):
			return "`" + d.HostnameKey + "` hostname key"
		case strings.HasPrefix(p, "charts/"+d.Name+"-dependencies/"):
			return "dependencies child chart (wave " + strconv.Itoa(d.DepsWave) + ")"
		case strings.HasPrefix(p, "charts/"+d.Name+"-config/"):
			return "config child chart (wave " + strconv.Itoa(d.ConfigWave) + ")"
		case p == "tests/gitops/crd-providers.yaml":
			return "CRD provider for " + d.CRDGroup
		case p == "tests/gitops/huge-crd-charts.yaml":
			return "requires ServerSideApply (oversized CRDs)"
		case p == "tests/schemas/sources.yaml":
			return "CRD schema source (`task schemas:vendor`)"
		case strings.HasPrefix(p, "charts/bootstrap/files/health/"):
			return "ArgoCD health Lua"
		case strings.HasPrefix(p, "tests/health/"):
			return "health Lua fixtures"
		case p == ".github/renovate.json5":
			return "TrueCharts Renovate group"
		case strings.HasPrefix(p, "tests/e2e/"):
			return "chainsaw e2e test"
		}
		return ""
	}
	var rows []docRow
	seenChild := map[string]bool{}
	for _, p := range paths {
		if p == docPath {
			continue
		}
		// One row per child chart and per health fixture directory.
		shown := p
		for _, dir := range []string{"charts/" + d.Name + "-dependencies/", "charts/" + d.Name + "-config/"} {
			if strings.HasPrefix(p, dir) {
				shown = dir
			}
		}
		if strings.HasPrefix(p, "tests/health/") {
			shown = filepath.ToSlash(filepath.Dir(p)) + "/"
		}
		if seenChild[shown] {
			continue
		}
		seenChild[shown] = true
		rows = append(rows, docRow{Path: shown, Purpose: purpose(p)})
	}
	return rows
}

// repo is the in-memory working set of a Build.
type repo struct {
	root string
	// files holds the planned content; orig the on-disk content (nil for new files).
	files map[string][]byte
	orig  map[string][]byte
}

func (r *repo) abs(p string) string { return filepath.Join(r.root, filepath.FromSlash(p)) }

func (r *repo) exists(p string) bool {
	_, err := os.Stat(r.abs(p))
	return err == nil
}

// create plans a new file. It refuses to overwrite an existing one.
func (r *repo) create(p, content string) error {
	if r.exists(p) {
		return inputErrorf("%s already exists", p)
	}
	if _, dup := r.files[p]; dup {
		return fmt.Errorf("internal error: %s planned twice", p)
	}
	r.files[p] = []byte(content)
	r.orig[p] = nil
	return nil
}

// edit plans a modification of an existing file, applied to the planned
// content when the file was already edited.
func (r *repo) edit(p string, fn func([]byte) ([]byte, error)) error {
	cur, planned := r.files[p]
	if !planned {
		b, err := os.ReadFile(r.abs(p))
		if err != nil {
			return fmt.Errorf("reading %s: %w", p, err)
		}
		cur = b
		r.orig[p] = b
	}
	out, err := fn(cur)
	if err != nil {
		return fmt.Errorf("editing %s: %w", p, err)
	}
	r.files[p] = out
	return nil
}

func (r *repo) paths() []string {
	out := make([]string, 0, len(r.files))
	for p := range r.files {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// checkAbsent refuses a name (or CRD group, kind, hostname key) that the
// repository already uses anywhere the scaffold would write it.
func (r *repo) checkAbsent(o Options) error {
	for _, tier := range Tiers {
		if r.exists(fmt.Sprintf("charts/%s/templates/%s.yaml", tier, o.Name)) {
			return inputErrorf("app %q already exists: charts/%s/templates/%s.yaml", o.Name, tier, o.Name)
		}
		keys, err := yamlTopKeys(r.abs(fmt.Sprintf("charts/%s/values.yaml", tier)))
		if err != nil {
			return err
		}
		if keys[o.Name] {
			return inputErrorf("app %q already exists: top-level key in charts/%s/values.yaml", o.Name, tier)
		}
		tmpl, err := os.ReadFile(r.abs("configuration/templates/" + tierExport[tier]))
		if err != nil {
			return fmt.Errorf("reading export template: %w", err)
		}
		if regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(o.Name) + `:`).Match(tmpl) {
			return inputErrorf("app %q already exists: top-level key in configuration/templates/%s", o.Name, tierExport[tier])
		}
	}
	for _, dir := range []string{"charts/" + o.Name, "charts/" + o.Name + "-config", "charts/" + o.Name + "-dependencies", "tests/e2e/" + o.Name, "docs/apps/" + o.Name + ".md"} {
		if r.exists(dir) {
			return inputErrorf("app %q already exists: %s", o.Name, dir)
		}
	}
	versions, err := config.LoadVersions(r.abs("configuration/versions.yaml"))
	if err != nil {
		return err
	}
	if _, ok := versions.Charts[o.Name]; ok {
		return inputErrorf("configuration/versions.yaml already pins charts.%s", o.Name)
	}
	if o.Pattern != PatternOperator {
		schema, err := config.LoadSchemaDir(r.abs("configuration/schema"))
		if err != nil {
			return err
		}
		if _, ok := schema.Keys[envKey(o.Name)+"_HOSTNAME"]; ok {
			return inputErrorf("configuration key %s_HOSTNAME is already declared", envKey(o.Name))
		}
	}
	if o.CRDGroup != "" {
		reg, err := verify.LoadGitOpsRegistry(r.root)
		if err != nil {
			return err
		}
		if p, ok := reg.CRDProviders[o.CRDGroup]; ok {
			return inputErrorf("API group %s is already provided by %q (tests/gitops/crd-providers.yaml)", o.CRDGroup, p.App)
		}
		for _, k := range o.CRDKinds {
			stem := o.CRDGroup + "_" + k
			if r.exists("charts/bootstrap/files/health/"+stem+".lua") || r.exists("tests/health/"+stem) {
				return inputErrorf("a health check for %s already exists", stem)
			}
		}
		if names, err := schemaSourceNames(r.abs("tests/schemas/sources.yaml")); err != nil {
			return err
		} else if names[o.Name] {
			return inputErrorf("tests/schemas/sources.yaml already has a source named %q", o.Name)
		}
	}
	if o.HugeCRDs {
		reg, err := verify.LoadGitOpsRegistry(r.root)
		if err != nil {
			return err
		}
		if reg.HugeCRDChartSet()[o.Name] {
			return inputErrorf("%q is already listed in tests/gitops/huge-crd-charts.yaml", o.Name)
		}
	}
	// An Application of the same name rendered by some other template.
	for _, doc := range r.snapshotDocs([]string{TierAddons, TierApplications}) {
		if doc.Kind() != "Application" {
			continue
		}
		for _, n := range []string{o.Name, o.Name + "-config", o.Name + "-dependencies"} {
			if doc.Name() == n {
				return inputErrorf("an Application named %q is already rendered by charts/%s", n, doc.Chart)
			}
		}
	}
	return nil
}

// snapshotDocs reads the committed homelab and localdev snapshots of charts.
// Missing or unparsable snapshots are skipped: they only refine defaults.
func (r *repo) snapshotDocs(charts []string) []verify.Doc {
	var out []verify.Doc
	for _, env := range []string{"homelab", "localdev"} {
		for _, c := range charts {
			b, err := os.ReadFile(r.abs(fmt.Sprintf("tests/snapshots/%s/%s.yaml", env, c)))
			if err != nil {
				continue
			}
			docs, err := verify.ParseMultiDoc(c, env, b)
			if err != nil {
				continue
			}
			out = append(out, docs...)
		}
	}
	return out
}

// templateData derives everything the templates need.
func (r *repo) templateData(o Options) (*tmplData, error) {
	versions, err := config.LoadVersions(r.abs("configuration/versions.yaml"))
	if err != nil {
		return nil, err
	}
	curl := versions.Images["curl"]
	if curl == "" {
		return nil, fmt.Errorf("configuration/versions.yaml has no images.curl (the e2e curl Job pins it)")
	}

	oci := strings.HasPrefix(o.ChartRepo, "oci://")
	repoURL := strings.TrimPrefix(o.ChartRepo, "oci://")
	d := &tmplData{
		Name:         o.Name,
		EnvKey:       envKey(o.Name),
		HostnameKey:  envKey(o.Name) + "_HOSTNAME",
		Pattern:      o.Pattern,
		PatternTitle: patternTitle(o.Pattern),
		Tier:         o.Tier,
		ExportFile:   tierExport[o.Tier],
		Command:      commandLine(o),
		Namespace:    o.Namespace,
		ChartRepo:    o.ChartRepo,
		RepoURL:      repoURL,
		ChartName:    o.ChartName,
		ChartVersion: o.ChartVersion,
		OCI:          oci,
		TrueCharts:   oci && repoURL == trueChartsRepo,
		Port:         *o.Port,
		HealthPath:   o.HealthPath,
		Expect:       o.Expect,
		Smoke:        *o.Port > 0,
		Ingress:      o.Pattern != PatternOperator,
		Gateway:      traefikGateway,
		CurlImage:    curl,
		Wave:         *o.Wave,
		DepsWave:     *o.Wave - 1,
		ConfigWave:   *o.Wave + 2,
		CRDGroup:     o.CRDGroup,
		CRDKinds:     o.CRDKinds,
		HugeCRDs:     o.HugeCRDs,
	}
	if oci {
		d.RenovateMarker = fmt.Sprintf("datasource=docker depName=%s/%s", repoURL, o.ChartName)
	} else {
		d.RenovateMarker = fmt.Sprintf("datasource=helm depName=%s registryUrl=%s", o.ChartName, o.ChartRepo)
	}
	if d.Smoke {
		d.SmokeURL = fmt.Sprintf("http://%s.%s.svc.cluster.local:%d%s", o.Name, o.Namespace, *o.Port, o.HealthPath)
	}
	setTierExprs(d)
	d.AppNames = []string{o.Name}
	if o.Pattern == PatternDepsMainConfig {
		d.AppNames = []string{o.Name + "-dependencies", o.Name, o.Name + "-config"}
	}

	domain, err := r.localdevDomain()
	if err != nil {
		return nil, err
	}
	d.LocaldevHost = o.Name + "." + domain

	// The parent renders a Namespace only when it puts an object there itself
	// (the smoke Job), nothing that syncs before or with this parent renders
	// one, and the cluster does not have it. Otherwise the Application's
	// CreateNamespace=true is enough (cloudnative-pg).
	reg, err := verify.LoadGitOpsRegistry(r.root)
	if err != nil {
		return nil, err
	}
	earlier := []string{TierAddons}
	if o.Tier == TierApplications {
		earlier = append(earlier, TierApplications)
	}
	d.CreateNamespace = d.Smoke && !reg.SystemNamespaceSet()[o.Namespace]
	for _, doc := range r.snapshotDocs(earlier) {
		if doc.Kind() == "Namespace" && doc.Group() == "" && doc.Name() == o.Namespace {
			d.CreateNamespace = false
		}
	}

	// An OCI registry needs an ArgoCD repository Secret unless one exists.
	if oci {
		d.RepoSecret = true
		for _, doc := range r.snapshotDocs([]string{TierAddons, TierApplications}) {
			if doc.Kind() == "Secret" && doc.Labels()["argocd.argoproj.io/secret-type"] == "repository" &&
				strings.TrimRight(doc.GetString("stringData", "url"), "/") == repoURL {
				d.RepoSecret = false
			}
		}
	}
	return d, nil
}

// localdevDomain is DOMAIN as configuration/environments/localdev.yaml
// resolves it (the host the e2e test sends).
func (r *repo) localdevDomain() (string, error) {
	for _, f := range []string{"configuration/environments/localdev.yaml", "configuration/environments/defaults.yaml"} {
		env, err := config.LoadEnvironment(r.abs(f))
		if err != nil {
			return "", err
		}
		if d := strings.TrimSpace(env["DOMAIN"]); d != "" {
			return d, nil
		}
	}
	return "", fmt.Errorf("no DOMAIN in configuration/environments/localdev.yaml or defaults.yaml")
}

// envKey turns an app name into its configuration key prefix: my-app -> MY_APP.
func envKey(name string) string {
	return strings.ToUpper(strings.ReplaceAll(name, "-", "_"))
}

func patternTitle(p string) string {
	switch p {
	case PatternOperator:
		return "operator"
	case PatternHelm:
		return "upstream Helm chart"
	default:
		return "dependencies + main chart + config"
	}
}

// commandLine reproduces the invocation from the normalized options, spelling
// out every value that differs from its default.
func commandLine(o Options) string {
	parts := []string{"homelab", "scaffold", "app", o.Name, "--pattern", o.Pattern}
	defTier := TierAddons
	if o.Pattern == PatternHelm {
		defTier = TierApplications
	}
	if o.Tier != defTier {
		parts = append(parts, "--tier", o.Tier)
	}
	if o.Namespace != o.Name {
		parts = append(parts, "--namespace", o.Namespace)
	}
	parts = append(parts, "--chart-repo", o.ChartRepo)
	if o.ChartName != o.Name {
		parts = append(parts, "--chart-name", o.ChartName)
	}
	parts = append(parts, "--chart-version", o.ChartVersion)
	defPort := 80
	if o.Pattern == PatternOperator {
		defPort = 0
	}
	if *o.Port != defPort {
		parts = append(parts, "--port", strconv.Itoa(*o.Port))
	}
	if o.HealthPath != "/" {
		parts = append(parts, "--health-path", o.HealthPath)
	}
	if strings.Join(o.Expect, ",") != "200" {
		parts = append(parts, "--expect", strings.Join(o.Expect, ","))
	}
	if *o.Wave != defaultWave[o.Tier] {
		parts = append(parts, "--wave", strconv.Itoa(*o.Wave))
	}
	if o.CRDGroup != "" {
		parts = append(parts, "--crd-group", o.CRDGroup, "--crd-kinds", strings.Join(o.CRDKinds, ","))
	}
	if o.HugeCRDs {
		parts = append(parts, "--huge-crds")
	}
	return strings.Join(parts, " ")
}

// yamlTopKeys returns the top-level mapping keys of a YAML file.
func yamlTopKeys(path string) (map[string]bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	var m map[string]any
	if err := yaml.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	out := make(map[string]bool, len(m))
	for k := range m {
		out[k] = true
	}
	return out, nil
}

// schemaSourceNames returns the source names in tests/schemas/sources.yaml.
func schemaSourceNames(path string) (map[string]bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", path, err)
	}
	var f struct {
		Sources []struct {
			Name string `yaml:"name"`
		} `yaml:"sources"`
	}
	if err := yaml.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("parsing %s: %w", path, err)
	}
	out := map[string]bool{}
	for _, s := range f.Sources {
		out[s.Name] = true
	}
	return out, nil
}

// Apply writes every change. New files must still be absent.
func (p *Plan) Apply(root string) error { return WriteChanges(root, p.Changes) }

// WriteChanges writes changes under root, creating directories as needed. A
// change that creates a file fails when the file has appeared meanwhile.
func WriteChanges(root string, changes []Change) error {
	for _, c := range changes {
		abs := filepath.Join(root, filepath.FromSlash(c.Path))
		if c.Created() {
			if _, err := os.Stat(abs); err == nil {
				return fmt.Errorf("%s appeared since the plan was built; nothing past it was written", c.Path)
			}
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return fmt.Errorf("creating %s: %w", filepath.Dir(abs), err)
		}
		if err := os.WriteFile(abs, c.New, 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", c.Path, err)
		}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func dedupe(xs []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, x := range xs {
		x = strings.TrimSpace(x)
		if x == "" || seen[x] {
			continue
		}
		seen[x] = true
		out = append(out, x)
	}
	return out
}

// setTierExprs fills the Helm expressions the shared mainApp partial emits.
// charts/applications must render through the preview helpers of
// templates/_preview.tpl (docs/runbooks/previews.md); charts/addons has no
// preview mode, so it gets plain literals.
func setTierExprs(d *tmplData) {
	if d.Tier == TierApplications {
		d.PreviewAware = true
		d.AppNameExpr = fmt.Sprintf(`{{ include "homelab.preview.appName" (dict "root" $ "app" %q) }}`, d.Name)
		d.AppNamespaceExpr = `{{ include "homelab.preview.appNamespace" $ }}`
		d.ProjectExpr = `{{ include "homelab.preview.project" $ }}`
		d.DestNSExpr = `{{ include "homelab.preview.destNamespace" (dict "root" $ "namespace" $app.namespace) }}`
		d.ValuesExpr = `$values`
		d.ValuesBody = `{{- include "homelab.preview.hosts" (dict "root" $ "text" (toYaml .)) | nindent 8 }}`
		d.SmokeNSExpr = `(include "homelab.preview.destNamespace" (dict "root" $ "namespace" $app.namespace))`
		d.SmokeExpr = `$smoke`
		return
	}
	d.AppNameExpr = d.Name
	d.AppNamespaceExpr = "argocd"
	d.ProjectExpr = "default"
	d.DestNSExpr = `{{ $app.namespace }}`
	d.ValuesExpr = `$app.values`
	d.ValuesBody = `{{- toYaml . | nindent 8 }}`
	d.SmokeNSExpr = `$app.namespace`
	d.SmokeExpr = `$app.smoke`
}
