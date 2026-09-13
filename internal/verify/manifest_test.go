package verify

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseMultiDocSkipsEmptyAndExtractsMetadata(t *testing.T) {
	data := []byte("---\n# comment only\n---\napiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: a\n  namespace: argocd\n  annotations:\n    argocd.argoproj.io/sync-wave: \"2\"\nspec:\n  source:\n    path: charts/x\n---\n")
	docs, err := ParseMultiDoc("gitops", "homelab", data)
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 1 {
		t.Fatalf("want 1 doc, got %d", len(docs))
	}
	d := docs[0]
	if d.Kind() != "Application" || d.Group() != "argoproj.io" || d.Name() != "a" || d.Namespace() != "argocd" {
		t.Errorf("unexpected metadata: %s %s %s", d.Kind(), d.Group(), d.ID())
	}
	if d.Annotations()["argocd.argoproj.io/sync-wave"] != "2" {
		t.Errorf("annotation lost: %v", d.Annotations())
	}
	if d.GetString("spec", "source", "path") != "charts/x" {
		t.Errorf("GetString path failed")
	}
	if d.Chart != "gitops" || d.Env != "homelab" {
		t.Errorf("provenance lost")
	}
}

func TestParseMultiDocReportsInvalidYAML(t *testing.T) {
	if _, err := ParseMultiDoc("c", "e", []byte("a: [b\n")); err == nil {
		t.Fatal("expected error for invalid yaml")
	}
}

func TestLoadRenderDirSkipsMetadataFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "homelab"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(RenderedFile(dir, "homelab", "addons"), []byte("kind: Namespace\napiVersion: v1\nmetadata:\n  name: x\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "homelab", "_data.yaml"), []byte("domain: example.com\n"), 0o644)
	got, err := LoadRenderDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got["homelab"]) != 1 || len(got["homelab"]["addons"]) != 1 {
		t.Fatalf("unexpected load result: %+v", got)
	}
}

func TestDiscoverChartsFindsRealCharts(t *testing.T) {
	root, err := FindRepoRoot(mustGetwd(t))
	if err != nil {
		t.Skip("not in repo")
	}
	charts, err := DiscoverCharts(root)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]Chart{}
	for _, c := range charts {
		names[c.Name] = c
	}
	for _, want := range []string{"gitops", "bootstrap", "addons", "applications", "tailscale-config"} {
		if _, ok := names[want]; !ok {
			t.Errorf("chart %s not discovered", want)
		}
	}
	if _, ok := names["secrets"]; ok {
		t.Errorf("charts/secrets has no Chart.yaml and must be skipped")
	}
	if !names["addons"].Parent || names["tailscale-config"].Parent {
		t.Errorf("parent classification wrong")
	}
	if !names["tailscale-config"].IsChildConfig() {
		t.Errorf("tailscale-config should be a child config chart")
	}
}

func TestResultAggregation(t *testing.T) {
	r := NewResult(0)
	r.Add(Check{Name: "b", Status: StatusPass}, Check{Name: "a", Status: StatusFail, Findings: []string{"x"}})
	if r.Pass {
		t.Fatal("result with a failing check must not pass")
	}
	r.Finalize(timeNow())
	if r.Checks[0].Name != "a" {
		t.Fatal("checks must be sorted by name")
	}
	if _, err := r.JSON(); err != nil {
		t.Fatal(err)
	}
}

func mustGetwd(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	return wd
}
