package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/ryanmcafee/homelab/internal/config"
)

// onePasswordPathKey is one configuration/ *_1P_PATH key and the
// OnePasswordItem whose spec.itemPath it must end up as. The path travels
// ConfigSet -> CMP template -> parent values -> the child Application's
// helm.valuesObject -> the child chart. Every hop is real in this test; nothing
// is asserted against the committed child overlays, because a literal there is
// exactly the defect this guards (MCAA-631).
type onePasswordPathKey struct {
	key    string   // configuration/schema/secrets.schema.yaml key
	parent string   // parent chart whose Application hands the path down
	chart  string   // child chart directory that renders the OnePasswordItem
	item   string   // OnePasswordItem metadata.name
	values []string // the child chart's values path for the item path
}

// onePasswordPathKeys is every *_1P_PATH key consumed by a separate child
// Application. Keys a parent reads itself (ALERTMANAGER_1P_PATH,
// GITHUB_PR_ALERTS_1P_PATH, the PAPERCLIP_* set, TRIAGE_AGENT_1P_PATH,
// ARGO_WORKFLOWS_ARTIFACTS_1P_PATH) are covered where they are read; a key
// whose child chart hard-codes its own path belongs here, not in an exception
// list.
var onePasswordPathKeys = []onePasswordPathKey{
	{key: "DEMOCRATIC_CSI_1P_PATH", parent: "addons", chart: "democratic-csi-config", item: "truenas-api-key",
		values: []string{"truenas", "onePasswordItemPath"}},
	{key: "CERT_MANAGER_1P_PATH", parent: "addons", chart: "cert-manager-config", item: "cloudflare-api-token",
		values: []string{"cloudflare", "onePasswordItemPath"}},
	{key: "EXTERNAL_DNS_1P_PATH", parent: "addons", chart: "external-dns-config", item: "cloudflare-api-token",
		values: []string{"cloudflare", "onePasswordItemPath"}},
	{key: "EXTERNAL_DNS_UNIFI_1P_PATH", parent: "addons", chart: "external-dns-config", item: "unifi-api-credentials",
		values: []string{"unifi", "onePasswordItemPath"}},
	{key: "TAILSCALE_OPERATOR_1P_PATH", parent: "addons", chart: "tailscale-config", item: "operator-oauth",
		values: []string{"tailscale", "onePasswordItemPath"}},
	{key: "UNIFI_PORT_FORWARD_1P_PATH", parent: "addons", chart: "port-forwarding-controller-config", item: "unifi-credentials",
		values: []string{"unifi", "onePasswordItemPath"}},
	{key: "DUCKDNS_1P_PATH", parent: "applications", chart: "duckdns-dependencies", item: "duckdns-token",
		values: []string{"onePasswordItemPath"}},
}

// TestOnePasswordItemPathsAreNotCommittedInChildOverlays keeps the duplication
// from coming back. A literal in values-<env>.yaml is currently harmless —
// helm.valuesObject overrides valueFiles — but it is a second copy of the value
// the ConfigSet owns, and the only reason MCAA-631 stayed invisible was that
// the copy happened to agree with the default. The chart's own values.yaml
// still declares the key so the template has a default; only env overlays are
// checked.
func TestOnePasswordItemPathsAreNotCommittedInChildOverlays(t *testing.T) {
	root, err := FindRepoRoot(mustGetwd(t))
	if err != nil {
		t.Skip("not in repo")
	}
	for _, k := range onePasswordPathKeys {
		overlays, err := filepath.Glob(filepath.Join(root, "charts", k.chart, "values-*.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		for _, overlay := range overlays {
			raw, err := os.ReadFile(overlay)
			if err != nil {
				t.Fatal(err)
			}
			var tree map[string]any
			if err := yaml.Unmarshal(raw, &tree); err != nil {
				t.Fatalf("parsing %s: %v", overlay, err)
			}
			if got := lookupString(tree, k.values); got != "" {
				t.Errorf("%s sets %s to %q; %s owns that value and the parent Application passes it down",
					filepath.Join("charts", k.chart, filepath.Base(overlay)), strings.Join(k.values, "."), got, k.key)
			}
		}
	}
}

// lookupString walks a decoded YAML tree and returns the string at path, or ""
// when any segment is missing or not a string.
func lookupString(tree map[string]any, path []string) string {
	var cur any = tree
	for _, seg := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return ""
		}
		if cur, ok = m[seg]; !ok {
			return ""
		}
	}
	s, _ := cur.(string)
	return s
}

