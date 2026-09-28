package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const openClawApps = `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: openclaw-operator
spec:
  source:
    repoURL: ghcr.io/paperclipinc/charts
    chart: openclaw-operator
    targetRevision: "0.40.0"
    helm:
      values: |
        watchNamespaces: [agents]
        rbac:
          aggregateToDefaultRoles: false
  destination:
    namespace: operators
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: openclaw
spec:
  source:
    path: charts/openclaw
  destination:
    namespace: agents
`

func TestOpenClawSource(t *testing.T) {
	for _, tc := range []struct {
		name, from, to string
		bad            bool
	}{
		{name: "valid"},
		{"range", "0.40.0", ">=0.40.0", true},
		{"missing peer", "name: openclaw\n", "name: missing\n", false}, // path also identifies it
		{"same namespace", "namespace: agents", "namespace: operators", true},
		{"multi source", "    helm:", "    helm:\n  sources: []\n  unused:", true},
		{"value file", "      values: |", "      valueFiles: [other.yaml]\n      values: |", true},
		{"file parameter", "      values: |", "      fileParameters: []\n      values: |", true},
		{"malformed object", "      values: |", "      valuesObject: []\n      values: |", true},
		{"malformed parameter", "      values: |", "      parameters: [{name: watchNamespaces, value: 4}]\n      values: |", true},
		{"unknown Helm option", "      values: |", "      apiVersions: [rbac.example/v1]\n      values: |", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := openClawApps
			if tc.from != "" {
				body = strings.Replace(body, tc.from, tc.to, 1)
			}
			docs, err := ParseMultiDoc("applications", "homelab", []byte(body))
			if err != nil {
				t.Fatal(err)
			}
			_, _, present, err := openClawSource(map[string][]Doc{"applications": docs})
			if !present || (err != nil) != tc.bad {
				t.Fatalf("present=%v err=%v want bad=%v", present, err, tc.bad)
			}
		})
	}
}

func TestOpenClawIntent(t *testing.T) {
	for _, tc := range []struct {
		name             string
		watch, aggregate any
		bad              bool
	}{
		{"scoped", []any{"agents"}, false, false},
		{"wrong", []any{"elsewhere"}, false, true},
		{"additional", []any{"agents", "elsewhere"}, false, true},
		{"duplicate", []any{"agents", "agents"}, false, true},
		{"empty", []any{}, false, true},
		{"missing", nil, false, true},
		{"string", "agents", false, true},
		{"map", map[string]any{"agents": true}, false, true},
		{"nonstring", []any{42}, false, true},
		{"aggregate", []any{"agents"}, true, true},
		{"aggregate missing", []any{"agents"}, nil, true},
		{"aggregate string", []any{"agents"}, "false", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateOpenClawIntent(map[string]any{"watchNamespaces": tc.watch, "rbac": map[string]any{"aggregateToDefaultRoles": tc.aggregate}}, "operators", "agents")
			if (err != nil) != tc.bad {
				t.Fatalf("err=%v want bad=%v", err, tc.bad)
			}
		})
	}
}

func TestUpstreamValuesObjectReplacesValues(t *testing.T) {
	dir := t.TempDir()
	paths, err := upstreamValueFiles(ChartSource{Values: "watchNamespaces: [unsafe]\n", ValuesObject: map[string]any{"rbac": map[string]any{"aggregateToDefaultRoles": false}}}, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || filepath.Base(paths[0]) != "values-object.yaml" {
		t.Fatalf("paths=%v", paths)
	}
	data, err := os.ReadFile(paths[0])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "watchNamespaces") {
		t.Fatal("values must not leak into valuesObject")
	}
}

func TestArgoHelmParameter(t *testing.T) {
	for in, want := range map[string]string{"a,b": "a\\,b", "{a,b}": "{a,b}", "a\\,b": "a\\,b", "agents,rbac.aggregateToDefaultRoles=true": "agents\\,rbac.aggregateToDefaultRoles=true"} {
		if got := argoHelmParameter(in); got != want {
			t.Errorf("%q: %q want %q", in, got, want)
		}
	}
}

// Opt-in local Helm test: no chart fetch or cluster access. CI has Helm installed.
func TestOpenClawEffectiveValuesHelm(t *testing.T) {
	if os.Getenv("HOMELAB_TEST_HELM") == "" {
		t.Skip("set HOMELAB_TEST_HELM=1 for local Helm precedence integration")
	}
	runner := pinTools(context.Background(), ExecRunner{}, "../..", "helm")
	for _, tc := range []struct {
		name   string
		object any
		params []HelmParameter
		bad    bool
	}{
		{name: "inline"},
		{name: "object replaces inline", object: map[string]any{"rbac": map[string]any{"aggregateToDefaultRoles": false}}, bad: true},
		{name: "parameter overrides namespace", params: []HelmParameter{{Name: "watchNamespaces[0]", Value: "elsewhere"}}, bad: true},
		{name: "parameter adds namespace", params: []HelmParameter{{Name: "watchNamespaces[1]", Value: "elsewhere"}}, bad: true},
		{name: "parameter enables aggregation", params: []HelmParameter{{Name: "rbac.aggregateToDefaultRoles", Value: "true"}}, bad: true},
		{name: "force string false is not bool", params: []HelmParameter{{Name: "rbac.aggregateToDefaultRoles", Value: "false", ForceString: true}}, bad: true},
		{name: "comma is literal", params: []HelmParameter{{Name: "watchNamespaces[0]", Value: "agents,rbac.aggregateToDefaultRoles=false"}}, bad: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			src := ChartSource{App: "openclaw-operator", Values: "watchNamespaces: [agents]\nrbac:\n  aggregateToDefaultRoles: false\n", ValuesObject: tc.object, Parameters: tc.params}
			values, err := openClawValues(context.Background(), runner, src, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			err = validateOpenClawIntent(values, "operators", "agents")
			if (err != nil) != tc.bad {
				t.Fatalf("%v: %v want bad=%v", values, err, tc.bad)
			}
		})
	}
}

