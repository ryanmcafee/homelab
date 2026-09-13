package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// prodOpts returns ProdOptions with an existing kubeconfig file so the
// pre-flight check passes and kubectl (the fake) is reached.
func prodOpts(t *testing.T, r Runner) ProdOptions {
	t.Helper()
	kubeconfig := filepath.Join(t.TempDir(), "homelab-readonly.yaml")
	if err := os.WriteFile(kubeconfig, []byte("apiVersion: v1\nkind: Config\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return ProdOptions{
		Runner:         r,
		Dir:            t.TempDir(),
		Kubeconfig:     kubeconfig,
		KubeContext:    ProdKubeContext,
		RequestTimeout: "30s",
	}
}

func TestProdArgoCDApps(t *testing.T) {
	r := &fakeClusterRunner{getStdout: argoAppsJSON}
	opts := prodOpts(t, r)
	checks := ProdArgoCDApps(context.Background(), opts)

	if len(checks) != 3 {
		t.Fatalf("want 3 checks (one per Application), got %d: %+v", len(checks), checks)
	}
	for _, c := range checks {
		if !strings.HasPrefix(c.Name, "prod/argocd/") {
			t.Errorf("check %q must be named prod/argocd/<app>", c.Name)
		}
	}

	if c := clusterCheck(t, checks, "prod/argocd/cilium"); c.Status != StatusPass {
		t.Errorf("cilium: want pass, got %s (%v)", c.Status, c.Findings)
	}
	if c := clusterCheck(t, checks, "prod/argocd/plex"); c.Status != StatusFail {
		t.Errorf("plex: want fail, got %s", c.Status)
	}

	// The never-synced finding must not send a production reader to the Kind
	// loop.
	sonarr := clusterCheck(t, checks, "prod/argocd/sonarr")
	if sonarr.Status != StatusFail {
		t.Errorf("sonarr: want fail without an operation, got %s", sonarr.Status)
	}
	joined := strings.Join(sonarr.Findings, "\n")
	if !strings.Contains(joined, "no sync operation recorded") {
		t.Errorf("sonarr findings should say no operation was recorded, got %q", sonarr.Findings)
	}
	if strings.Contains(joined, "localdev") {
		t.Errorf("production findings must not mention the localdev loop, got %q", sonarr.Findings)
	}

	cmds := r.invocations("kubectl")
	if len(cmds) != 1 {
		t.Fatalf("want exactly 1 kubectl invocation, got %d", len(cmds))
	}
	want := fmt.Sprintf("kubectl --kubeconfig %s --context homelab-readonly --request-timeout 30s get applications.argoproj.io -n argocd -o json", opts.Kubeconfig)
	if got := cmds[0].line(); got != want {
		t.Errorf("argv:\n got %s\nwant %s", got, want)
	}
}

// TestProdKubectlArgsAreReadOnly pins the only verb verify prod ever sends.
func TestProdKubectlArgsAreReadOnly(t *testing.T) {
	tests := []struct {
		name string
		opts ProdOptions
		want string
	}{
		{
			name: "every flag",
			opts: ProdOptions{Kubeconfig: "/k/c.yaml", KubeContext: "homelab-readonly", RequestTimeout: "10s"},
			want: "--kubeconfig /k/c.yaml --context homelab-readonly --request-timeout 10s get applications.argoproj.io -n argocd -o json",
		},
		{
			name: "no kubeconfig and no timeout fall back to kubectl defaults",
			opts: ProdOptions{KubeContext: "homelab-readonly"},
			want: "--context homelab-readonly get applications.argoproj.io -n argocd -o json",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			args := ProdKubectlArgs(tc.opts)
			if got := strings.Join(args, " "); got != tc.want {
				t.Errorf("args:\n got %s\nwant %s", got, tc.want)
			}
			for _, verb := range []string{"apply", "create", "delete", "patch", "edit", "replace", "annotate", "label", "scale"} {
				for _, a := range args {
					if a == verb {
						t.Errorf("verify prod must never send %q to production: %v", verb, args)
					}
				}
			}
		})
	}
}

const prodOutOfSyncJSON = `{"items":[{"metadata":{"name":"traefik"},"status":{"sync":{"status":"OutOfSync"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}}]}`

func TestProdArgoCDAppsRequireSynced(t *testing.T) {
	tests := []struct {
		name          string
		requireSynced bool
		wantStatus    Status
		wantFinding   string
	}{
		{name: "healthy and succeeded passes by default even when OutOfSync", requireSynced: false, wantStatus: StatusPass},
		{name: "require-synced fails an OutOfSync app", requireSynced: true, wantStatus: StatusFail, wantFinding: "sync status OutOfSync (want Synced)"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeClusterRunner{getStdout: prodOutOfSyncJSON}
			opts := prodOpts(t, r)
			opts.RequireSynced = tc.requireSynced
			c := clusterCheck(t, ProdArgoCDApps(context.Background(), opts), "prod/argocd/traefik")
			if c.Status != tc.wantStatus {
				t.Fatalf("status = %s, want %s (%v)", c.Status, tc.wantStatus, c.Findings)
			}
			if tc.wantFinding != "" && !strings.Contains(strings.Join(c.Findings, "\n"), tc.wantFinding) {
				t.Errorf("findings %q do not contain %q", c.Findings, tc.wantFinding)
			}
		})
	}
}

