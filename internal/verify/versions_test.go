package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const versionsFixture = `charts:
  # renovate: datasource=helm depName=argo-cd registryUrl=https://argoproj.github.io/argo-helm
  argocd: "9.5.17"
  # renovate: datasource=helm depName=connect registryUrl=https://1password.github.io/connect-helm-charts
  onepassword-connect: "2.4.1"
  # renovate: datasource=docker depName=ghcr.io/renovatebot/charts/renovate
  renovate: "46.106.12"
  # renovate: datasource=helm depName=traefik registryUrl=https://traefik.github.io/charts
  traefik: "39.0.9"
  unifi-port-forward: "1.1.1"
images:
  # renovate: datasource=docker depName=curlimages/curl
  curl: "8.22.0"
tools:
  kubernetes: "v1.37.0"
`

func writeVersionFixtures(t *testing.T, drift string) string {
	t.Helper()
	root := t.TempDir()
	for path, body := range map[string]string{
		"configuration/versions.yaml":     versionsFixture,
		"tests/gitops/version-drift.yaml": drift,
	} {
		if body == "" {
			continue
		}
		p := filepath.Join(root, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestLoadVersionPinsReadsRenovateDepNames(t *testing.T) {
	pins, err := LoadVersionPins(writeVersionFixtures(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"argocd": "argo-cd", "onepassword-connect": "connect", "renovate": "renovate", "traefik": "traefik"}
	for k, v := range want {
		if pins.DepNames[k] != v {
			t.Errorf("DepNames[%s] = %q, want %q", k, pins.DepNames[k], v)
		}
	}
	if _, ok := pins.DepNames["unifi-port-forward"]; ok {
		t.Error("a key without a marker must have no depName")
	}
	if _, ok := pins.DepNames["curl"]; ok {
		t.Error("images: markers must not leak into the charts: depNames")
	}
}

func TestCheckVersions(t *testing.T) {
	const allowed = `entries:
  - application: argocd
    chart: argo-cd
    revision: 9.4.7
    reason: bootstrap is plain Helm
`
	tests := []struct {
		name         string
		drift        string
		render       string
		wantStatus   Status
		wantFindings []string
		wantDetail   string
	}{
		{
			name:       "pins matched by chart name, depName and application name",
			render:     app("argocd", "https://argoproj.github.io/argo-helm", "argo-cd", "9.5.17", "a: 1") + app("onepassword-operator", "https://1password.github.io/connect-helm-charts", "connect", "2.4.1", "a: 1") + app("traefik-internal", "https://traefik.github.io/charts", "traefik", "39.0.9", "a: 1") + gitApp,
			wantStatus: StatusPass,
			wantDetail: "3 chart source(s) match configuration/versions.yaml; 0 allowed",
		},
		{
			name:         "drift from the mapped key is reported with the pin",
			render:       app("renovate", "ghcr.io/renovatebot/charts", "renovate", "46.49.0", "a: 1"),
			wantStatus:   StatusFail,
			wantFindings: []string{"renovate: chart renovate renders 46.49.0, versions.yaml has 46.106.12 (key renovate)"},
		},
		{
			name:       "an unmapped chart passes when its revision equals some value",
			render:     app("port-forwarding-controller", "https://ryanmcafee.github.io/port-forwarding-controller", "port-forwarding", "1.1.1", "a: 1"),
			wantStatus: StatusPass,
		},
		{
			name:         "an unmapped chart with an unknown revision fails",
			render:       app("port-forwarding-controller", "https://ryanmcafee.github.io/port-forwarding-controller", "port-forwarding", "1.1.2", "a: 1"),
			wantStatus:   StatusFail,
			wantFindings: []string{"port-forwarding-controller: chart port-forwarding renders 1.1.2, versions.yaml has no charts: key"},
		},
		{
			name:       "registered drift is allowed",
			drift:      allowed,
			render:     app("argocd", "https://argoproj.github.io/argo-helm", "argo-cd", "9.4.7", "a: 1"),
			wantStatus: StatusPass,
			wantDetail: "0 chart source(s) match configuration/versions.yaml; 1 allowed",
		},
		{
			name:         "a registered revision that no longer renders fails",
			drift:        allowed,
			render:       app("argocd", "https://argoproj.github.io/argo-helm", "argo-cd", "9.4.8", "a: 1"),
			wantStatus:   StatusFail,
			wantFindings: []string{"argocd: chart argo-cd renders 9.4.8, but tests/gitops/version-drift.yaml allows 9.4.7"},
		},
		{
			name:         "a registered drift that was fixed is stale",
			drift:        allowed,
			render:       app("argocd", "https://argoproj.github.io/argo-helm", "argo-cd", "9.5.17", "a: 1"),
			wantStatus:   StatusFail,
			wantFindings: []string{"argocd: chart argo-cd renders 9.5.17, which matches configuration/versions.yaml; remove its stale"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := writeVersionFixtures(t, tc.drift)
			pins, err := LoadVersionPins(root)
			if err != nil {
				t.Fatal(err)
			}
			drift, err := LoadVersionDrift(root)
			if err != nil {
				t.Fatal(err)
			}
			docs, err := ParseMultiDoc("addons", "homelab", []byte(tc.render))
			if err != nil {
				t.Fatal(err)
			}
			c := CheckVersions("homelab", docs, pins, drift, map[int]bool{})
			if c.Name != "versions/homelab" || c.Status != tc.wantStatus {
				t.Fatalf("%s = %s %q %v", c.Name, c.Status, c.Detail, c.Findings)
			}
			if tc.wantDetail != "" && !strings.HasPrefix(c.Detail, tc.wantDetail) {
				t.Errorf("detail %q, want prefix %q", c.Detail, tc.wantDetail)
			}
			if len(c.Findings) != len(tc.wantFindings) {
				t.Fatalf("findings %q, want %d", c.Findings, len(tc.wantFindings))
			}
			for i, w := range tc.wantFindings {
				if !strings.HasPrefix(c.Findings[i], w) {
					t.Errorf("finding %q, want prefix %q", c.Findings[i], w)
				}
			}
		})
	}
}

func TestVersionChecksReportsUnusedEntriesOnlyForACompleteRender(t *testing.T) {
	root := writeVersionFixtures(t, `entries:
  - application: gone
    chart: gone
    revision: 1.0.0
    reason: removed long ago
`)
	docs, _ := ParseMultiDoc("addons", "homelab", []byte(gitApp))
	rendered := map[string]map[string][]Doc{"homelab": {"addons": docs}}
	envs := []Env{{Name: "homelab"}}

	// versions/pins reads files this fixture does not write; it is covered by
	// TestCheckPins and dropped here.
	withoutPins := func(checks []Check) []Check {
		var out []Check
		for _, c := range checks {
			if c.Name != "versions/pins" {
				out = append(out, c)
			}
		}
		return out
	}

	checks := withoutPins(VersionChecks(root, rendered, envs, true))
	if len(checks) != 2 || checks[1].Name != "versions/registry" || checks[1].Status != StatusFail ||
		!strings.HasPrefix(checks[1].Findings[0], "gone (chart gone, revision 1.0.0): no rendered Application") {
		t.Fatalf("complete render: %+v", checks)
	}
	if checks := withoutPins(VersionChecks(root, rendered, envs, false)); len(checks) != 1 || checks[0].Status != StatusPass {
		t.Fatalf("partial render must not judge unused entries: %+v", checks)
	}
	if all := VersionChecks(root, rendered, envs, true); all[0].Name != "versions/pins" {
		t.Fatalf("versions/pins must be the first check: %+v", all)
	}
}

func TestLoadVersionDriftIsStrict(t *testing.T) {
	tests := []struct {
		name, body, want string
	}{
		{"unknown key", "entry:\n  - application: a\n", "field entry not found"},
		{"unknown entry field", "entries:\n  - application: a\n    chart: c\n    revision: 1\n    reason: r\n    note: x\n", "field note not found"},
		{"missing reason", "entries:\n  - application: a\n    chart: c\n    revision: 1\n", "has no reason"},
		{"duplicate", "entries:\n  - {application: a, chart: c, revision: '1', reason: r}\n  - {application: a, chart: c, revision: '2', reason: r}\n", "duplicate entry"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadVersionDrift(writeVersionFixtures(t, tc.body))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestCheckPins(t *testing.T) {
	write := func(t *testing.T, root, rel, body string) {
		t.Helper()
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	const versions = "charts:\n  argocd: \"9.7.1\"\n  prometheus-operator-crds: \"30.0.0\"\nimages:\n  homelab-cmp: \"0.1.31\"\ntools:\n  talos: \"v1.12.2\"\n  kubernetes: \"v1.32.0\"\n"
	const envHCL = "locals {\n  talos_version      = \"v1.12.2\"\n  kubernetes_version = \"v1.32.0\"\n}\n"
	const bootstrap = "prometheus-operator-crds:\n  chart:\n    name: prometheus-operator-crds\n    repo: https://prometheus-community.github.io/helm-charts\n    version: \"30.0.0\"\nargocd:\n  chart:\n    name: argo-cd\n    repo: https://argoproj.github.io/argo-helm\n    version: \"9.7.1\"\n  values:\n    repoServer:\n      initContainers:\n        - image: ghcr.io/ryanmcafee/homelab-cmp:0.1.31\n      extraContainers:\n        - name: homelab-cmp\n          image: ghcr.io/ryanmcafee/homelab-cmp:0.1.31\n"

	const talosLag = "pins:\n  - file: terragrunt/environments/homelab/env.hcl\n    key: tools.talos\n    revision: v1.11.0\n    reason: upgrade in progress\n"

	tests := []struct {
		name       string
		env, boot  string
		drift      string
		wantStatus Status
		wantIn     string
	}{
		{"all pins agree", envHCL, bootstrap, "", StatusPass, "6 pin(s)"},
		{"talos behind versions.yaml", strings.Replace(envHCL, "v1.12.2", "v1.11.0", 1), bootstrap, "", StatusFail, "tools.talos at v1.11.0"},
		{"registered lag passes", strings.Replace(envHCL, "v1.12.2", "v1.11.0", 1), bootstrap, talosLag, StatusPass, "1 lag behind it under a registered reason"},
		{"registered lag at another revision still fails", strings.Replace(envHCL, "v1.12.2", "v1.10.0", 1), bootstrap, talosLag, StatusFail, "tools.talos at v1.10.0"},
		{"stale lag entry fails once the pin matches", envHCL, bootstrap, talosLag, StatusFail, "matches nothing"},
		{"lag entry without a reason is rejected", envHCL, bootstrap, strings.Replace(talosLag, "    reason: upgrade in progress\n", "", 1), StatusFail, "has no reason"},
		{"bootstrap argocd chart drifted", envHCL, strings.Replace(bootstrap, "9.7.1", "9.4.7", 1), "", StatusFail, "charts.argocd at 9.4.7"},
		{"one cmp tag stale", envHCL, strings.Replace(bootstrap, "homelab-cmp:0.1.31\n      extraContainers", "homelab-cmp:0.1.30\n      extraContainers", 1), "", StatusFail, "images.homelab-cmp at 0.1.30"},
		{"pin missing", "locals {}\n", bootstrap, "", StatusFail, "no pin found for tools.talos"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			write(t, root, "configuration/versions.yaml", versions)
			write(t, root, "terragrunt/environments/homelab/env.hcl", tc.env)
			write(t, root, "charts/bootstrap/values.yaml", tc.boot)
			if tc.drift != "" {
				write(t, root, "tests/gitops/version-drift.yaml", tc.drift)
			}
			c := CheckPins(root)
			if c.Name != "versions/pins" {
				t.Fatalf("name = %q", c.Name)
			}
			if c.Status != tc.wantStatus {
				t.Fatalf("status = %s, want %s (%s %v)", c.Status, tc.wantStatus, c.Detail, c.Findings)
			}
			all := c.Detail + " " + strings.Join(c.Findings, " ")
			if !strings.Contains(all, tc.wantIn) {
				t.Errorf("want %q in %q", tc.wantIn, all)
			}
		})
	}
}