type openClawRunner struct {
	*fakeUpgradeRunner
	probeError  bool
	probeValues string
}

func (r openClawRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, []byte, error) {
	if name == "helm" && len(args) > 2 && filepath.Base(args[2]) == "probe" {
		if r.probeError {
			return nil, nil, fmt.Errorf("probe failure")
		}
		return []byte(fmt.Sprintf("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: probe\ndata:\n  values: %q\n", r.probeValues)), nil, nil
	}
	return r.fakeUpgradeRunner.Run(ctx, dir, name, args...)
}

func TestOpenClawUpgradeCannotSkipAssertion(t *testing.T) {
	for _, tc := range []struct {
		name, manifest string
		baseFail       bool
	}{
		{name: "unchanged empty render"},
		{name: "unavailable base", baseFail: true},
		{name: "unparsed", manifest: "[invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeUpgradeRunner{sha: "abcd", manifests: map[string]string{"oci://ghcr.io/paperclipinc/charts/openclaw-operator@0.40.0": tc.manifest}}
			r := openClawRunner{fakeUpgradeRunner: fake, probeValues: `{"watchNamespaces":["agents"],"rbac":{"aggregateToDefaultRoles":false}}`}
			var fails []string
			if tc.baseFail {
				fails = []string{"applications"}
			}
			_, result := Upgrade(context.Background(), UpgradeOptions{Runner: r, RepoRoot: t.TempDir(), BaseRef: "main", WorkDir: t.TempDir(), Envs: []Env{{Name: "homelab"}}, Render: fakeRender(map[string]string{"applications": openClawApps}, map[string]string{"applications": openClawApps}, fails)})
			for _, c := range result.Checks {
				if c.Name == "upgrade/homelab/openclaw-rbac" {
					if c.Status != StatusFail {
						t.Fatalf("assertion bypassed: %+v", c)
					}
					if result.Pass {
						t.Fatal("failed assertion must fail result")
					}
					return
				}
			}
			t.Fatal("missing required RBAC check")
		})
	}
}

func TestOpenClawUnavailableInputsFail(t *testing.T) {
	docs, err := ParseMultiDoc("applications", "homelab", []byte(openClawApps))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		docs   map[string][]Doc
		runner openClawRunner
	}{
		{name: "missing manifests", docs: map[string][]Doc{}, runner: openClawRunner{fakeUpgradeRunner: &fakeUpgradeRunner{}}},
		{name: "empty manifests", docs: map[string][]Doc{"applications": {}}, runner: openClawRunner{fakeUpgradeRunner: &fakeUpgradeRunner{}}},
		{name: "probe fails", docs: map[string][]Doc{"applications": docs}, runner: openClawRunner{fakeUpgradeRunner: &fakeUpgradeRunner{}, probeError: true}},
		{name: "fetch fails", docs: map[string][]Doc{"applications": docs}, runner: openClawRunner{fakeUpgradeRunner: &fakeUpgradeRunner{}, probeValues: `{"watchNamespaces":["agents"],"rbac":{"aggregateToDefaultRoles":false}}`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := OpenClawCheck(context.Background(), tc.runner, "homelab", tc.docs, true)
			if c.Status != StatusFail {
				t.Fatalf("%+v", c)
			}
		})
	}
}

func TestOpenClawUpgradeScopedValuesDoNotAuthorizeUnsafeRender(t *testing.T) {
	for _, tc := range []struct {
		file string
		want Status
	}{{"scoped-0.40.0.yaml", StatusPass}, {"cluster-wide-0.40.0.yaml", StatusFail}} {
		t.Run(tc.file, func(t *testing.T) {
			data, err := os.ReadFile("testdata/openclaw/" + tc.file)
			if err != nil {
				t.Fatal(err)
			}
			fake := &fakeUpgradeRunner{sha: "abcd", manifests: map[string]string{"oci://ghcr.io/paperclipinc/charts/openclaw-operator@0.40.0": string(data)}}
			r := openClawRunner{fakeUpgradeRunner: fake, probeValues: `{"watchNamespaces":["openclaw"],"rbac":{"aggregateToDefaultRoles":false}}`}
			apps := strings.ReplaceAll(strings.ReplaceAll(openClawApps, "namespace: agents", "namespace: openclaw"), "namespace: operators", "namespace: openclaw-system")
			_, result := Upgrade(context.Background(), UpgradeOptions{Runner: r, RepoRoot: t.TempDir(), BaseRef: "main", WorkDir: t.TempDir(), Envs: []Env{{Name: "homelab"}}, Render: fakeRender(map[string]string{"applications": apps}, map[string]string{"applications": apps}, nil)})
			for _, c := range result.Checks {
				if c.Name == "upgrade/homelab/openclaw-rbac" {
					if c.Status != tc.want {
						t.Fatalf("%+v", c)
					}
					if tc.want == StatusFail && result.Pass {
						t.Fatal("unsafe render did not fail upgrade")
					}
					return
				}
			}
			t.Fatal("assertion missing")
		})
	}
}
