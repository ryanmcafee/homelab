package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Chart is a Helm chart directory under charts/.
type Chart struct {
	// Name is the directory name (also the ArgoCD Application name for children).
	Name string
	// Path is the repo-relative path, e.g. "charts/tailscale-config".
	Path string
	// Parent is true for the app-of-apps charts (gitops, bootstrap, addons, applications).
	Parent bool
}

// ParentCharts are the app-of-apps charts. addons and applications are
// rendered two-stage (config export -> helm) for two-stage envs.
var ParentCharts = map[string]bool{"gitops": true, "bootstrap": true, "addons": true, "applications": true}

// TwoStageCharts are the parents whose homelab values come from the CMP.
var TwoStageCharts = map[string]string{"addons": "helm-addons", "applications": "helm-apps"}

// IsChildConfig reports whether the chart follows the *-config / *-dependencies pattern.
func (c Chart) IsChildConfig() bool {
	return strings.HasSuffix(c.Name, "-config") || strings.HasSuffix(c.Name, "-dependencies")
}

// DiscoverCharts lists every directory under <repoRoot>/charts containing a
// Chart.yaml, sorted by name. Directories without Chart.yaml (e.g. charts/secrets,
// a kustomize tree) are ignored.
func DiscoverCharts(repoRoot string) ([]Chart, error) {
	entries, err := os.ReadDir(filepath.Join(repoRoot, "charts"))
	if err != nil {
		return nil, fmt.Errorf("listing charts: %w", err)
	}
	var out []Chart
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(repoRoot, "charts", e.Name(), "Chart.yaml")); err != nil {
			continue
		}
		out = append(out, Chart{Name: e.Name(), Path: filepath.ToSlash(filepath.Join("charts", e.Name())), Parent: ParentCharts[e.Name()]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// ValuesFiles returns the repo-relative values files that exist for a chart in
// an env: values.yaml plus values-<env>.yaml when present.
func ValuesFiles(repoRoot string, c Chart, env string) []string {
	var out []string
	for _, f := range []string{"values.yaml", "values-" + env + ".yaml"} {
		if _, err := os.Stat(filepath.Join(repoRoot, c.Path, f)); err == nil {
			out = append(out, filepath.ToSlash(filepath.Join(c.Path, f)))
		}
	}
	return out
}

// FindRepoRoot walks up from dir until it finds Taskfile.yml.
func FindRepoRoot(dir string) (string, error) {
	for {
		if _, err := os.Stat(filepath.Join(dir, "Taskfile.yml")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("could not find project root (no Taskfile.yml found above %s)", dir)
		}
		dir = parent
	}
}
