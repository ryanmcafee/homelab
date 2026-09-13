package scaffold

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/verify"
)

var update = flag.Bool("update", false, "rewrite the golden patches in testdata/golden")

// fixtureRepo copies testdata/repo (a trimmed repository holding every file
// the scaffolder reads or edits) into a temp dir.
func fixtureRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := copyTree(filepath.Join("testdata", "repo"), dir); err != nil {
		t.Fatalf("copying fixture: %v", err)
	}
	return dir
}

func intp(i int) *int { return &i }

// goldenCases cover every pattern plus the branches that change the output:
// TrueCharts vs generic values, an existing namespace, a new OCI registry (repo
// Secret), the addons tier (no preview helpers) and the applications tier.
func goldenCases() []struct {
	name string
	opts Options
} {
	return []struct {
		name string
		opts Options
	}{
		{"operator", Options{
			Name: "demo-operator", Pattern: PatternOperator,
			ChartRepo: "https://charts.example.com/demo", ChartVersion: "1.0.0",
			CRDGroup: "demo.example.com", CRDKinds: []string{"Widget", "Gadget"}, HugeCRDs: true,
		}},
		{"helm-truecharts", Options{
			Name: "demo-web", Pattern: PatternHelm,
			ChartRepo: "oci://oci.trueforge.org/truecharts", ChartVersion: "2.0.0",
			Port: intp(8080), HealthPath: "/healthz", Expect: []string{"200", "401"},
		}},
		{"helm-generic-existing-namespace", Options{
			Name: "demo-generic", Pattern: PatternHelm, Namespace: "media",
			ChartRepo: "https://charts.example.com/demo", ChartName: "generic", ChartVersion: "0.3.1",
		}},
		{"helm-oci-addons", Options{
			Name: "demo-oci", Pattern: PatternHelm, Tier: TierAddons,
			ChartRepo: "oci://ghcr.io/example/charts", ChartVersion: "0.1.0", Wave: intp(11),
		}},
		{"deps-main-config", Options{
			Name: "demo-stack", Pattern: PatternDepsMainConfig,
			ChartRepo: "https://charts.example.com/demo", ChartName: "stack", ChartVersion: "2.0.0",
			HealthPath: "/alive",
		}},
		{"deps-main-config-applications", Options{
			Name: "demo-suite", Pattern: PatternDepsMainConfig, Tier: TierApplications,
			ChartRepo: "https://charts.example.com/demo", ChartVersion: "3.1.4", Port: intp(3000),
		}},
	}
}

