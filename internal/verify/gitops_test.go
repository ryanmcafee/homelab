package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mustDocs parses an in-memory rendered chart or fails the test.
func mustDocs(t *testing.T, chart, env, src string) []Doc {
	t.Helper()
	docs, err := ParseMultiDoc(chart, env, []byte(src))
	if err != nil {
		t.Fatalf("parsing %s/%s: %v", env, chart, err)
	}
	return docs
}

// checksByRule maps "gitops/<env>/<rule>" checks to their rule id.
func checksByRule(t *testing.T, checks []Check) map[string]Check {
	t.Helper()
	out := map[string]Check{}
	for _, c := range checks {
		parts := strings.Split(c.Name, "/")
		if len(parts) != 3 || parts[0] != "gitops" {
			t.Fatalf("check name %q does not match gitops/<env>/<rule>", c.Name)
		}
		if _, dup := out[parts[2]]; dup {
			t.Fatalf("duplicate check for rule %q", parts[2])
		}
		out[parts[2]] = c
	}
	return out
}

// testRepoRoot creates a repo root containing the given chart directories,
// each with a values.yaml, so the paths rule has something real to stat.
func testRepoRoot(t *testing.T, charts ...string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Taskfile.yml"), []byte("version: '3'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range charts {
		dir := filepath.Join(root, "charts", c)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, f := range []string{"values.yaml", "values-homelab.yaml"} {
			if err := os.WriteFile(filepath.Join(dir, f), []byte("{}\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return root
}

// gitopsParents is a rendered `gitops` chart with bootstrap at wave 0, addons
// at wave 1 and applications at wave 10 — the parent-wave ordering the
// crd-order rule depends on.
const gitopsParents = `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: bootstrap
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    path: charts/bootstrap
    helm:
      valueFiles: [values.yaml]
  destination:
    namespace: argocd
  syncPolicy:
    syncOptions: [CreateNamespace=true]
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: addons
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  source:
    path: charts/addons
    helm:
      valueFiles: [values.yaml]
  destination:
    namespace: argocd
  syncPolicy:
    syncOptions: [CreateNamespace=true]
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: applications
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "10"
spec:
  source:
    path: charts/applications
    helm:
      valueFiles: [values.yaml]
  destination:
    namespace: argocd
  syncPolicy:
    syncOptions: [CreateNamespace=true]
`

func testRegistry() *GitOpsRegistry {
	return &GitOpsRegistry{
		CRDProviders: map[string]CRDProvider{
			"cert-manager.io": {App: "cert-manager"},
			"argoproj.io":     {App: "argo-workflows", SkipKinds: []string{"Application", "AppProject", "ApplicationSet"}},
		},
		HugeCRDCharts:    []string{"cert-manager"},
		SystemNamespaces: []string{"argocd", "kube-system"},
		KnownSecrets:     []KnownSecret{{Name: "sops-age-key", Namespace: "argocd", Reason: "created by ksops"}},
	}
}

func TestLintGitOpsRules(t *testing.T) {
	tests := []struct {
		name string
		rule string
		// charts created under <root>/charts so the paths rule can stat them
		repoCharts []string
		rendered   map[string]string
		wantStatus Status
		wantFind   string
	}{
		// ---------------- paths ----------------
		{
			name:       "paths pass when path and value files exist",
			rule:       "paths",
			repoCharts: []string{"bootstrap", "addons", "applications", "cert-manager-config"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager-config
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    path: charts/cert-manager-config
    helm:
      valueFiles:
        - values.yaml
        - values-homelab.yaml
  destination:
    namespace: cert-manager
  syncPolicy:
    syncOptions: [CreateNamespace=true]
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "paths fail on missing value file",
			rule:       "paths",
			repoCharts: []string{"bootstrap", "addons", "applications", "cert-manager-config"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager-config
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    path: charts/cert-manager-config
    helm:
      valueFiles:
        - values-localdev.yaml
  destination:
    namespace: cert-manager
  syncPolicy:
    syncOptions: [CreateNamespace=true]
`,
			},
			wantStatus: StatusFail,
			wantFind:   "values-localdev.yaml",
		},
		{
			name:       "paths fail on missing source path",
			rule:       "paths",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ghost
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    path: charts/does-not-exist
  destination:
    namespace: kube-system
`,
			},
			wantStatus: StatusFail,
			wantFind:   "charts/does-not-exist",
		},
		{
			name:       "paths ignore missing value files when opted in",
			rule:       "paths",
			repoCharts: []string{"bootstrap", "addons", "applications", "x"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: x
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    path: charts/x
    helm:
      ignoreMissingValueFiles: true
      valueFiles: [values-nope.yaml]
  destination:
    namespace: kube-system
`,
			},
			wantStatus: StatusPass,
		},

		// ---------------- waves ----------------
		{
			name:       "waves pass when dependencies precede and config differs",
			rule:       "waves",
			repoCharts: []string{"bootstrap", "addons", "applications", "traefik-dependencies", "traefik-config"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("traefik-dependencies", "5", "charts/traefik-dependencies", "traefik") +
					appDoc("traefik", "6", "", "traefik") +
					appDoc("traefik-config", "8", "charts/traefik-config", "traefik"),
			},
			wantStatus: StatusPass,
		},
		{
			name:       "waves fail when dependencies do not precede",
			rule:       "waves",
			repoCharts: []string{"bootstrap", "addons", "applications", "traefik-dependencies"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("traefik-dependencies", "7", "charts/traefik-dependencies", "traefik") +
					appDoc("traefik", "6", "", "traefik"),
			},
			wantStatus: StatusFail,
			wantFind:   "traefik-dependencies",
		},
		{
			name:       "waves fail when config shares the wave of its chart",
			rule:       "waves",
			repoCharts: []string{"bootstrap", "addons", "applications", "cert-manager-config"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("cert-manager", "0", "", "cert-manager") +
					appDoc("cert-manager-config", "0", "charts/cert-manager-config", "cert-manager"),
			},
			wantStatus: StatusFail,
			wantFind:   "cert-manager-config",
		},
		{
			name:       "waves fail on missing sync-wave annotation",
			rule:       "waves",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: nowave
  namespace: argocd
spec:
  source:
    chart: nowave
    repoURL: https://example.com/charts
  destination:
    namespace: kube-system
`,
			},
			wantStatus: StatusFail,
			wantFind:   "sync-wave",
		},

		// ---------------- crd-order ----------------
		{
			name:       "crd-order pass when provider syncs in an earlier parent",
			rule:       "crd-order",
			repoCharts: []string{"bootstrap", "addons", "applications", "issuer"},
			rendered: map[string]string{
				"gitops":    gitopsParents,
				"bootstrap": appDoc("cert-manager", "0", "", "cert-manager"),
				"addons":    appDoc("issuer", "3", "charts/issuer", "cert-manager"),
				"issuer": `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "crd-order fail when CR shares the provider position",
			rule:       "crd-order",
			repoCharts: []string{"bootstrap", "addons", "applications", "issuer"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("cert-manager", "3", "", "cert-manager") +
					appDoc("issuer", "3", "charts/issuer", "cert-manager"),
				"issuer": `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
`,
			},
			wantStatus: StatusFail,
			wantFind:   "ClusterIssuer",
		},
		{
			name:       "crd-order skips Applications but checks other argoproj.io CRs",
			rule:       "crd-order",
			repoCharts: []string{"bootstrap", "addons", "applications", "wf"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("argo-workflows", "9", "", "argo-workflows") +
					appDoc("wf", "8", "charts/wf", "argo-workflows"),
				"wf": `
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: ingress-verification
  namespace: argo-workflows
`,
			},
			wantStatus: StatusFail,
			wantFind:   "CronWorkflow",
		},
		{
			name:       "crd-order fail when provider Application is absent",
			rule:       "crd-order",
			repoCharts: []string{"bootstrap", "addons", "applications", "issuer"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("issuer", "3", "charts/issuer", "cert-manager"),
				"issuer": `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
`,
			},
			wantStatus: StatusFail,
			wantFind:   "cert-manager",
		},

		// ---------------- repo-secrets ----------------
		{
			name:       "repo-secrets pass for OCI chart with repository Secret",
			rule:       "repo-secrets",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: spegel
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: ghcr.io/spegel-org/helm-charts
    chart: spegel
  destination:
    namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: spegel-oci
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  url: ghcr.io/spegel-org/helm-charts
  enableOCI: "true"
  type: helm
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "repo-secrets fail when OCI repository Secret is missing",
			rule:       "repo-secrets",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: spegel
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: ghcr.io/spegel-org/helm-charts
    chart: spegel
  destination:
    namespace: kube-system
`,
			},
			wantStatus: StatusFail,
			wantFind:   "ghcr.io/spegel-org/helm-charts",
		},
		{
			name:       "repo-secrets fail when enableOCI is not set",
			rule:       "repo-secrets",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: spegel
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: ghcr.io/spegel-org/helm-charts
    chart: spegel
  destination:
    namespace: kube-system
---
apiVersion: v1
kind: Secret
metadata:
  name: spegel-oci
  namespace: argocd
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  url: ghcr.io/spegel-org/helm-charts
  type: helm
`,
			},
			wantStatus: StatusFail,
			wantFind:   "enableOCI",
		},
		{
			name:       "repo-secrets ignore http chart repositories",
			rule:       "repo-secrets",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
  destination:
    namespace: kube-system
  syncPolicy:
    syncOptions: [ServerSideApply=true]
`,
			},
			wantStatus: StatusPass,
		},

		// ---------------- secret-refs ----------------
		{
			name:       "secret-refs pass when OnePasswordItem produces the secret",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications", "dns-config"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: external-dns
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "4"
spec:
  source:
    repoURL: https://example.com/charts
    chart: external-dns
    helm:
      values: |
        env:
          - name: CF_API_TOKEN
            valueFrom:
              secretKeyRef:
                name: cloudflare-api-token
                key: api_token
  destination:
    namespace: external-dns
  syncPolicy:
    syncOptions: [CreateNamespace=true]
` + appDoc("dns-config", "3", "charts/dns-config", "external-dns"),
				"dns-config": `
apiVersion: onepassword.com/v1
kind: OnePasswordItem
metadata:
  name: cloudflare-api-token
  namespace: external-dns
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "secret-refs fail on unproduced helm-values reference",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: external-dns
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "4"
spec:
  source:
    repoURL: https://example.com/charts
    chart: external-dns
    helm:
      values: |
        env:
          - name: CF_API_TOKEN
            valueFrom:
              secretKeyRef:
                name: cloudflare-api-token
                key: api_token
  destination:
    namespace: external-dns
  syncPolicy:
    syncOptions: [CreateNamespace=true]
`,
			},
			wantStatus: StatusFail,
			wantFind:   "cloudflare-api-token",
		},
		{
			name:       "secret-refs accept KnownSecrets entries and Certificate outputs",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications", "tls"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"bootstrap": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: argocd
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "1"
spec:
  source:
    repoURL: https://example.com/charts
    chart: argo-cd
    helm:
      values: |
        repoServer:
          volumes:
            - name: sops-age
              secret:
                secretName: sops-age-key
  destination:
    namespace: argocd
`,
				"addons": appDoc("tls", "3", "charts/tls", "traefik"),
				"tls": `
apiVersion: v1
kind: Namespace
metadata:
  name: traefik
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: dashboard
  namespace: traefik
spec:
  secretName: dashboard-tls
---
apiVersion: v1
kind: Pod
metadata:
  name: consumer
  namespace: traefik
spec:
  volumes:
    - name: tls
      secret:
        secretName: dashboard-tls
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "secret-refs ignore ingress tls secretName",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications", "ing"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("ing", "3", "charts/ing", "media"),
				"ing": `
apiVersion: v1
kind: Namespace
metadata:
  name: media
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: plex
  namespace: media
spec:
  tls:
    - hosts: [plex.example.com]
      secretName: plex-tls
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "secret-refs catch envFrom and existingSecret on rendered objects",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications", "job"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("job", "3", "charts/job", "media"),
				"job": `
apiVersion: v1
kind: Namespace
metadata:
  name: media
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: updater
  namespace: media
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: c
              envFrom:
                - secretRef:
                    name: missing-token
`,
			},
			wantStatus: StatusFail,
			wantFind:   "missing-token",
		},

		// ---------------- namespaces ----------------
		{
			name:       "namespaces pass via rendered Namespace",
			rule:       "namespaces",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: spegel
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: https://example.com/charts
    chart: spegel
  destination:
    namespace: spegel
---
apiVersion: v1
kind: Namespace
metadata:
  name: spegel
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "namespaces fail when nothing creates the namespace",
			rule:       "namespaces",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: spegel
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: https://example.com/charts
    chart: spegel
  destination:
    namespace: spegel
`,
			},
			wantStatus: StatusFail,
			wantFind:   "spegel",
		},

		// ---------------- ssa ----------------
		{
			name:       "ssa pass when ServerSideApply is set",
			rule:       "ssa",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
  destination:
    namespace: kube-system
  syncPolicy:
    syncOptions: [CreateNamespace=true, ServerSideApply=true]
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "ssa fail when a huge-CRD chart omits ServerSideApply",
			rule:       "ssa",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
  destination:
    namespace: kube-system
  syncPolicy:
    syncOptions: [CreateNamespace=true]
`,
			},
			wantStatus: StatusFail,
			wantFind:   "ServerSideApply=true",
		},

		// ---------------- unique-names ----------------
		{
			name:       "unique-names pass for distinct Applications",
			rule:       "unique-names",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("a", "1", "", "kube-system") + appDoc("b", "2", "", "kube-system"),
			},
			wantStatus: StatusPass,
		},
		{
			name:       "unique-names fail on a duplicate namespace/name",
			rule:       "unique-names",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops":       gitopsParents,
				"addons":       appDoc("dup", "1", "", "kube-system"),
				"applications": appDoc("dup", "2", "", "kube-system"),
			},
			wantStatus: StatusFail,
			wantFind:   "dup",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := testRepoRoot(t, tc.repoCharts...)
			rendered := map[string][]Doc{}
			for chart, src := range tc.rendered {
				rendered[chart] = mustDocs(t, chart, "homelab", src)
			}
			checks := LintGitOps("homelab", rendered, testRegistry(), root)
			byRule := checksByRule(t, checks)
			got, ok := byRule[tc.rule]
			if !ok {
				t.Fatalf("no check for rule %q; got %v", tc.rule, keysOf(byRule))
			}
			if got.Status != tc.wantStatus {
				t.Fatalf("rule %s: status %s, want %s (detail=%q findings=%v)",
					tc.rule, got.Status, tc.wantStatus, got.Detail, got.Findings)
			}
			if tc.wantFind != "" {
				if !containsSubstring(got.Findings, tc.wantFind) {
					t.Fatalf("rule %s: findings %v do not mention %q", tc.rule, got.Findings, tc.wantFind)
				}
			}
			if tc.wantStatus == StatusPass && len(got.Findings) != 0 {
				t.Fatalf("rule %s: passing check must have no findings, got %v", tc.rule, got.Findings)
			}
		})
	}
}

