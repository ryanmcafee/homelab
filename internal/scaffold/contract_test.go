package scaffold

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/verify"
)

// TestScaffoldedRepoSatisfiesConfigContract scaffolds one app per pattern
// into a copy of the real repository's configuration and registries and
// checks the result against the rules internal/config/contract_test.go
// enforces on the committed tree: templates reference only declared keys,
// every new key is referenced, both committed environment files render every
// template without leftovers, and every referenced chart version exists and
// carries a Renovate marker. `task test:scaffold` covers the rest of level 0.
func TestScaffoldedRepoSatisfiesConfigContract(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	real, err := verify.FindRepoRoot(cwd)
	if err != nil {
		t.Skipf("not inside the repository: %v", err)
	}
	root := t.TempDir()
	for _, p := range []string{
		"configuration", "tests/gitops", "tests/schemas/sources.yaml", ".github/renovate.json5",
		"charts/addons/values.yaml", "charts/applications/values.yaml",
		"tests/snapshots/homelab/addons.yaml", "tests/snapshots/homelab/applications.yaml",
		"tests/snapshots/localdev/addons.yaml", "tests/snapshots/localdev/applications.yaml",
	} {
		copyPath(t, filepath.Join(real, p), filepath.Join(root, p))
	}

	apps := []Options{
		{Name: "contract-operator", Pattern: PatternOperator, ChartRepo: "https://charts.example.com/c",
			ChartVersion: "1.2.3", CRDGroup: "contract.example.com", CRDKinds: []string{"Widget"}, HugeCRDs: true},
		{Name: "contract-web", Pattern: PatternHelm, ChartRepo: "oci://oci.trueforge.org/truecharts",
			ChartVersion: "4.5.6", Port: intp(8080)},
		{Name: "contract-stack", Pattern: PatternDepsMainConfig, ChartRepo: "https://charts.example.com/c",
			ChartName: "stack", ChartVersion: "7.8.9"},
	}
	for _, o := range apps {
		o.RepoRoot = root
		plan, err := Build(o)
		if err != nil {
			t.Fatalf("Build %s: %v", o.Name, err)
		}
		if err := plan.Apply(root); err != nil {
			t.Fatalf("Apply %s: %v", o.Name, err)
		}
	}

	cfg := filepath.Join(root, "configuration")
	schema, err := config.LoadSchemaDir(filepath.Join(cfg, "schema"))
	if err != nil {
		t.Fatal(err)
	}
	versions, err := config.LoadVersions(filepath.Join(cfg, "versions.yaml"))
	if err != nil {
		t.Fatal(err)
	}

	valueRef := regexp.MustCompile(`\.Values\.([A-Z0-9_]+)\.Value`)
	chartRef := regexp.MustCompile(`index\s+\.Versions\.Charts\s+"([A-Za-z0-9_-]+)"`)
	referenced := map[string]bool{}
	tmpls, _ := filepath.Glob(filepath.Join(cfg, "templates", "*.tmpl"))
	for _, tmpl := range tmpls {
		b, err := os.ReadFile(tmpl)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range valueRef.FindAllStringSubmatch(string(b), -1) {
			referenced[m[1]] = true
			if _, ok := schema.Keys[m[1]]; !ok {
				t.Errorf("%s references undeclared key %s", filepath.Base(tmpl), m[1])
			}
		}
		for _, m := range chartRef.FindAllStringSubmatch(string(b), -1) {
			if _, ok := versions.Charts[m[1]]; !ok {
				t.Errorf("%s references chart %s missing from versions.yaml", filepath.Base(tmpl), m[1])
			}
		}
	}
	for _, key := range []string{"CONTRACT_WEB_HOSTNAME", "CONTRACT_STACK_HOSTNAME"} {
		if _, ok := schema.Keys[key]; !ok {
			t.Errorf("schema key %s was not declared", key)
		}
		if !referenced[key] {
			t.Errorf("schema key %s is declared but no template references it", key)
		}
	}
	if _, ok := schema.Keys["CONTRACT_OPERATOR_HOSTNAME"]; ok {
		t.Error("the operator pattern has no Ingress and must not declare a hostname key")
	}

	versionsText, _ := os.ReadFile(filepath.Join(cfg, "versions.yaml"))
	marker := regexp.MustCompile(`(?m)^  # renovate: datasource=\S+ depName=\S+.*\n  ([a-z0-9-]+): "([^"]+)"$`)
	pinned := map[string]string{}
	for _, m := range marker.FindAllStringSubmatch(string(versionsText), -1) {
		pinned[m[1]] = m[2]
	}

	defaults, err := config.LoadEnvironment(filepath.Join(cfg, "environments", "defaults.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	for _, env := range []struct{ set, file string }{{"homelab", "homelab.yaml.example"}, {"localdev", "localdev.yaml"}} {
		values, err := config.LoadEnvironment(filepath.Join(cfg, "environments", env.file))
		if err != nil {
			t.Fatal(err)
		}
		rc, err := config.Eval(schema, versions, env.set, defaults, values)
		if err != nil {
			t.Fatalf("Eval %s: %v", env.set, err)
		}
		for _, tmpl := range tmpls {
			out, err := config.Export(rc, tmpl)
			if err != nil {
				t.Fatalf("export %s for %s: %v", filepath.Base(tmpl), env.set, err)
			}
			if strings.Contains(out, "<no value>") || strings.Contains(out, "{{") || strings.Contains(out, "}}") {
				t.Errorf("export %s for %s left template artifacts", filepath.Base(tmpl), env.set)
			}
			if !strings.HasPrefix(filepath.Base(tmpl), "helm-") {
				continue
			}
			var doc map[string]any
			if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
				t.Fatalf("export %s for %s is not YAML: %v", filepath.Base(tmpl), env.set, err)
			}
			for _, o := range apps {
				block, ok := doc[o.Name].(map[string]any)
				if !ok {
					continue // lives in the other tier's template
				}
				if block["enabled"] != true {
					t.Errorf("%s/%s: %s.enabled = %v, want true", env.set, filepath.Base(tmpl), o.Name, block["enabled"])
				}
				chart, _ := block["chart"].(map[string]any)
				if chart["version"] != o.ChartVersion {
					t.Errorf("%s: %s.chart.version = %v, want %s", env.set, o.Name, chart["version"], o.ChartVersion)
				}
				if pinned[o.Name] != o.ChartVersion {
					t.Errorf("versions.yaml pins %s = %q with a Renovate marker, want %q", o.Name, pinned[o.Name], o.ChartVersion)
				}
			}
		}
	}
}

// copyPath copies a file or directory tree, creating parents.
func copyPath(t *testing.T, src, dst string) {
	t.Helper()
	info, err := os.Stat(src)
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		t.Fatal(err)
	}
	if info.IsDir() {
		if err := copyTree(src, dst); err != nil {
			t.Fatal(err)
		}
		return
	}
	b, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, b, 0o644); err != nil {
		t.Fatal(err)
	}
}