func TestProdArgoCDAppsFailureModes(t *testing.T) {
	tests := []struct {
		name          string
		runner        *fakeClusterRunner
		noKubeconfig  bool
		wantDetail    string
		wantFinding   string
		wantNoKubectl bool
	}{
		{
			name:          "kubectl missing is a failure, not a skip",
			runner:        &fakeClusterRunner{missing: map[string]bool{"kubectl": true}},
			wantDetail:    "kubectl",
			wantNoKubectl: true,
		},
		{
			name:       "an unconfigured mise shim is a failure",
			runner:     &fakeClusterRunner{shimMissing: map[string]bool{"kubectl": true}},
			wantDetail: "kubectl",
		},
		{
			name:          "a missing read-only kubeconfig fails before kubectl runs",
			runner:        &fakeClusterRunner{getStdout: argoAppsJSON},
			noKubeconfig:  true,
			wantDetail:    "does not exist",
			wantFinding:   "task prod:kubeconfig",
			wantNoKubectl: true,
		},
		{
			name:        "MagicDNS name that does not resolve reads as unreachable",
			runner:      &fakeClusterRunner{getStderr: "Unable to connect to the server: dial tcp: lookup tailscale-operator-homelab.tail0.ts.net: no such host\n", getErr: fmt.Errorf("exit status 1")},
			wantDetail:  "unreachable via kube context homelab-readonly",
			wantFinding: "Tailscale",
		},
		{
			name:        "a proxy that never answers reads as unreachable",
			runner:      &fakeClusterRunner{getStderr: "Unable to connect to the server: dial tcp 100.64.0.9:443: i/o timeout\n", getErr: fmt.Errorf("exit status 1")},
			wantDetail:  "unreachable",
			wantFinding: "task prod:kubeconfig",
		},
		{
			name:        "a missing context reads as not set up",
			runner:      &fakeClusterRunner{getStderr: "error: context \"homelab-readonly\" does not exist\n", getErr: fmt.Errorf("exit status 1")},
			wantDetail:  "unreachable",
			wantFinding: "task prod:kubeconfig",
		},
		{
			name:        "a revoked token is Unauthorized",
			runner:      &fakeClusterRunner{getStderr: "error: You must be logged in to the server (Unauthorized)\n", getErr: fmt.Errorf("exit status 1")},
			wantDetail:  "rejected the agent-readonly token",
			wantFinding: "op://homelab/k8s-agent-readonly/credential",
		},
		{
			name:        "missing RBAC is Forbidden",
			runner:      &fakeClusterRunner{getStderr: "Error from server (Forbidden): applications.argoproj.io is forbidden: User \"system:serviceaccount:agent-access:agent-readonly\" cannot list resource \"applications\"\n", getErr: fmt.Errorf("exit status 1")},
			wantDetail:  "RBAC denied",
			wantFinding: "charts/agent-readonly",
		},
		{
			name:       "any other kubectl error",
			runner:     &fakeClusterRunner{getStderr: "error: something odd\n", getErr: fmt.Errorf("exit status 1")},
			wantDetail: "kubectl get applications failed",
		},
		{
			name:       "unparseable output",
			runner:     &fakeClusterRunner{getStdout: "not json"},
			wantDetail: "parsing kubectl get applications output",
		},
		{
			name:       "zero Applications",
			runner:     &fakeClusterRunner{getStdout: `{"items":[]}`},
			wantDetail: "no Applications in namespace argocd",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts := prodOpts(t, tc.runner)
			if tc.noKubeconfig {
				opts.Kubeconfig = filepath.Join(t.TempDir(), "absent.yaml")
			}
			checks := ProdArgoCDApps(context.Background(), opts)
			if len(checks) != 1 {
				t.Fatalf("want a single check, got %d: %+v", len(checks), checks)
			}
			c := checks[0]
			if c.Name != "prod/argocd/apps" {
				t.Errorf("name = %q, want prod/argocd/apps", c.Name)
			}
			if c.Status != StatusFail {
				t.Errorf("status = %s, want fail (an unanswered production check must never pass)", c.Status)
			}
			if !strings.Contains(c.Detail, tc.wantDetail) {
				t.Errorf("detail %q does not contain %q", c.Detail, tc.wantDetail)
			}
			if tc.wantFinding != "" && !strings.Contains(strings.Join(c.Findings, "\n"), tc.wantFinding) {
				t.Errorf("findings %q do not contain %q", c.Findings, tc.wantFinding)
			}
			if tc.wantNoKubectl && len(tc.runner.invocations("kubectl")) != 0 {
				t.Errorf("kubectl must not run, got %d invocation(s)", len(tc.runner.invocations("kubectl")))
			}
		})
	}
}