// appDoc builds a minimal Application manifest. An empty path renders a
// chart-based source instead of a path-based one.
func appDoc(name, wave, path, destNS string) string {
	src := "    repoURL: https://example.com/charts\n    chart: " + name + "\n"
	if path != "" {
		src = "    repoURL: https://github.com/example/repo.git\n    path: " + path + "\n    helm:\n      valueFiles: [values.yaml]\n"
	}
	return "---\napiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: " + name +
		"\n  namespace: argocd\n  annotations:\n    argocd.argoproj.io/sync-wave: \"" + wave +
		"\"\nspec:\n  source:\n" + src +
		"  destination:\n    namespace: " + destNS +
		"\n  syncPolicy:\n    syncOptions: [CreateNamespace=true, ServerSideApply=true]\n"
}

func keysOf(m map[string]Check) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func containsSubstring(haystack []string, needle string) bool {
	for _, h := range haystack {
		if strings.Contains(h, needle) {
			return true
		}
	}
	return false
}

func TestLintGitOpsEmitsEveryRuleOnce(t *testing.T) {
	root := testRepoRoot(t, "bootstrap", "addons", "applications")
	rendered := map[string][]Doc{"gitops": mustDocs(t, "gitops", "localdev", gitopsParents)}
	checks := LintGitOps("localdev", rendered, testRegistry(), root)
	byRule := checksByRule(t, checks)
	for _, rule := range GitOpsRules {
		c, ok := byRule[rule]
		if !ok {
			t.Fatalf("rule %q missing from %v", rule, keysOf(byRule))
		}
		if want := "gitops/localdev/" + rule; c.Name != want {
			t.Errorf("check name %q, want %q", c.Name, want)
		}
	}
	if len(byRule) != len(GitOpsRules) {
		t.Errorf("got %d checks, want %d", len(byRule), len(GitOpsRules))
	}
}

