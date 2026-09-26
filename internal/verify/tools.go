package verify

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/ryanmcafee/homelab/internal/config"
)

// Runner abstracts external tool execution (helm, kubeconform, pluto,
// conftest) so checks can be unit-tested with a fake.
type Runner interface {
	// Run executes name with args in dir and returns stdout, stderr and the
	// exec error (non-zero exit is returned as an error; stderr is still filled).
	Run(ctx context.Context, dir string, name string, args ...string) (stdout, stderr []byte, err error)
	// LookPath resolves a binary on PATH.
	LookPath(name string) (string, error)
}

// ExecRunner runs real processes.
type ExecRunner struct{}

// Run implements Runner.
func (ExecRunner) Run(ctx context.Context, dir string, name string, args ...string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	return out.Bytes(), errb.Bytes(), err
}

// LookPath implements Runner.
func (ExecRunner) LookPath(name string) (string, error) { return exec.LookPath(name) }

// ToolMissingDetail is the standard detail for a missing binary.
func ToolMissingDetail(tool string) string {
	return fmt.Sprintf("%s not found on PATH; install with `mise install` (see mise.toml)", tool)
}

// shimMissingMarkers are phrases only a version manager emits, so each
// identifies a missing tool on its own.
var shimMissingMarkers = []string{
	// mise puts a shim on PATH for every tool it knows about.
	"No version is set for shim",
	// asdf uses the same shim model.
	"No version set for command",
}

// shimAmbiguousMarkers could equally come from the tool itself. A Helm chart
// using `fail` or `required` can print "cert-manager is not installed", which
// must stay a template failure carrying its real stderr rather than being
// rewritten as a missing binary. These count only alongside a manager name.
var shimAmbiguousMarkers = []string{
	"is not installed",
	"version is not installed",
}

// versionManagerNames identify the version manager in its own error output.
var versionManagerNames = []string{"mise", "asdf"}

// isShimMissing reports whether a tool's stderr says a version-manager shim
// resolved but the tool itself is not installed.
//
// Every external tool the level-0 checks invoke (helm, kubeconform, pluto,
// conftest) is managed by mise, which shims tools it knows about whether or
// not a version is installed. LookPath therefore succeeds and the miss only
// surfaces as a non-zero exit carrying a version-manager error on stderr.
// Consult this wherever a tool exits non-zero, so a missing tool reports the
// standard install hint instead of an opaque exit status.
func isShimMissing(stderr []byte) bool {
	s := string(stderr)
	for _, marker := range shimMissingMarkers {
		if strings.Contains(s, marker) {
			return true
		}
	}
	// An ambiguous phrase needs corroboration from the manager's own name,
	// otherwise a chart's "X is not installed" message would be swallowed.
	lower := strings.ToLower(s)
	named := false
	for _, manager := range versionManagerNames {
		if strings.Contains(lower, manager) {
			named = true
			break
		}
	}
	if !named {
		return false
	}
	for _, marker := range shimAmbiguousMarkers {
		if strings.Contains(s, marker) {
			return true
		}
	}
	return false
}

// KubernetesVersion returns tools.kubernetes from configuration/versions.yaml
// without the leading "v" (e.g. "1.36.1"). This is the single source of truth
// for kubeconform and pluto target versions.
func KubernetesVersion(repoRoot string) (string, error) {
	v, err := config.LoadVersions(filepath.Join(repoRoot, "configuration", "versions.yaml"))
	if err != nil {
		return "", err
	}
	k, ok := v.Tools["kubernetes"]
	if !ok || strings.TrimSpace(k) == "" {
		return "", fmt.Errorf("configuration/versions.yaml: tools.kubernetes is not set")
	}
	return strings.TrimPrefix(strings.TrimSpace(k), "v"), nil
}

// SchemaVersion returns the X.Y.0 kubeconform schema set for k8sVersion; patch releases never change the API.
func SchemaVersion(k8sVersion string) string {
	parts := strings.Split(k8sVersion, ".")
	if len(parts) != 3 {
		return k8sVersion
	}
	return parts[0] + "." + parts[1] + ".0"
}

// DefaultCacheDir returns the kubeconform schema cache directory.
func DefaultCacheDir(repoRoot string) string {
	if x := os.Getenv("XDG_CACHE_HOME"); x != "" {
		return filepath.Join(x, "homelab-kubeconform")
	}
	if h, err := os.UserHomeDir(); err == nil {
		return filepath.Join(h, ".cache", "homelab-kubeconform")
	}
	return filepath.Join(repoRoot, ".cache", "kubeconform")
}
