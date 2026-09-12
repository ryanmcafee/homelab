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

func TestIsShimMissing(t *testing.T) {
	tests := []struct {
		name   string
		stderr string
		want   bool
	}{
		{
			name:   "mise shim with no version set",
			stderr: "mise ERROR No version is set for shim: pluto\nmise use -g pluto@5.24.3\n",
			want:   true,
		},
		{
			name:   "mise reports the version is not installed",
			stderr: "mise ERROR conftest@0.56.0 is not installed\n",
			want:   true,
		},
		{
			name:   "asdf shim with no version set",
			stderr: "No version set for command kubeconform\n",
			want:   true,
		},
		{
			name:   "asdf reports the version is not installed",
			stderr: "version is not installed for helm\n",
			want:   true,
		},
		{
			name:   "a genuine helm template failure",
			stderr: "Error: template: addons/templates/app.yaml:3:12: nil pointer evaluating interface {}.repoURL\n",
			want:   false,
		},
		{
			name:   "a genuine kubeconform failure",
			stderr: "failed opening cache folder /tmp/x: no such file or directory\n",
			want:   false,
		},
		{
			name:   "empty stderr",
			stderr: "",
			want:   false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isShimMissing([]byte(tc.stderr)); got != tc.want {
				t.Errorf("isShimMissing(%q) = %v, want %v", tc.stderr, got, tc.want)
			}
		})
	}
}
