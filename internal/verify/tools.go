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