func TestLintGitOpsSkipsOrphanChildCharts(t *testing.T) {
	// democratic-csi-config renders in localdev but no Application owns it,
	// so its CRs are outside the env's GitOps graph and must not be ordered.
	root := testRepoRoot(t, "bootstrap", "addons", "applications", "orphan")
	rendered := map[string][]Doc{
		"gitops": mustDocs(t, "gitops", "localdev", gitopsParents),
		"orphan": mustDocs(t, "orphan", "localdev", `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
`),
	}
	checks := LintGitOps("localdev", rendered, testRegistry(), root)
	if got := checksByRule(t, checks)["crd-order"]; got.Status != StatusPass {
		t.Fatalf("crd-order should skip orphan charts, got %s %v", got.Status, got.Findings)
	}
}

// lintFixture loads testdata/gitops/<name> through LoadRenderDir — the same
// path the command takes — and lints the homelab environment against a
// synthesized repo root containing the given chart directories.
func lintFixture(t *testing.T, name string, repoCharts ...string) map[string]Check {
	t.Helper()
	rendered, err := LoadRenderDir(filepath.Join("testdata", "gitops", name))
	if err != nil {
		t.Fatalf("loading fixture %s: %v", name, err)
	}
	docs, ok := rendered["homelab"]
	if !ok {
		t.Fatalf("fixture %s has no homelab environment", name)
	}
	return checksByRule(t, LintGitOps("homelab", docs, testRegistry(), testRepoRoot(t, repoCharts...)))
}

