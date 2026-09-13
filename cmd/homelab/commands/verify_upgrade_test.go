package commands

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/verify"
)

func TestVerifyUpgradeUsageErrors(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		wantMsg string
	}{
		{"--base is required", []string{"verify", "upgrade"}, "--base is required"},
		{"unknown flag", []string{"verify", "upgrade", "--base", "HEAD", "--bogus"}, "unknown flag: --bogus"},
		{"positional argument", []string{"verify", "upgrade", "--base", "HEAD", "extra"}, "unexpected argument"},
		{"zero diff lines", []string{"verify", "upgrade", "--base", "HEAD", "--max-diff-lines", "0"}, "--max-diff-lines"},
		{"negative parallelism", []string{"verify", "upgrade", "--base", "HEAD", "--parallel", "-1"}, "--parallel"},
		{"unknown environment", []string{"verify", "upgrade", "--base", "HEAD", "--env", "nope"}, "unknown environment"},
		{"option-like base", []string{"verify", "upgrade", "--base=--output=x"}, "invalid base ref"},
		{"unknown base ref", []string{"verify", "upgrade", "--base", "refs/heads/no-such-branch-for-upgrade-test"}, "does not resolve to a commit"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err, _ := runVerifySubcommand(t, tc.args...)
			if err == nil {
				t.Fatalf("expected an error for %v", tc.args)
			}
			if got := ExitCode(err); got != ExitUsage {
				t.Errorf("ExitCode = %d, want %d (err: %v)", got, ExitUsage, err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.wantMsg)
			}
		})
	}
}

// stubUpgradeRunner resolves every ref, creates/removes the worktree dir and
// answers helm template from a map keyed by "<chart ref>@<version>".
type stubUpgradeRunner struct {
	manifests map[string]string
}

func (stubUpgradeRunner) LookPath(name string) (string, error) { return "/stub/" + name, nil }

func (s stubUpgradeRunner) Run(_ context.Context, _ string, name string, args ...string) ([]byte, []byte, error) {
	switch {
	case name == "git" && args[0] == "rev-parse":
		return []byte("1111111111111111111111111111111111111111\n"), nil, nil
	case name == "git" && args[0] == "worktree" && args[1] == "add":
		return nil, nil, os.MkdirAll(args[3], 0o755)
	case name == "git" && args[0] == "worktree" && args[1] == "remove":
		return nil, nil, os.RemoveAll(args[2])
	case name == "helm":
		version := ""
		for i, a := range args {
			if a == "--version" && i+1 < len(args) {
				version = args[i+1]
			}
		}
		if m, ok := s.manifests[args[2]+"@"+version]; ok {
			return []byte(m), nil, nil
		}
		return nil, []byte("Error: not found"), fmt.Errorf("exit status 1")
	}
	return nil, nil, nil
}

func stubApp(version string) string {
	return fmt.Sprintf(`apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: radarr
  namespace: argocd
spec:
  source:
    repoURL: oci.trueforge.org/truecharts
    chart: radarr
    targetRevision: %s
  destination:
    namespace: media
`, version)
}

// stubRender renders base (RepoRoot ends in /base) at 1.0.0 and head at headVersion.
func stubRender(headVersion string) func(context.Context, verify.RenderOptions) (*verify.RenderOutput, *verify.Result) {
	return func(_ context.Context, o verify.RenderOptions) (*verify.RenderOutput, *verify.Result) {
		version := headVersion
		if filepath.Base(o.RepoRoot) == "base" {
			version = "1.0.0"
		}
		out := &verify.RenderOutput{Dir: o.OutDir, Envs: o.Envs, Files: map[string]map[string]string{}}
		for _, env := range o.Envs {
			p := verify.RenderedFile(o.OutDir, env.Name, "applications")
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.WriteFile(p, []byte(stubApp(version)), 0o644)
			out.Files[env.Name] = map[string]string{"applications": p}
		}
		return out, verify.NewResult(0)
	}
}

func TestVerifyUpgradeRunsAndWritesReport(t *testing.T) {
	deploy := func(image string) string {
		return "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: radarr\nspec:\n  image: " + image + "\n"
	}
	runner := stubUpgradeRunner{manifests: map[string]string{
		"oci://oci.trueforge.org/truecharts/radarr@1.0.0": deploy("radarr:1"),
		"oci://oci.trueforge.org/truecharts/radarr@1.0.1": deploy("radarr:2"),
	}}

	tests := []struct {
		name        string
		headVersion string
		wantCode    int
		wantDetail  string
	}{
		{"a manifest diff passes and is reported", "1.0.1", ExitOK, "manifest diff: +1 -1 lines"},
		{"a head render failure exits 1", "9.9.9", ExitFailure, "helm template failed at head"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			origRunner, origRender := upgradeRunner, upgradeRender
			upgradeRunner, upgradeRender = runner, stubRender(tc.headVersion)
			t.Cleanup(func() { upgradeRunner, upgradeRender = origRunner, origRender })

			report := filepath.Join(t.TempDir(), "upgrade-report.md")
			err, printed := runVerifySubcommand(t, "verify", "upgrade", "--base", "origin/main", "--json", "--report", report)
			if got := ExitCode(err); got != tc.wantCode {
				t.Fatalf("ExitCode = %d, want %d (err: %v)\n%s", got, tc.wantCode, err, printed)
			}

			var res verify.Result
			if err := json.Unmarshal([]byte(printed), &res); err != nil {
				t.Fatalf("stdout is not the JSON contract: %v\n%s", err, printed)
			}
			var found bool
			for _, c := range res.Checks {
				if c.Name == "upgrade/homelab/radarr" {
					found = strings.HasPrefix(c.Detail, tc.wantDetail)
					if !found {
						t.Errorf("detail = %q, want prefix %q", c.Detail, tc.wantDetail)
					}
				}
			}
			if !found {
				t.Errorf("no upgrade/homelab/radarr check in %+v", res.Checks)
			}

			md, err := os.ReadFile(report)
			if err != nil {
				t.Fatalf("report not written: %v", err)
			}
			if !strings.Contains(string(md), "`upgrade/homelab/radarr`") {
				t.Errorf("report lacks the radarr row:\n%s", md)
			}
		})
	}
}