// TestOnePasswordItemPathsFollowTheConfigSet renders the whole chain twice with
// two different sets of *_1P_PATH values and requires every rendered itemPath
// to be the fork's own. Two forks rather than one: the committed default and
// the child overlays used to carry the same literal, so a single render agreed
// with the ConfigSet by coincidence. Distinct values per fork cannot.
func TestOnePasswordItemPathsFollowTheConfigSet(t *testing.T) {
	root, err := FindRepoRoot(mustGetwd(t))
	if err != nil {
		t.Skip("not in repo")
	}

	forks := []string{"fork-a", "fork-b"}
	// itemPath per fork per key, keyed by "<chart>/<item>".
	got := make([]map[string]string, len(forks))
	for i, fork := range forks {
		want := map[string]string{}
		overrides := map[string]string{}
		for _, k := range onePasswordPathKeys {
			overrides[k.key] = fmt.Sprintf("vaults/%s/items/%s", fork, k.key)
			want[k.chart+"/"+k.item] = overrides[k.key]
		}
		got[i] = renderOnePasswordItems(t, root, fork, overrides)
		for id, wantPath := range want {
			if got[i][id] != wantPath {
				t.Errorf("%s: %s spec.itemPath = %q, want %q (the ConfigSet key never reached the child chart)",
					fork, id, got[i][id], wantPath)
			}
		}
	}

	for id, a := range got[0] {
		if b := got[1][id]; a == b {
			t.Errorf("%s: both forks rendered spec.itemPath %q, so the value is not coming from the ConfigSet", id, a)
		}
	}
}

// renderOnePasswordItems runs the real two-stage pipeline for the homelab
// example ConfigSet with overrides applied, and returns the spec.itemPath of
// every OnePasswordItem the child charts in onePasswordPathKeys render, keyed
// by "<chart>/<name>".
func renderOnePasswordItems(t *testing.T, root, fork string, overrides map[string]string) map[string]string {
	t.Helper()
	ctx := context.Background()
	runner := ExecRunner{}
	dir := t.TempDir()

	rc := resolveForkConfig(t, root, overrides)

	// Stage 1: the CMP template, per parent chart that needs one.
	inherited := map[string]string{}
	for _, parent := range []string{"addons", "applications"} {
		tmpl := filepath.Join(root, "configuration", "templates", TwoStageCharts[parent]+".tmpl")
		values, err := config.Export(rc, tmpl)
		if err != nil {
			t.Fatalf("%s: exporting %s: %v", fork, tmpl, err)
		}
		valuesFile := filepath.Join(dir, parent+"-values.yaml")
		if err := os.WriteFile(valuesFile, []byte(values), 0o644); err != nil {
			t.Fatal(err)
		}

		// Stage 2: the parent chart, exactly as level 0 renders it.
		out := helmTemplate(ctx, t, runner, root, parent, filepath.Join("charts", parent),
			"-f", filepath.ToSlash(filepath.Join("charts", parent, "values.yaml")), "-f", valuesFile)
		for chart, body := range valuesObjectsByChart(t, parent, fork, out) {
			file := filepath.Join(dir, "inherited-"+chart+".yaml")
			if err := os.WriteFile(file, body, 0o644); err != nil {
				t.Fatal(err)
			}
			inherited[chart] = file
		}
	}

	// Stage 3: each child chart, with its own values files and then the
	// inherited ones — the precedence ArgoCD applies (valuesObject wins).
	paths := map[string]string{}
	for _, k := range onePasswordPathKeys {
		if _, done := paths[k.chart+"/"+k.item]; done {
			continue
		}
		file, ok := inherited[k.chart]
		if !ok {
			t.Errorf("%s: Application for charts/%s in the %s render has no helm.valuesObject, so %s cannot reach it",
				fork, k.chart, k.parent, k.key)
			continue
		}
		args := []string{}
		for _, f := range ValuesFiles(root, Chart{Name: k.chart, Path: filepath.Join("charts", k.chart)}, "homelab") {
			args = append(args, "-f", f)
		}
		args = append(args, "-f", file)
		out := helmTemplate(ctx, t, runner, root, k.chart, filepath.Join("charts", k.chart), args...)
		docs, err := ParseMultiDoc(k.chart, fork, out)
		if err != nil {
			t.Fatalf("%s: parsing the %s render: %v", fork, k.chart, err)
		}
		for _, d := range docs {
			if d.Kind() == "OnePasswordItem" {
				paths[k.chart+"/"+d.Name()] = d.GetString("spec", "itemPath")
			}
		}
	}
	return paths
}

