package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// findProjectRoot walks up from CWD to find go.mod.
func findProjectRootForTest(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find project root")
		}
		dir = parent
	}
}

// loadTestConfig loads the real config pipeline for parity testing.
func loadTestConfig(t *testing.T, configRoot string, setName string) *ResolvedConfig {
	t.Helper()

	schema, err := LoadSchemaDir(filepath.Join(configRoot, "schema"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}

	versions, err := LoadVersions(filepath.Join(configRoot, "versions.yaml"))
	if err != nil {
		t.Fatalf("loading versions: %v", err)
	}

	defaults, err := LoadEnvironment(filepath.Join(configRoot, "environments", "defaults.yaml"))
	if err != nil {
		t.Fatalf("loading defaults: %v", err)
	}

	env, err := LoadEnvironment(filepath.Join(configRoot, "environments", setName+".yaml"))
	if err != nil {
		t.Fatalf("loading %s env: %v", setName, err)
	}

	rc, err := Eval(schema, versions, setName, defaults, env)
	if err != nil {
		t.Fatalf("eval: %v", err)
	}

	return rc
}

// TestParityHelmAddons verifies generated addons values contain all required config values.
func TestParityHelmAddons(t *testing.T) {
	if os.Getenv("RUN_PARITY_TESTS") == "" {
		t.Skip("Set RUN_PARITY_TESTS=1 to run parity tests (requires real config)")
	}

	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	rc := loadTestConfig(t, configRoot, "homelab")

	output, err := Export(rc, filepath.Join(configRoot, "templates", "helm-addons.tmpl"))
	if err != nil {
		t.Fatalf("export failed: %v", err)
	}

	// Verify key PII values appear in output
	requiredValues := map[string]string{
		"DOMAIN":            rc.Values["DOMAIN"].Value,
		"TRUENAS_IP":        rc.Values["TRUENAS_IP"].Value,
		"ACME_EMAIL":        rc.Values["ACME_EMAIL"].Value,
		"ARGOCD_HOSTNAME":   rc.Values["ARGOCD_HOSTNAME"].Value,
		"GRAFANA_HOSTNAME":  rc.Values["GRAFANA_HOSTNAME"].Value,
		"TRAEFIK_STATIC_IP": rc.Values["TRAEFIK_STATIC_IP"].Value,
		"TRAEFIK_HOSTNAME":  rc.Values["TRAEFIK_HOSTNAME"].Value,
		"CP_VIP":            rc.Values["CP_VIP"].Value,
		"LB_POOL_START":     rc.Values["LB_POOL_START"].Value,
		"LB_POOL_END":       rc.Values["LB_POOL_END"].Value,
		"GATEWAY_IP":        rc.Values["GATEWAY_IP"].Value,
		"NFS_SHARE_ALLOW":   rc.Values["NFS_SHARE_ALLOW"].Value,
	}

	for key, val := range requiredValues {
		if !strings.Contains(output, val) {
			t.Errorf("generated helm-addons output missing %s=%q", key, val)
		}
	}

	// Verify chart versions appear in output
	requiredVersions := []string{
		"argocd", "cilium", "democratic-csi", "cert-manager",
		"external-dns", "kube-prometheus-stack", "traefik",
	}
	for _, chart := range requiredVersions {
		ver := rc.Versions.Charts[chart]
		if ver == "" {
			t.Errorf("chart version missing for %s", chart)
			continue
		}
		if !strings.Contains(output, ver) {
			t.Errorf("generated helm-addons output missing chart version %s=%q", chart, ver)
		}
	}
}

// TestParityHelmApps verifies generated apps values contain all required config values.
func TestParityHelmApps(t *testing.T) {
	if os.Getenv("RUN_PARITY_TESTS") == "" {
		t.Skip("Set RUN_PARITY_TESTS=1 to run parity tests (requires real config)")
	}

	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	rc := loadTestConfig(t, configRoot, "homelab")

	output, err := Export(rc, filepath.Join(configRoot, "templates", "helm-apps.tmpl"))
	if err != nil {
		t.Fatalf("export failed: %v", err)
	}

	requiredValues := map[string]string{
		"DOMAIN":                rc.Values["DOMAIN"].Value,
		"TRUENAS_HOSTNAME":     rc.Values["TRUENAS_HOSTNAME"].Value,
		"PLEX_HOSTNAME":        rc.Values["PLEX_HOSTNAME"].Value,
		"PLEX_LB_IP":           rc.Values["PLEX_LB_IP"].Value,
		"SONARR_HOSTNAME":      rc.Values["SONARR_HOSTNAME"].Value,
		"RADARR_HOSTNAME":      rc.Values["RADARR_HOSTNAME"].Value,
		"PROWLARR_HOSTNAME":    rc.Values["PROWLARR_HOSTNAME"].Value,
		"NZBGET_HOSTNAME":      rc.Values["NZBGET_HOSTNAME"].Value,
		"TAUTULLI_HOSTNAME":    rc.Values["TAUTULLI_HOSTNAME"].Value,
		"LAZYLIBRARIAN_HOSTNAME": rc.Values["LAZYLIBRARIAN_HOSTNAME"].Value,
		"MEDIA_MOVIES_PATH":    rc.Values["MEDIA_MOVIES_PATH"].Value,
		"MEDIA_TV_PATH":        rc.Values["MEDIA_TV_PATH"].Value,
		"DUCKDNS_SUBDOMAIN":    rc.Values["DUCKDNS_SUBDOMAIN"].Value,
		"TIMEZONE":             rc.Values["TIMEZONE"].Value,
		"ARGOCD_HOSTNAME":      rc.Values["ARGOCD_HOSTNAME"].Value,
	}

	for key, val := range requiredValues {
		if !strings.Contains(output, val) {
			t.Errorf("generated helm-apps output missing %s=%q", key, val)
		}
	}
}

// TestParityTfvars verifies generated tfvars contain required infrastructure values.
func TestParityTfvars(t *testing.T) {
	if os.Getenv("RUN_PARITY_TESTS") == "" {
		t.Skip("Set RUN_PARITY_TESTS=1 to run parity tests (requires real config)")
	}

	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	rc := loadTestConfig(t, configRoot, "homelab")

	output, err := Export(rc, filepath.Join(configRoot, "templates", "tfvars.tmpl"))
	if err != nil {
		t.Fatalf("export failed: %v", err)
	}

	requiredValues := map[string]string{
		"DOMAIN":     rc.Values["DOMAIN"].Value,
		"GATEWAY_IP": rc.Values["GATEWAY_IP"].Value,
		"TRUENAS_IP": rc.Values["TRUENAS_IP"].Value,
		"PROXMOX_IP": rc.Values["PROXMOX_IP"].Value,
		"CP_VIP":     rc.Values["CP_VIP"].Value,
		"CP1_IP":     rc.Values["CP1_IP"].Value,
	}

	for key, val := range requiredValues {
		if !strings.Contains(output, val) {
			t.Errorf("generated tfvars output missing %s=%q", key, val)
		}
	}

	// Verify tool versions
	if !strings.Contains(output, rc.Versions.Tools["talos"]) {
		t.Errorf("generated tfvars missing talos version %q", rc.Versions.Tools["talos"])
	}
	if !strings.Contains(output, rc.Versions.Tools["kubernetes"]) {
		t.Errorf("generated tfvars missing kubernetes version %q", rc.Versions.Tools["kubernetes"])
	}
}

// TestParityAllFormatsExport verifies all 5 export formats succeed.
func TestParityAllFormatsExport(t *testing.T) {
	if os.Getenv("RUN_PARITY_TESTS") == "" {
		t.Skip("Set RUN_PARITY_TESTS=1 to run parity tests (requires real config)")
	}

	projectRoot := findProjectRootForTest(t)
	configRoot := filepath.Join(projectRoot, "configuration")

	rc := loadTestConfig(t, configRoot, "homelab")

	templates := []string{
		"helm-addons.tmpl",
		"helm-apps.tmpl",
		"tfvars.tmpl",
		"dotenv.tmpl",
		"json.tmpl",
	}

	for _, tmpl := range templates {
		t.Run(tmpl, func(t *testing.T) {
			output, err := Export(rc, filepath.Join(configRoot, "templates", tmpl))
			if err != nil {
				t.Fatalf("export %s failed: %v", tmpl, err)
			}
			if len(output) == 0 {
				t.Errorf("export %s produced empty output", tmpl)
			}
		})
	}
}