func TestLintGitOpsGoodFixturePasses(t *testing.T) {
	byRule := lintFixture(t, "good",
		"bootstrap", "addons", "applications", "cert-manager-config", "cert-manager-cluster-issuer")
	for _, rule := range GitOpsRules {
		if got := byRule[rule]; got.Status != StatusPass {
			t.Errorf("rule %s: %s %v", rule, got.Status, got.Findings)
		}
	}
}

func TestLintGitOpsBrokenFixtureFailsEveryRule(t *testing.T) {
	byRule := lintFixture(t, "broken",
		"bootstrap", "addons", "applications", "cert-manager-config", "issuer", "demo-dependencies")

	// Each rule must fail, and must name the object the fixture broke.
	want := map[string]string{
		"paths":        "charts/nope",
		"waves":        "cert-manager-config",
		"crd-order":    "ClusterIssuer",
		"repo-secrets": "ghcr.io/spegel-org/helm-charts",
		"secret-refs":  "cloudflare-api-token",
		"namespaces":   "spegel",
		"ssa":          "cert-manager",
		"unique-names": "demo",
	}
	for _, rule := range GitOpsRules {
		got := byRule[rule]
		if got.Status != StatusFail {
			t.Errorf("rule %s: status %s, want fail", rule, got.Status)
			continue
		}
		if !containsSubstring(got.Findings, want[rule]) {
			t.Errorf("rule %s: findings %v do not mention %q", rule, got.Findings, want[rule])
		}
	}
	// demo-dependencies syncing after demo is the second waves violation.
	if !containsSubstring(byRule["waves"].Findings, "demo-dependencies") {
		t.Errorf("waves: missing the -dependencies violation: %v", byRule["waves"].Findings)
	}
}