// resolveForkConfig is resolveEnvConfig for the homelab example ConfigSet with
// one extra layer on top, standing in for a fork's environments/homelab.yaml.
func resolveForkConfig(t *testing.T, root string, overrides map[string]string) *config.ResolvedConfig {
	t.Helper()
	configRoot := filepath.Join(root, "configuration")
	schema, err := config.LoadSchemaDir(filepath.Join(configRoot, "schema"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}
	versions, err := config.LoadVersions(filepath.Join(configRoot, "versions.yaml"))
	if err != nil {
		t.Fatalf("loading versions: %v", err)
	}
	defaults, err := config.LoadEnvironment(filepath.Join(configRoot, "environments", "defaults.yaml"))
	if err != nil {
		t.Fatalf("loading defaults: %v", err)
	}
	example, err := config.LoadEnvironment(filepath.Join(configRoot, "environments", "homelab.yaml.example"))
	if err != nil {
		t.Fatalf("loading the homelab example: %v", err)
	}
	rc, err := config.Eval(schema, versions, "homelab", defaults, example, overrides)
	if err != nil {
		t.Fatalf("eval: %v", err)
	}
	for key, want := range overrides {
		if rc.Values[key].Value != want {
			t.Fatalf("%s resolved to %q, want the override %q", key, rc.Values[key].Value, want)
		}
	}
	return rc
}

// valuesObjectsByChart extracts helm.valuesObject from every Application in a
// rendered parent, keyed by the chart directory its source path names.
func valuesObjectsByChart(t *testing.T, parent, fork string, out []byte) map[string][]byte {
	t.Helper()
	docs, err := ParseMultiDoc(parent, fork, out)
	if err != nil {
		t.Fatalf("%s: parsing the %s render: %v", fork, parent, err)
	}
	byChart := map[string][]byte{}
	for _, d := range docs {
		if !isApplication(d) {
			continue
		}
		for _, src := range appSources(d) {
			chart, ok := chartNameFromPath(src.GetString("path"))
			if !ok {
				continue
			}
			vo, ok := src.Get("helm", "valuesObject")
			if !ok {
				continue
			}
			body, err := yaml.Marshal(vo)
			if err != nil {
				t.Fatalf("%s: marshalling the helm.valuesObject of Application %s: %v", fork, d.Name(), err)
			}
			byChart[chart] = body
		}
	}
	return byChart
}

func helmTemplate(ctx context.Context, t *testing.T, runner ExecRunner, root, release, chartPath string, args ...string) []byte {
	t.Helper()
	argv := append([]string{"template", release, chartPath, "--include-crds"}, args...)
	stdout, stderr, err := runner.Run(ctx, root, "helm", argv...)
	if err != nil {
		t.Fatalf("helm template %s: %v\n%s", chartPath, err, stderr)
	}
	return stdout
}
