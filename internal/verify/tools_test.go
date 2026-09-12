package verify

import (
	"os"
	"path/filepath"
	"testing"
)

func TestKubernetesVersionStripsPrefix(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "configuration"), 0o755)
	os.WriteFile(filepath.Join(root, "configuration", "versions.yaml"), []byte("charts: {}\nimages: {}\ntools:\n  kubernetes: \"v1.36.1\"\n"), 0o644)
	got, err := KubernetesVersion(root)
	if err != nil {
		t.Fatal(err)
	}
	if got != "1.36.1" {
		t.Fatalf("want 1.36.1, got %q", got)
	}
}

func TestKubernetesVersionMissingIsError(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "configuration"), 0o755)
	os.WriteFile(filepath.Join(root, "configuration", "versions.yaml"), []byte("charts: {}\ntools: {}\n"), 0o644)
	if _, err := KubernetesVersion(root); err == nil {
		t.Fatal("expected error when tools.kubernetes missing")
	}
}