func TestLoadGitOpsRegistryDefaultsWhenFilesAbsent(t *testing.T) {
	reg, err := LoadGitOpsRegistry(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"argocd": true, "kube-system": true, "kube-public": true, "default": true}
	if len(reg.SystemNamespaces) != len(want) {
		t.Fatalf("SystemNamespaces = %v", reg.SystemNamespaces)
	}
	for _, ns := range reg.SystemNamespaces {
		if !want[ns] {
			t.Errorf("unexpected default system namespace %q", ns)
		}
	}
	if len(reg.CRDProviders) != 0 || len(reg.HugeCRDCharts) != 0 || len(reg.KnownSecrets) != 0 {
		t.Errorf("expected empty registries, got %+v", reg)
	}
}

func TestLoadGitOpsRegistryParsesBothProviderForms(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "tests", "gitops")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("crd-providers.yaml", `
systemNamespaces: [argocd]
providers:
  cert-manager.io: cert-manager
  argoproj.io:
    app: argo-workflows
    skipKinds: [Application]
    kinds:
      Rollout: argo-rollouts
`)
	write("huge-crd-charts.yaml", "charts:\n  - cilium\n")
	write("known-secrets.yaml", "secrets:\n  - name: sops-age-key\n    namespace: argocd\n    reason: created by ksops\n")

	reg, err := LoadGitOpsRegistry(root)
	if err != nil {
		t.Fatal(err)
	}
	if reg.CRDProviders["cert-manager.io"].App != "cert-manager" {
		t.Errorf("scalar provider form not parsed: %+v", reg.CRDProviders)
	}
	argo := reg.CRDProviders["argoproj.io"]
	if argo.App != "argo-workflows" || argo.Kinds["Rollout"] != "argo-rollouts" || len(argo.SkipKinds) != 1 {
		t.Errorf("mapping provider form not parsed: %+v", argo)
	}
	if argo.AppFor("Rollout") != "argo-rollouts" || argo.AppFor("CronWorkflow") != "argo-workflows" {
		t.Errorf("AppFor override wrong: %+v", argo)
	}
	if !argo.Skips("Application") || argo.Skips("CronWorkflow") {
		t.Errorf("Skips wrong: %+v", argo)
	}
	if len(reg.SystemNamespaces) != 1 || reg.SystemNamespaces[0] != "argocd" {
		t.Errorf("systemNamespaces override ignored: %v", reg.SystemNamespaces)
	}
	if len(reg.HugeCRDCharts) != 1 || len(reg.KnownSecrets) != 1 {
		t.Errorf("registry lists not loaded: %+v", reg)
	}
}

func TestLoadGitOpsRegistryRejectsKnownSecretWithoutReason(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "tests", "gitops")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "known-secrets.yaml"), []byte("secrets:\n  - name: mystery\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadGitOpsRegistry(root); err == nil {
		t.Fatal("expected an error for a known secret without a reason")
	}
}

// TestLintGitOpsAgainstRealRegistry keeps the committed registry files
// loadable and consistent with the charts in the repo.
func TestLoadGitOpsRegistryRealRepo(t *testing.T) {
	root, err := FindRepoRoot(mustGetwd(t))
	if err != nil {
		t.Skip("not in repo")
	}
	reg, err := LoadGitOpsRegistry(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.CRDProviders) == 0 {
		t.Error("tests/gitops/crd-providers.yaml produced no providers")
	}
	if len(reg.HugeCRDCharts) == 0 {
		t.Error("tests/gitops/huge-crd-charts.yaml produced no charts")
	}
	for _, ks := range reg.KnownSecrets {
		if strings.TrimSpace(ks.Reason) == "" {
			t.Errorf("known secret %s/%s has no reason", ks.Namespace, ks.Name)
		}
	}
}