// TestGoldenPlans pins the whole change of every case as one patch. Run
// `go test ./internal/scaffold -run TestGoldenPlans -update` after an
// intended template change and review the golden diff.
func TestGoldenPlans(t *testing.T) {
	for _, tc := range goldenCases() {
		t.Run(tc.name, func(t *testing.T) {
			root := fixtureRepo(t)
			opts := tc.opts
			opts.RepoRoot = root
			plan, err := Build(opts)
			if err != nil {
				t.Fatalf("Build: %v", err)
			}
			// Trailing whitespace is dropped (a blank context line is " " in a
			// patch): the pre-commit trailing-whitespace hook would strip it from
			// the golden file. TestFileDiff and TestDiffAppliesWithGitApply pin
			// the exact bytes.
			got := trimTrailingSpace(plan.Diff())
			golden := filepath.Join("testdata", "golden", tc.name+".diff")
			if *update {
				if err := os.MkdirAll(filepath.Dir(golden), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(golden)
			if err != nil {
				t.Fatalf("reading golden (run with -update): %v", err)
			}
			if got != trimTrailingSpace(string(want)) {
				t.Errorf("plan differs from %s (rerun with -update and review):\n%s",
					golden, verify.UnifiedDiff(tc.name, want, []byte(got)))
			}

			// Apply writes exactly what the plan says.
			if err := plan.Apply(root); err != nil {
				t.Fatalf("Apply: %v", err)
			}
			for _, c := range plan.Changes {
				b, err := os.ReadFile(filepath.Join(root, c.Path))
				if err != nil {
					t.Fatal(err)
				}
				if string(b) != string(c.New) {
					t.Errorf("%s on disk differs from the plan", c.Path)
				}
			}
			// A second run of the same scaffold is refused: the name exists.
			if _, err := Build(opts); !IsInputError(err) {
				t.Errorf("scaffolding %s twice: err = %v, want an InputError", opts.Name, err)
			}
		})
	}
}

func TestPlanShape(t *testing.T) {
	root := fixtureRepo(t)
	plan, err := Build(Options{RepoRoot: root, Name: "demo-stack", Pattern: PatternDepsMainConfig,
		ChartRepo: "https://charts.example.com/demo", ChartVersion: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(plan.SnapshotCharts, ","), "addons,demo-stack-config,demo-stack-dependencies"; got != want {
		t.Errorf("SnapshotCharts = %s, want %s", got, want)
	}
	o := plan.Options
	if o.Tier != TierAddons || o.Namespace != "demo-stack" || *o.Port != 80 || *o.Wave != 10 ||
		o.ChartName != "demo-stack" || o.HealthPath != "/" || strings.Join(o.Expect, ",") != "200" {
		t.Errorf("defaults not applied: %+v port=%d wave=%d", o, *o.Port, *o.Wave)
	}
	for i := 1; i < len(plan.Changes); i++ {
		if plan.Changes[i-1].Path >= plan.Changes[i].Path {
			t.Errorf("changes not sorted: %s before %s", plan.Changes[i-1].Path, plan.Changes[i].Path)
		}
	}

	op, err := Build(Options{RepoRoot: fixtureRepo(t), Name: "demo-op", Pattern: PatternOperator,
		ChartRepo: "https://charts.example.com/demo", ChartVersion: "1.0.0",
		CRDGroup: "demo.example.com", CRDKinds: []string{"Widget"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(op.SnapshotCharts, ","); got != "addons,bootstrap" {
		t.Errorf("operator SnapshotCharts = %s, want addons,bootstrap", got)
	}
	app := string(changeFor(t, op, "charts/addons/templates/demo-op.yaml").New)
	if strings.Contains(app, "kind: Namespace") {
		t.Error("an operator without a smoke hook must rely on CreateNamespace=true, not render a Namespace")
	}
}

func changeFor(t *testing.T, p *Plan, path string) Change {
	t.Helper()
	for _, c := range p.Changes {
		if c.Path == path {
			return c
		}
	}
	t.Fatalf("plan has no change for %s", path)
	return Change{}
}

func TestCommittedValuesRendersTheNewBlockForLocaldev(t *testing.T) {
	root := fixtureRepo(t)
	plan, err := Build(Options{RepoRoot: root, Name: "demo-generic", Pattern: PatternHelm,
		ChartRepo: "https://charts.example.com/demo", ChartVersion: "0.3.1"})
	if err != nil {
		t.Fatal(err)
	}
	values, err := CommittedValues(root, plan)
	if err != nil {
		t.Fatal(err)
	}
	if len(values) != 1 || values[0].Path != "charts/applications/values-localdev.yaml" {
		t.Fatalf("CommittedValues = %+v, want one change to charts/applications/values-localdev.yaml", values)
	}
	out := string(values[0].New)
	for _, want := range []string{
		"demo-generic:\n  enabled: true",
		`version: "0.3.1"`,
		"replicaCount: 1",
		"- host: demo-generic.homelab.local",
		"url: http://demo-generic.demo-generic.svc.cluster.local:80/",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("localdev values lack %q:\n%s", want, out)
		}
	}
	// Nothing was written: CommittedValues works on an overlay.
	if _, err := os.Stat(filepath.Join(root, "charts/applications/values-localdev.yaml")); !os.IsNotExist(err) {
		t.Errorf("CommittedValues wrote to the repository: %v", err)
	}
}

func TestNormalizeRejectsBadInput(t *testing.T) {
	base := func() Options {
		return Options{Name: "demo", Pattern: PatternHelm, ChartRepo: "https://charts.example.com", ChartVersion: "1.0.0"}
	}
	tests := []struct {
		name string
		mod  func(*Options)
		want string
	}{
		{"empty name", func(o *Options) { o.Name = "" }, "app name is required"},
		{"uppercase", func(o *Options) { o.Name = "Demo" }, "DNS label"},
		{"underscore", func(o *Options) { o.Name = "my_app" }, "DNS label"},
		{"leading digit", func(o *Options) { o.Name = "1app" }, "DNS label"},
		{"trailing dash", func(o *Options) { o.Name = "app-" }, "DNS label"},
		{"too long", func(o *Options) { o.Name = strings.Repeat("a", MaxNameLen+1) }, "characters"},
		{"child suffix config", func(o *Options) { o.Name = "demo-config" }, "-config or -dependencies"},
		{"child suffix deps", func(o *Options) { o.Name = "demo-dependencies" }, "-config or -dependencies"},
		{"parent chart", func(o *Options) { o.Name = "addons" }, "reserved"},
		{"values key", func(o *Options) { o.Name = "global" }, "reserved"},
		{"unknown pattern", func(o *Options) { o.Pattern = "kustomize" }, "--pattern must be one of"},
		{"missing pattern", func(o *Options) { o.Pattern = "" }, "--pattern must be one of"},
		{"unknown tier", func(o *Options) { o.Tier = "core" }, "--tier must be one of"},
		{"bad namespace", func(o *Options) { o.Namespace = "Media" }, "--namespace"},
		{"missing repo", func(o *Options) { o.ChartRepo = "" }, "--chart-repo is required"},
		{"repo scheme", func(o *Options) { o.ChartRepo = "charts.example.com" }, "https://, http:// or oci://"},
		{"oci repo with chart", func(o *Options) { o.ChartRepo = "oci://ghcr.io/x/demo" }, "without the chart"},
		{"bad chart name", func(o *Options) { o.ChartName = "Bad Chart" }, "--chart-name"},
		{"missing version", func(o *Options) { o.ChartVersion = "" }, "--chart-version is required"},
		{"quoted version", func(o *Options) { o.ChartVersion = `1.0"` }, "--chart-version"},
		{"port range", func(o *Options) { o.Port = intp(70000) }, "out of range"},
		{"port zero for helm", func(o *Options) { o.Port = intp(0) }, "--port is required"},
		{"wave range", func(o *Options) { o.Wave = intp(500) }, "--wave"},
		{"relative health path", func(o *Options) { o.HealthPath = "healthz" }, "--health-path"},
		{"health path with space", func(o *Options) { o.HealthPath = "/a b" }, "--health-path"},
		{"expect not a code", func(o *Options) { o.Expect = []string{"ok"} }, "--expect"},
		{"kinds without group", func(o *Options) { o.CRDKinds = []string{"Widget"} }, "--crd-kinds needs --crd-group"},
		{"group without kinds", func(o *Options) { o.CRDGroup = "demo.example.com" }, "--crd-group needs --crd-kinds"},
		{"operator without group", func(o *Options) { o.Pattern = PatternOperator }, "operator pattern needs --crd-group"},
		{"single-label group", func(o *Options) {
			o.CRDGroup = "widgets"
			o.CRDKinds = []string{"Widget"}
		}, "DNS subdomain"},
		{"lowercase kind", func(o *Options) {
			o.CRDGroup = "demo.example.com"
			o.CRDKinds = []string{"widget"}
		}, "must be a Kind"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			o := base()
			tc.mod(&o)
			err := o.Normalize()
			if err == nil {
				t.Fatalf("Normalize accepted %+v", o)
			}
			if !IsInputError(err) {
				t.Errorf("error %v is not an InputError", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

func TestNormalizeDefaults(t *testing.T) {
	tests := []struct {
		pattern, tier string
		port, wave    int
	}{
		{PatternOperator, TierAddons, 0, 10},
		{PatternHelm, TierApplications, 80, 13},
		{PatternDepsMainConfig, TierAddons, 80, 10},
	}
	for _, tc := range tests {
		t.Run(tc.pattern, func(t *testing.T) {
			o := Options{Name: "demo", Pattern: tc.pattern, ChartRepo: "https://c.example.com", ChartVersion: "1"}
			if tc.pattern == PatternOperator {
				o.CRDGroup, o.CRDKinds = "demo.example.com", []string{"Widget", "Widget", " "}
			}
			if err := o.Normalize(); err != nil {
				t.Fatal(err)
			}
			if o.Tier != tc.tier || *o.Port != tc.port || *o.Wave != tc.wave {
				t.Errorf("tier=%s port=%d wave=%d, want %s %d %d", o.Tier, *o.Port, *o.Wave, tc.tier, tc.port, tc.wave)
			}
			if tc.pattern == PatternOperator && strings.Join(o.CRDKinds, ",") != "Widget" {
				t.Errorf("CRDKinds not deduplicated: %v", o.CRDKinds)
			}
		})
	}
}

func TestBuildRefusesWhatExists(t *testing.T) {
	tests := []struct {
		name string
		opts Options
		want string
	}{
		{"values key and versions pin", Options{Name: "sonarr", Pattern: PatternHelm}, "already exists"},
		{"versions pin only", Options{Name: "unifi-port-forward", Pattern: PatternHelm}, "already pins"},
		{"application rendered elsewhere", Options{Name: "external-dns-cloudflare-crd", Pattern: PatternHelm}, "already rendered"},
		{"crd group", Options{Name: "demo", Pattern: PatternOperator, CRDGroup: "postgresql.cnpg.io", CRDKinds: []string{"Cluster"}}, "already provided"},
		{"huge crd chart", Options{Name: "traefik-external", Pattern: PatternOperator, CRDGroup: "traefik.example.com", CRDKinds: []string{"Route"}, HugeCRDs: true}, "huge-crd-charts"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			o := tc.opts
			o.RepoRoot = fixtureRepo(t)
			o.ChartRepo, o.ChartVersion = "https://charts.example.com", "1.0.0"
			_, err := Build(o)
			if !IsInputError(err) {
				t.Fatalf("err = %v, want an InputError", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}

	t.Run("existing health check", func(t *testing.T) {
		root := fixtureRepo(t)
		lua := filepath.Join(root, "charts/bootstrap/files/health/demo.example.com_Widget.lua")
		if err := os.MkdirAll(filepath.Dir(lua), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(lua, []byte("return {}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := Build(Options{RepoRoot: root, Name: "demo", Pattern: PatternOperator,
			ChartRepo: "https://charts.example.com", ChartVersion: "1", CRDGroup: "demo.example.com", CRDKinds: []string{"Widget"}})
		if !IsInputError(err) || !strings.Contains(err.Error(), "health check") {
			t.Errorf("err = %v, want an InputError about the health check", err)
		}
	})
}

func TestBlockingFailures(t *testing.T) {
	res := verify.NewResult(0)
	res.Add(
		verify.Check{Name: "render/homelab/addons", Status: verify.StatusFail},
		verify.Check{Name: "render/localdev/_committed-values", Status: verify.StatusFail},
		verify.Check{Name: "render/homelab/_inherit", Status: verify.StatusFail},
		verify.Check{Name: "render/homelab/grafana-config", Status: verify.StatusFail},
		verify.Check{Name: "render/setup", Status: verify.StatusFail},
		verify.Check{Name: "render/localdev/addons", Status: verify.StatusPass},
	)
	var names []string
	for _, c := range BlockingFailures(res, []string{"addons"}) {
		names = append(names, c.Name)
	}
	if got, want := strings.Join(names, ","), "render/homelab/addons,render/homelab/_inherit,render/setup"; got != want {
		t.Errorf("BlockingFailures = %s, want %s", got, want)
	}
}

func TestEnvKeyAndCommandLine(t *testing.T) {
	if got := envKey("my-app-2"); got != "MY_APP_2" {
		t.Errorf("envKey = %s", got)
	}
	o := Options{Name: "demo", Pattern: PatternHelm, ChartRepo: "https://c.example.com", ChartVersion: "1",
		Namespace: "media", Port: intp(8080), Expect: []string{"200", "401"}}
	if err := o.Normalize(); err != nil {
		t.Fatal(err)
	}
	want := "homelab scaffold app demo --pattern helm --namespace media --chart-repo https://c.example.com --chart-version 1 --port 8080 --expect 200,401"
	if got := commandLine(o); got != want {
		t.Errorf("commandLine =\n%s\nwant\n%s", got, want)
	}
}

// trimTrailingSpace removes trailing spaces and tabs from every line.
func trimTrailingSpace(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}
	return strings.Join(lines, "\n")
}
