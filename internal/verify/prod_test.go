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

	// One check per Application plus prod/argocd/domain.
	if len(checks) != 4 {
		t.Fatalf("want 4 checks (one per Application + the domain check), got %d: %+v", len(checks), checks)
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

const prodOutOfSyncJSON = `{"items":[{"metadata":{"name":"envoy-gateway"},"status":{"sync":{"status":"OutOfSync"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}}]}`

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
			c := clusterCheck(t, ProdArgoCDApps(context.Background(), opts), "prod/argocd/envoy-gateway")
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

// Fixtures for prod/argocd/domain: the root gitops Application either carries
// the Terraform-injected global.domain helm parameter or it does not, in which
// case the chart placeholder example.com reaches the bootstrap and argocd
// Applications (what happened after PR #265 until the module was applied).
const (
	prodRootWithDomainJSON = `{"items":[
  {"metadata":{"name":"gitops"},"spec":{"source":{"path":"charts/gitops","helm":{"valueFiles":["values.yaml","values-homelab.yaml"],"parameters":[{"name":"global.domain","value":"REPLACEME-domain.com"}]}}},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}},
  {"metadata":{"name":"bootstrap"},"spec":{"source":{"path":"charts/bootstrap","helm":{"valuesObject":{"argocd":{"values":{"server":{"ingress":{"hostname":"argocd.REPLACEME-domain.com"}}}}}}}},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}},
  {"metadata":{"name":"argocd"},"spec":{"source":{"chart":"argo-cd","helm":{"values":"server:\n  ingress:\n    hostname: argocd.REPLACEME-domain.com\n"}}},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}}
]}`

	prodRootWithoutDomainJSON = `{"items":[
  {"metadata":{"name":"gitops"},"spec":{"source":{"path":"charts/gitops","helm":{"valueFiles":["values.yaml","values-homelab.yaml"]}}},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}},
  {"metadata":{"name":"bootstrap"},"spec":{"source":{"path":"charts/bootstrap","helm":{"valuesObject":{"argocd":{"values":{"server":{"ingress":{"hostname":"argocd.example.com"}}}}}}}},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}},
  {"metadata":{"name":"argocd"},"spec":{"source":{"chart":"argo-cd","helm":{"values":"notifications:\n  argocdUrl: https://argocd.example.com\nserver:\n  ingress:\n    hostname: argocd.example.com\n"}}},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}},
  {"metadata":{"name":"addons"},"spec":{"source":{"path":"charts/addons","plugin":{"name":"homelab-config-helm-v1.0"}}},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}}
]}`

	prodRootPlaceholderParameterJSON = `{"items":[
  {"metadata":{"name":"gitops"},"spec":{"source":{"path":"charts/gitops","helm":{"parameters":[{"name":"global.domain","value":"example.com"}]}}},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}}
]}`

	prodMultiSourceRootJSON = `{"items":[
  {"metadata":{"name":"gitops"},"spec":{"sources":[{"path":"charts/gitops","helm":{"parameters":[{"name":"global.domain","value":"REPLACEME-domain.com"}]}}]},
   "status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"},"operationState":{"phase":"Succeeded"}}}
]}`
)

func TestProdArgoCDDomain(t *testing.T) {
	tests := []struct {
		name         string
		stdout       string
		wantStatus   Status
		wantFindings []string
		notFindings  []string
	}{
		{
			name:       "root carries global.domain and no Application embeds the placeholder",
			stdout:     prodRootWithDomainJSON,
			wantStatus: StatusPass,
		},
		{
			name:       "spec.sources (multi-source root) is read too",
			stdout:     prodMultiSourceRootJSON,
			wantStatus: StatusPass,
		},
		{
			name:       "root without the parameter fails and names every Application the placeholder reached",
			stdout:     prodRootWithoutDomainJSON,
			wantStatus: StatusFail,
			wantFindings: []string{
				"root Application gitops has no helm parameter global.domain",
				"bootstrap: spec.source.helm.valuesObject contains example.com",
				"argocd: spec.source.helm.values contains example.com",
				"task tf:apply:component COMPONENT=gitops-bootstrap",
			},
			notFindings: []string{"addons:"},
		},
		{
			name:         "a parameter set to the placeholder is as bad as none",
			stdout:       prodRootPlaceholderParameterJSON,
			wantStatus:   StatusFail,
			wantFindings: []string{"global.domain is the placeholder example.com"},
		},
		{
			name:         "no root Application is a failure, not a pass",
			stdout:       argoAppsJSON,
			wantStatus:   StatusFail,
			wantFindings: []string{"root Application gitops not found"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := &fakeClusterRunner{getStdout: tc.stdout}
			checks := ProdArgoCDApps(context.Background(), prodOpts(t, r))
			c := clusterCheck(t, checks, ProdDomainCheck)
			if c.Status != tc.wantStatus {
				t.Fatalf("status = %s, want %s (detail %q, findings %v)", c.Status, tc.wantStatus, c.Detail, c.Findings)
			}
			// Detail names the failure; findings carry the evidence and the hint.
			joined := c.Detail + "\n" + strings.Join(c.Findings, "\n")
			for _, want := range tc.wantFindings {
				if !strings.Contains(joined, want) {
					t.Errorf("findings lack %q:\n%s", want, joined)
				}
			}
			for _, not := range tc.notFindings {
				if strings.Contains(joined, not) {
					t.Errorf("findings must not mention %q:\n%s", not, joined)
				}
			}
			// One read only: the domain check reuses the Applications list.
			if cmds := r.invocations("kubectl"); len(cmds) != 1 {
				t.Errorf("want exactly 1 kubectl invocation, got %d", len(cmds))
			}
		})
	}
}
