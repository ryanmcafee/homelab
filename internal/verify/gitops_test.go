package verify

import (
	"fmt"
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
func fakeRepoRoot(t *testing.T, charts ...string) string {
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
		OutputRefKeys:    []OutputRefKey{{Key: "privateKeySecretRef", Reason: "cert-manager writes the ACME account key"}},
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
		// wantDetail, when set, must equal the check's Detail exactly. Used
		// where the disclosure of what was skipped is the point of the case.
		wantDetail string
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
			name:       "paths skip sources from another git repository",
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
    repoURL: https://github.com/example/homelab.git
    path: charts/cert-manager-config
  destination:
    namespace: cert-manager
  syncPolicy:
    syncOptions: [CreateNamespace=true]
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: gateway-api-crds
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: https://github.com/kubernetes-sigs/gateway-api.git
    path: config/crd/standard
  destination:
    server: https://kubernetes.default.svc
`,
			},
			wantStatus: StatusPass,
			wantDetail: "4 Application source paths checked, 1 in another repository not checked",
		},
		{
			name:       "paths still fail a missing path in this repository's own URL",
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
    repoURL: https://github.com/example/homelab.git
    path: charts/cert-manager-config
  destination:
    namespace: cert-manager
  syncPolicy:
    syncOptions: [CreateNamespace=true]
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ghost
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "0"
spec:
  source:
    repoURL: https://github.com/example/homelab.git
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
			repoCharts: []string{"bootstrap", "addons", "applications", "envoy-gateway-dependencies", "envoy-gateway-config"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("envoy-gateway-dependencies", "5", "charts/envoy-gateway-dependencies", "envoy-gateway-system") +
					appDoc("envoy-gateway", "6", "", "envoy-gateway-system") +
					appDoc("envoy-gateway-config", "8", "charts/envoy-gateway-config", "envoy-gateway-system"),
			},
			wantStatus: StatusPass,
		},
		{
			name:       "waves fail when dependencies do not precede",
			rule:       "waves",
			repoCharts: []string{"bootstrap", "addons", "applications", "envoy-gateway-dependencies"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("envoy-gateway-dependencies", "7", "charts/envoy-gateway-dependencies", "envoy-gateway-system") +
					appDoc("envoy-gateway", "6", "", "envoy-gateway-system"),
			},
			wantStatus: StatusFail,
			wantFind:   "envoy-gateway-dependencies",
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
			// The boundary: wave(X-dependencies) must be strictly lower, so
			// equal waves are a violation, not a pass.
			name:       "waves fail when dependencies share the wave of its chart",
			rule:       "waves",
			repoCharts: []string{"bootstrap", "addons", "applications", "envoy-gateway-dependencies"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("envoy-gateway-dependencies", "6", "charts/envoy-gateway-dependencies", "envoy-gateway-system") +
					appDoc("envoy-gateway", "6", "", "envoy-gateway-system"),
			},
			wantStatus: StatusFail,
			wantFind:   "must be lower than envoy-gateway",
		},
		{
			name:       "waves fail on a non-numeric sync-wave annotation",
			rule:       "waves",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: badwave
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "first"
spec:
  source:
    chart: badwave
    repoURL: https://example.com/charts
  destination:
    namespace: kube-system
`,
			},
			wantStatus: StatusFail,
			wantFind:   "missing or non-numeric",
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
			// ArgoCD only reads repository credentials from its own namespace,
			// so a Secret parked anywhere else is inert.
			name:       "repo-secrets fail when the repository Secret is outside argocd",
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
  namespace: kube-system
  labels:
    argocd.argoproj.io/secret-type: repository
stringData:
  url: ghcr.io/spegel-org/helm-charts
  enableOCI: "true"
  type: helm
`,
			},
			wantStatus: StatusFail,
			wantFind:   "must live in the argocd namespace",
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
				"dns-config": onePasswordItem("cloudflare-api-token", "external-dns",
					"vaults/homelab/items/cloudflare"),
			},
			wantStatus: StatusPass,
		},
		{
			name:       "secret-refs reject an OnePasswordItem with no itemPath",
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
				"dns-config": onePasswordItem("cloudflare-api-token", "external-dns", ""),
			},
			wantStatus: StatusFail,
			wantFind:   "empty spec.itemPath",
		},
		{
			name:       "secret-refs follow apiTokenSecretRef on a cert-manager solver",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications", "issuer", "cm-config"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("cm-config", "-1", "charts/cm-config", "cert-manager") +
					appDoc("issuer", "1", "charts/issuer", "cert-manager"),
				"cm-config": onePasswordItem("cloudflare-api-token", "cert-manager",
					"vaults/homelab/items/cloudflare"),
				"issuer": clusterIssuerWithCloudflare,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "secret-refs fail on an unproduced apiTokenSecretRef",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications", "issuer"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("issuer", "1", "charts/issuer", "cert-manager"),
				"issuer": clusterIssuerWithCloudflare,
			},
			wantStatus: StatusFail,
			wantFind:   "apiTokenSecretRef",
		},
		{
			// The ClusterIssuer is cluster-scoped, so its reference resolves
			// only through the destination namespace of the Application that
			// deploys charts/issuer. The producer sits in another namespace.
			name:       "secret-refs inherit the namespace of the owning Application",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications", "issuer", "cm-config"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("cm-config", "-1", "charts/cm-config", "other-namespace") +
					appDoc("issuer", "1", "charts/issuer", "cert-manager"),
				"cm-config": onePasswordItem("cloudflare-api-token", "other-namespace",
					"vaults/homelab/items/cloudflare"),
				"issuer": clusterIssuerWithCloudflare,
			},
			wantStatus: StatusFail,
			wantFind:   "cert-manager/cloudflare-api-token",
		},
		{
			// charts/orphan has no owning Application, so nothing in it
			// deploys in this environment. Same treatment as crd-order:
			// skipped, and disclosed in the detail rather than failed.
			name:       "secret-refs skip references from charts no Application deploys",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"orphan": clusterIssuerWithCloudflare,
			},
			wantStatus: StatusPass,
			wantDetail: "0 secret references, 0 rendered producers; skipped 1 reference(s) from charts no Application references: orphan",
		},
		{
			// The chart does deploy, but the Application declares no
			// destination namespace, so there is nowhere to look for the
			// producer. That is a real gap, not an undeployed chart.
			name:       "secret-refs fail when a deployed Application declares no destination namespace",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: widget
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "4"
spec:
  source:
    repoURL: https://example.com/charts
    chart: widget
    helm:
      values: |
        auth:
          existingSecret: widget-credentials
  destination:
    server: https://kubernetes.default.svc
`,
			},
			wantStatus: StatusFail,
			wantFind:   "cannot resolve a namespace",
		},
		{
			name:       "secret-refs ignore privateKeySecretRef, which cert-manager writes",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications", "issuer"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("issuer", "1", "charts/issuer", "cert-manager"),
				"issuer": `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - http01:
          gatewayHTTPRoute:
            parentRefs:
              - name: envoy-external
                namespace: envoy-gateway-system
`,
			},
			wantStatus: StatusPass,
		},
		{
			name:       "secret-refs walk valuesObject as well as values",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: widget
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "4"
spec:
  source:
    repoURL: https://example.com/charts
    chart: widget
    helm:
      valuesObject:
        auth:
          existingSecretName: widget-credentials
  destination:
    namespace: widgets
  syncPolicy:
    syncOptions: [CreateNamespace=true]
`,
			},
			wantStatus: StatusFail,
			wantFind:   "valuesObject.auth.existingSecretName",
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
				"addons": appDoc("tls", "3", "charts/tls", "envoy-gateway-system"),
				"tls": `
apiVersion: v1
kind: Namespace
metadata:
  name: envoy-gateway-system
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: dashboard
  namespace: envoy-gateway-system
spec:
  secretName: dashboard-tls
---
apiVersion: v1
kind: Pod
metadata:
  name: consumer
  namespace: envoy-gateway-system
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
			name:       "secret-refs catch envFrom secretRef on rendered objects",
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
		{
			// existingSecret is the Helm-chart spelling, and it appears both as
			// a bare string and as a {name: …} map depending on the chart.
			name:       "secret-refs catch existingSecret in both spellings",
			rule:       "secret-refs",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: router
  namespace: argocd
  annotations:
    argocd.argoproj.io/sync-wave: "7"
spec:
  source:
    repoURL: https://example.com/charts
    chart: port-forwarding
    helm:
      values: |
        router:
          existingSecret: unifi-credentials
        database:
          auth:
            existingSecret:
              name: db-credentials
  destination:
    namespace: port-forwarding
  syncPolicy:
    syncOptions: [CreateNamespace=true]
`,
			},
			wantStatus: StatusFail,
			wantFind:   "unifi-credentials",
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

		{
			// The Application name is nvidia-gpu-operator but the chart is
			// gpu-operator, so only the spec.source.chart branch can match.
			name:       "ssa fail when only spec.source.chart matches the huge-CRD list",
			rule:       "ssa",
			repoCharts: []string{"bootstrap", "addons", "applications"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: certificate-authority
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
			wantFind:   "Application/argocd/certificate-authority",
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
		{
			// Two Applications claiming one path makes chart ownership, and so
			// every ordering key derived from it, a coin toss.
			name:       "unique-names fail when two Applications claim one source path",
			rule:       "unique-names",
			repoCharts: []string{"bootstrap", "addons", "applications", "shared"},
			rendered: map[string]string{
				"gitops": gitopsParents,
				"addons": appDoc("first", "1", "charts/shared", "kube-system") +
					appDoc("second", "2", "charts/shared", "kube-system"),
			},
			wantStatus: StatusFail,
			wantFind:   "charts/shared",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := fakeRepoRoot(t, tc.repoCharts...)
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
			if tc.wantDetail != "" && got.Detail != tc.wantDetail {
				t.Fatalf("rule %s: detail = %q, want %q", tc.rule, got.Detail, tc.wantDetail)
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

// onePasswordItem builds an OnePasswordItem. An empty namespace leaves
// metadata.namespace off, forcing the linter to inherit it from the owning
// Application; an empty itemPath makes the item inert.
func onePasswordItem(name, namespace, itemPath string) string {
	out := "---\napiVersion: onepassword.com/v1\nkind: OnePasswordItem\nmetadata:\n  name: " + name + "\n"
	if namespace != "" {
		out += "  namespace: " + namespace + "\n"
	}
	return out + "spec:\n  itemPath: " + fmt.Sprintf("%q", itemPath) + "\n"
}

// clusterIssuerWithCloudflare is a cluster-scoped object carrying both an
// input reference (apiTokenSecretRef) and an output one (privateKeySecretRef).
const clusterIssuerWithCloudflare = `
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api_token
`

// TestLintGitOpsExemptsApplicationFamilyWithoutRegistrySkips proves the
// argoproj.io Application-family exemption is enforced in code, not merely by
// the skipKinds list in tests/gitops/crd-providers.yaml: a registry that
// forgets skipKinds must still not order Applications against themselves.
func TestLintGitOpsExemptsApplicationFamilyWithoutRegistrySkips(t *testing.T) {
	reg := &GitOpsRegistry{
		// No SkipKinds at all, and a provider that is not rendered: if the
		// exemption were registry-driven, every Application would be reported.
		CRDProviders:     map[string]CRDProvider{"argoproj.io": {App: "argo-workflows"}},
		SystemNamespaces: []string{"argocd", "kube-system"},
	}
	rendered := map[string][]Doc{
		"gitops": mustDocs(t, "gitops", "homelab", gitopsParents),
		"addons": mustDocs(t, "addons", "homelab", appDoc("widget", "3", "", "kube-system")+`
---
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: default
  namespace: argocd
---
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: cluster-addons
  namespace: argocd
`),
	}
	got := checksByRule(t, LintGitOps("homelab", rendered, reg, fakeRepoRoot(t, "bootstrap", "addons", "applications")))["crd-order"]
	if got.Status != StatusPass {
		t.Fatalf("Application-family kinds must be exempt regardless of registry skipKinds: %v", got.Findings)
	}

	// The same registry must still order a real Argo Workflows resource, so
	// the exemption is narrow rather than a blanket group skip.
	rendered["addons"] = append(rendered["addons"], mustDocs(t, "addons", "homelab", `
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: verify
  namespace: argo-workflows
  annotations:
    argocd.argoproj.io/sync-wave: "3"
`)...)
	got = checksByRule(t, LintGitOps("homelab", rendered, reg, fakeRepoRoot(t, "bootstrap", "addons", "applications")))["crd-order"]
	if got.Status != StatusFail || !containsSubstring(got.Findings, "CronWorkflow") {
		t.Fatalf("CronWorkflow must still be ordered: %s %v", got.Status, got.Findings)
	}
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
	root := fakeRepoRoot(t, "bootstrap", "addons", "applications")
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

	// The graph here is only the three parent Applications, so the details
	// must say so. Asserting the counts stops a passing-but-empty run from
	// looking like a clean bill of health.
	wantDetail := map[string]string{
		"paths":        "3 Application source paths checked",
		"waves":        "3 Applications, 0 sibling wave comparisons",
		"crd-order":    "0 custom resources ordered against 2 CRD providers",
		"repo-secrets": "0 OCI chart sources, 0 repository Secrets",
		"secret-refs":  "0 secret references, 0 rendered producers, 0 seeded by localdev/fakes",
		"namespaces":   "3 Application destination namespaces, 0 rendered Namespaces",
		"ssa":          "0 of 3 Applications require ServerSideApply",
		"unique-names": "3 distinct Applications, 3 distinct source paths",
	}
	for rule, want := range wantDetail {
		if got := byRule[rule].Detail; got != want {
			t.Errorf("rule %s detail = %q, want %q", rule, got, want)
		}
	}
}

func TestLintGitOpsSkipsOrphanChildCharts(t *testing.T) {
	// A chart like democratic-csi-config renders in localdev but no
	// Application owns it, so its CRs are outside the env's GitOps graph and
	// must not be ordered. The skip has to be visible in the detail.
	root := fakeRepoRoot(t, "bootstrap", "addons", "applications", "orphan")
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
	got := checksByRule(t, checks)["crd-order"]
	if got.Status != StatusPass {
		t.Fatalf("crd-order should skip orphan charts, got %s %v", got.Status, got.Findings)
	}
	if want := "skipped 1 object(s) from charts no Application references: orphan"; !strings.Contains(got.Detail, want) {
		t.Errorf("crd-order detail must disclose the skip, got %q", got.Detail)
	}
}

// seededSecretRefRender is a deployed chart whose CronJob consumes Secret
// paperclip/paperclip-auth, which nothing renders: only a seeded Secret can
// satisfy it.
var seededSecretRefRender = map[string]string{
	"gitops": gitopsParents,
	"addons": appDoc("paperclip", "3", "charts/paperclip", "paperclip"),
	"paperclip": `
apiVersion: batch/v1
kind: CronJob
metadata:
  name: paperclip
  namespace: paperclip
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: c
              envFrom:
                - secretRef:
                    name: paperclip-auth
`,
}

// writeSeededFakes writes <root>/localdev/fakes/secrets.yaml seeding the
// given Secrets (as "namespace/name") the way scripts/localdev-kind.ts fakes
// applies them to Kind.
func writeSeededFakes(t *testing.T, root string, secrets ...string) {
	t.Helper()
	dir := filepath.Join(root, "localdev", "fakes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var body strings.Builder
	body.WriteString("---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: paperclip\n")
	for _, s := range secrets {
		ns, name, _ := strings.Cut(s, "/")
		body.WriteString("---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: " + name +
			"\n  namespace: " + ns + "\ntype: Opaque\nstringData:\n  token: localdev\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "secrets.yaml"), []byte(body.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestSecretRefsCountSeededFakesForLocaldevOnly: the Secrets
// localdev/fakes/*.yaml seeds into Kind are producers for the localdev
// render (Env.SeededSecretsDir) and nothing else — homelab gets them from
// 1Password and must keep failing until an OnePasswordItem renders.
func TestSecretRefsCountSeededFakesForLocaldevOnly(t *testing.T) {
	tests := []struct {
		name       string
		env        string
		seeded     []string
		wantStatus Status
		wantDetail string
		wantFind   string
	}{
		{
			name:       "localdev passes when the fakes seed the referenced Secret",
			env:        "localdev",
			seeded:     []string{"paperclip/paperclip-auth", "paperclip/paperclip-api-keys"},
			wantStatus: StatusPass,
			wantDetail: "1 secret references, 0 rendered producers, 2 seeded by localdev/fakes",
		},
		{
			name:       "homelab ignores the fakes",
			env:        "homelab",
			seeded:     []string{"paperclip/paperclip-auth"},
			wantStatus: StatusFail,
			wantDetail: "1 secret references, 0 rendered producers",
			wantFind:   "paperclip/paperclip-auth",
		},
		{
			name:       "localdev fails when the fake lives in another namespace",
			env:        "localdev",
			seeded:     []string{"media/paperclip-auth"},
			wantStatus: StatusFail,
			wantDetail: "1 secret references, 0 rendered producers, 1 seeded by localdev/fakes",
			wantFind:   "or seed it in localdev/fakes/ for localdev",
		},
		{
			name:       "localdev without a fakes directory discloses zero seeded",
			env:        "localdev",
			wantStatus: StatusFail,
			wantDetail: "1 secret references, 0 rendered producers, 0 seeded by localdev/fakes",
			wantFind:   "paperclip/paperclip-auth",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := fakeRepoRoot(t, "bootstrap", "addons", "applications", "paperclip")
			if len(tc.seeded) > 0 {
				writeSeededFakes(t, root, tc.seeded...)
			}
			rendered := map[string][]Doc{}
			for chart, src := range seededSecretRefRender {
				rendered[chart] = mustDocs(t, chart, tc.env, src)
			}
			got := checksByRule(t, LintGitOps(tc.env, rendered, testRegistry(), root))["secret-refs"]
			if got.Status != tc.wantStatus {
				t.Fatalf("status %s, want %s (detail=%q findings=%v)", got.Status, tc.wantStatus, got.Detail, got.Findings)
			}
			if got.Detail != tc.wantDetail {
				t.Errorf("detail = %q, want %q", got.Detail, tc.wantDetail)
			}
			if tc.wantFind != "" && !containsSubstring(got.Findings, tc.wantFind) {
				t.Errorf("findings %v do not mention %q", got.Findings, tc.wantFind)
			}
		})
	}
}

func TestSecretRefsReportBrokenSeededFakes(t *testing.T) {
	root := fakeRepoRoot(t, "bootstrap", "addons", "applications")
	dir := filepath.Join(root, "localdev", "fakes")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "secrets.yaml"), []byte("a: [b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rendered := map[string][]Doc{"gitops": mustDocs(t, "gitops", "localdev", gitopsParents)}
	got := checksByRule(t, LintGitOps("localdev", rendered, testRegistry(), root))["secret-refs"]
	if got.Status != StatusFail || !containsSubstring(got.Findings, "localdev/fakes: ") {
		t.Fatalf("a fakes file that does not parse must fail secret-refs, got %s %v", got.Status, got.Findings)
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
	return checksByRule(t, LintGitOps("homelab", docs, testRegistry(), fakeRepoRoot(t, repoCharts...)))
}

func TestLintGitOpsGoodFixturePasses(t *testing.T) {
	byRule := lintFixture(t, "good",
		"bootstrap", "addons", "applications", "cert-manager-config", "cert-manager-cluster-issuer")
	for _, rule := range GitOpsRules {
		if got := byRule[rule]; got.Status != StatusPass {
			t.Errorf("rule %s: %s %v", rule, got.Status, got.Findings)
		}
	}

	// Assert what each rule actually examined. Without this a fixture that
	// silently stopped loading would still report eight green checks.
	wantDetail := map[string]string{
		"paths": "5 Application source paths checked",
		"waves": "8 Applications, 1 sibling wave comparisons",
		// Only the ClusterIssuer is ordered: testRegistry does not register
		// onepassword.com, so the OnePasswordItem has no provider to follow.
		"crd-order": "1 custom resources ordered against 2 CRD providers; skipped 1 object(s) from charts no Application references: orphan-config",
		// The disclosure of skipped https sources is part of the contract:
		// repo-secrets checks oci:// only.
		"repo-secrets": "1 OCI chart sources, 1 repository Secrets; 2 https repositories not checked (public Helm repos need no Secret)",
		"secret-refs":  "1 secret references, 2 rendered producers",
		"namespaces":   "8 Application destination namespaces, 2 rendered Namespaces",
		"ssa":          "1 of 8 Applications require ServerSideApply",
		"unique-names": "8 distinct Applications, 5 distinct source paths",
	}
	for rule, want := range wantDetail {
		if got := byRule[rule].Detail; got != want {
			t.Errorf("rule %s detail = %q, want %q", rule, got, want)
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

// ---------------------------------------------------------------------------
// Disclosures: a rule that checked nothing must not report a pass
// ---------------------------------------------------------------------------

// TestRepoSecretsDisclosesSkippedHTTPSRepos: repo-secrets deliberately checks
// only oci:// sources, which is narrower than issue #261 asked for. The
// narrowing has to be visible in the level-0 output, not only in a comment.
func TestRepoSecretsDisclosesSkippedHTTPSRepos(t *testing.T) {
	const apps = `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: one
  namespace: argocd
spec:
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
  destination:
    namespace: cert-manager
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: two
  namespace: argocd
spec:
  source:
    repoURL: https://prometheus-community.github.io/helm-charts
    chart: kube-prometheus-stack
  destination:
    namespace: monitoring
---
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: three
  namespace: argocd
spec:
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager-istio-csr
  destination:
    namespace: cert-manager
`
	g := buildGitOpsGraph("localdev", map[string][]Doc{"addons": mustDocs(t, "addons", "localdev", apps)})
	c := g.ruleRepoSecrets()

	// Three https sources, two distinct repositories.
	if !strings.Contains(c.Detail, "2 https repositories not checked (public Helm repos need no Secret)") {
		t.Errorf("detail = %q; it must disclose the skipped https repositories", c.Detail)
	}
	if c.Status != StatusPass {
		t.Errorf("status = %s, want pass: an https source needs no repository Secret", c.Status)
	}
}

func TestRepoSecretsDisclosureIsSingularForOneRepo(t *testing.T) {
	const app = `
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: one
  namespace: argocd
spec:
  source:
    repoURL: https://charts.jetstack.io
    chart: cert-manager
  destination:
    namespace: cert-manager
`
	g := buildGitOpsGraph("localdev", map[string][]Doc{"addons": mustDocs(t, "addons", "localdev", app)})
	if got := g.ruleRepoSecrets().Detail; !strings.Contains(got, "1 https repository not checked") {
		t.Errorf("detail = %q, want the singular form", got)
	}
}

// TestEmptyRegistrySectionsSkipRatherThanPass: a rule whose registry section is
// empty matched nothing by construction. Reporting a pass would claim the
// convention was verified.
func TestEmptyRegistrySectionsSkipRatherThanPass(t *testing.T) {
	root := fakeRepoRoot(t, "bootstrap", "addons", "applications")
	rendered := map[string][]Doc{"gitops": mustDocs(t, "gitops", "localdev", gitopsParents)}

	empty := &GitOpsRegistry{SystemNamespaces: []string{"argocd", "kube-system"}}
	byRule := checksByRule(t, LintGitOps("localdev", rendered, empty, root))

	for rule, wantFile := range map[string]string{
		"crd-order": "crd-providers.yaml",
		"ssa":       "huge-crd-charts.yaml",
	} {
		c := byRule[rule]
		if c.Status != StatusSkip {
			t.Errorf("rule %s status = %s, want skip when its registry section is empty", rule, c.Status)
		}
		if !strings.Contains(c.Detail, wantFile) {
			t.Errorf("rule %s detail = %q; it must name %s", rule, c.Detail, wantFile)
		}
	}

	// With entries present the same rules report normally again.
	byRule = checksByRule(t, LintGitOps("localdev", rendered, testRegistry(), root))
	for _, rule := range []string{"crd-order", "ssa"} {
		if got := byRule[rule].Status; got != StatusPass {
			t.Errorf("rule %s status = %s, want pass with a populated registry", rule, got)
		}
	}
}

// TestLoadGitOpsRegistryRejectsUnknownTopLevelKeys: yaml.Unmarshal ignores a
// key the struct does not know, so a typo left the registry section empty and
// the rule quietly checked nothing.
func TestLoadGitOpsRegistryRejectsUnknownTopLevelKeys(t *testing.T) {
	tests := []struct {
		name string
		file string
		body string
	}{
		{"crd-providers typo", "crd-providers.yaml", "provider:\n  cert-manager.io: cert-manager\n"},
		{"huge-crd-charts typo", "huge-crd-charts.yaml", "chart:\n  - cilium\n"},
		{"known-secrets typo", "known-secrets.yaml", "secret:\n  - name: x\n    reason: y\n"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "tests", "gitops")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, tc.file), []byte(tc.body), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := LoadGitOpsRegistry(root)
			if err == nil {
				t.Fatalf("a typo'd top-level key in %s must fail loudly", tc.file)
			}
			if !strings.Contains(err.Error(), tc.file) {
				t.Errorf("error %q should name %s", err.Error(), tc.file)
			}
		})
	}
}

func TestLoadGitOpsRegistryAcceptsAnEmptyFile(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "tests", "gitops")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"crd-providers.yaml", "huge-crd-charts.yaml", "known-secrets.yaml"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("# nothing yet\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	reg, err := LoadGitOpsRegistry(root)
	if err != nil {
		t.Fatalf("an empty registry file is a legitimate \"no entries\": %v", err)
	}
	if len(reg.CRDProviders) != 0 || len(reg.HugeCRDCharts) != 0 {
		t.Errorf("expected empty registries, got %+v", reg)
	}
}
