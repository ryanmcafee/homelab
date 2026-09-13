package commands

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/verify"
)

// fakeProdRunner answers the single kubectl read `verify prod` makes.
type fakeProdRunner struct {
	stdout string
	stderr string
	err    error
	calls  [][]string
}

func (f *fakeProdRunner) LookPath(name string) (string, error) { return "/fake/bin/" + name, nil }

func (f *fakeProdRunner) Run(_ context.Context, _ string, name string, args ...string) ([]byte, []byte, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
	return []byte(f.stdout), []byte(f.stderr), f.err
}

// useProdRunner swaps the package runner for the duration of a test.
func useProdRunner(t *testing.T, r verify.Runner) {
	t.Helper()
	prev := prodRunner
	prodRunner = r
	t.Cleanup(func() { prodRunner = prev })
}

// readonlyKubeconfig creates an (empty) kubeconfig so the pre-flight passes.
func readonlyKubeconfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "homelab-readonly.yaml")
	if err := os.WriteFile(path, []byte("apiVersion: v1\nkind: Config\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestVerifyProdUsageErrors(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		wantMsg string
	}{
		{
			name:    "a Kind context is refused",
			args:    []string{"verify", "prod", "--kube-context", "kind-homelab-localdev"},
			wantMsg: "is a Kind cluster",
		},
		{
			name:    "an empty context is refused",
			args:    []string{"verify", "prod", "--kube-context", " "},
			wantMsg: "--kube-context is required",
		},
		{
			name:    "a bad request timeout",
			args:    []string{"verify", "prod", "--request-timeout", "soon"},
			wantMsg: "--request-timeout",
		},
		{
			name:    "a zero request timeout",
			args:    []string{"verify", "prod", "--request-timeout", "0s"},
			wantMsg: "--request-timeout",
		},
		{
			name:    "an unknown flag",
			args:    []string{"verify", "prod", "--apply"},
			wantMsg: "unknown flag: --apply",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeProdRunner{}
			useProdRunner(t, fake)
			err, _ := runVerifySubcommand(t, tc.args...)
			if err == nil {
				t.Fatalf("%v must fail", tc.args)
			}
			if got := ExitCode(err); got != ExitUsage {
				t.Errorf("ExitCode = %d, want %d (err: %v)", got, ExitUsage, err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.wantMsg)
			}
			if len(fake.calls) != 0 {
				t.Errorf("a usage error must not reach kubectl, got %v", fake.calls)
			}
		})
	}
}

func TestVerifyProdResult(t *testing.T) {
	// The root gitops Application must carry global.domain (prod/argocd/domain).
	const healthy = `{"items":[{"metadata":{"name":"gitops"},"spec":{"source":{"helm":{"parameters":[{"name":"global.domain","value":"REPLACEME-domain.com"}]}}},"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}},{"metadata":{"name":"cilium"},"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}}]}`
	const degraded = `{"items":[{"metadata":{"name":"plex"},"status":{"sync":{"status":"Synced"},"health":{"status":"Degraded"},"operationState":{"phase":"Succeeded"}}}]}`

	tests := []struct {
		name      string
		runner    *fakeProdRunner
		wantCode  int
		wantCheck string
		wantPass  bool
	}{
		{name: "every Application healthy exits 0", runner: &fakeProdRunner{stdout: healthy}, wantCode: ExitOK, wantCheck: "prod/argocd/cilium", wantPass: true},
		{name: "a degraded Application exits 1", runner: &fakeProdRunner{stdout: degraded}, wantCode: ExitFailure, wantCheck: "prod/argocd/plex"},
		{
			name:      "an unreachable proxy exits 1",
			runner:    &fakeProdRunner{stderr: "Unable to connect to the server: dial tcp: i/o timeout\n", err: errors.New("exit status 1")},
			wantCode:  ExitFailure,
			wantCheck: "prod/argocd/apps",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			useProdRunner(t, tc.runner)
			kubeconfig := readonlyKubeconfig(t)
			err, printed := runVerifySubcommand(t, "verify", "prod", "--json", "--kubeconfig", kubeconfig)
			if got := ExitCode(err); got != tc.wantCode {
				t.Fatalf("ExitCode = %d, want %d (err: %v)\n%s", got, tc.wantCode, err, printed)
			}
			if tc.wantCode == ExitFailure && !errors.Is(err, ErrVerificationFailed) {
				t.Errorf("a failing check must return ErrVerificationFailed, got %v", err)
			}

			var result verify.Result
			if err := json.Unmarshal([]byte(printed), &result); err != nil {
				t.Fatalf("--json output is not the result contract: %v\n%s", err, printed)
			}
			if result.Level != 2 {
				t.Errorf("level = %d, want 2", result.Level)
			}
			if result.Pass != tc.wantPass {
				t.Errorf("pass = %v, want %v", result.Pass, tc.wantPass)
			}
			found := false
			for _, c := range result.Checks {
				found = found || c.Name == tc.wantCheck
			}
			if !found {
				t.Errorf("no check %q in %+v", tc.wantCheck, result.Checks)
			}

			if len(tc.runner.calls) != 1 {
				t.Fatalf("want one kubectl call, got %v", tc.runner.calls)
			}
			got := strings.Join(tc.runner.calls[0], " ")
			want := "kubectl --kubeconfig " + kubeconfig + " --context homelab-readonly --request-timeout 30s get applications.argoproj.io -n argocd -o json"
			if got != want {
				t.Errorf("argv:\n got %s\nwant %s", got, want)
			}
		})
	}
}

func TestVerifyProdHelpDescribesTheContract(t *testing.T) {
	err, printed := runVerifySubcommand(t, "verify", "prod", "--help")
	if err != nil {
		t.Fatalf("--help must not error, got %v", err)
	}
	for _, want := range []string{
		"homelab-readonly", "prod/argocd/", "--kube-context", "--kubeconfig",
		"--require-synced", "readonly-access.md", "never mutates", "verify all --level 2",
	} {
		if !strings.Contains(printed, want) {
			t.Errorf("verify prod --help does not mention %q:\n%s", want, printed)
		}
	}
}
