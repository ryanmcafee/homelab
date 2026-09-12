package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildGuardPatterns(t *testing.T) {
	values := map[string]string{
		"DOMAIN":          "ryanmcafee.com",
		"GATEWAY_IP":      "172.16.100.1",
		"TRUENAS_IP":      "172.16.100.150",
		"NFS_MAPALL_USER": "rmcafee",
		"ACME_EMAIL":      "admin@ryanmcafee.com",
		"BGP_K8S_ASN":     "64512", // Not PII — should not be a guard pattern
	}

	patterns := BuildGuardPatterns(values)

	// Should include domain, IPs, username, email
	if len(patterns) < 4 {
		t.Errorf("expected at least 4 patterns, got %d", len(patterns))
	}

	// Should NOT include generic values like ASN numbers
	for _, p := range patterns {
		if p == "64512" {
			t.Error("guard should not flag generic numeric values like ASN")
		}
	}
}

func TestScanFileForPII(t *testing.T) {
	// Create a temp file with PII
	dir := t.TempDir()
	cleanFile := filepath.Join(dir, "clean.yaml")
	dirtyFile := filepath.Join(dir, "dirty.yaml")

	os.WriteFile(cleanFile, []byte("domain: example.com\nip: 192.168.1.1\n"), 0644)
	os.WriteFile(dirtyFile, []byte("domain: ryanmcafee.com\nip: 172.16.100.150\nemail: admin@ryanmcafee.com\n"), 0644)

	patterns := []string{"ryanmcafee.com", "172.16.100.", "admin@ryanmcafee.com"}

	cleanResults := ScanFileForPII(cleanFile, patterns)
	if len(cleanResults.Matches) != 0 {
		t.Errorf("clean file should have 0 matches, got %d", len(cleanResults.Matches))
	}

	dirtyResults := ScanFileForPII(dirtyFile, patterns)
	// 4 matches: line 1 matches "ryanmcafee.com", line 2 matches "172.16.100.",
	// line 3 matches both "ryanmcafee.com" and "admin@ryanmcafee.com"
	if len(dirtyResults.Matches) != 4 {
		t.Errorf("dirty file should have 4 matches, got %d", len(dirtyResults.Matches))
	}
}

func TestIsPIIKey(t *testing.T) {
	tests := []struct {
		key  string
		want bool
	}{
		{key: "DOMAIN", want: true},
		{key: "TRAEFIK_OIDC_ALLOWED_DOMAINS", want: true},
		{key: "ACME_EMAIL", want: true},
		{key: "NFS_MAPALL_USER", want: true},
		{key: "EXTERNAL_DNS_DEFAULT_TARGET", want: true},
		{key: "GATEWAY_IP", want: true},
		{key: "WORKER1_IP", want: true},
		{key: "TRUENAS_HOSTNAME", want: true},
		// The control-plane virtual address holds a real host address but its
		// key ends in _VIP, not _IP.
		{key: "CP_VIP", want: true},
		// Not PII-shaped: CIDRs, ports, ASNs, storage classes, vault paths.
		{key: "K8S_POD_CIDR", want: false},
		{key: "K8S_SERVICE_CIDR", want: false},
		{key: "BGP_K8S_ASN", want: false},
		{key: "LB_POOL_START", want: false},
		{key: "STORAGE_CLASS_NFS", want: false},
		{key: "TRAEFIK_OIDC_PROVIDER_URL", want: false},
		{key: "DEMOCRATIC_CSI_1P_PATH", want: false},
		{key: "MOSQUITTO_MQTT_PORT", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.key, func(t *testing.T) {
			if got := IsPIIKey(tc.key); got != tc.want {
				t.Errorf("IsPIIKey(%q) = %v, want %v", tc.key, got, tc.want)
			}
		})
	}
}

func TestIsGuardExcluded(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "configuration/environments/homelab.yaml", want: true},
		{path: "charts/applications/values-homelab.generated.yaml", want: true},
		{path: "configuration/environments/homelab.generated.yaml", want: true},
		{path: "configuration/environments/homelab.yaml.example", want: false},
		{path: "configuration/environments/localdev.yaml", want: false},
		{path: "configuration/environments/defaults.yaml", want: false},
		{path: "configuration/schema/network.schema.yaml", want: false},
		{path: "charts/plex-config/values-homelab.yaml", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.path, func(t *testing.T) {
			if got := IsGuardExcluded(tc.path); got != tc.want {
				t.Errorf("IsGuardExcluded(%q) = %v, want %v", tc.path, got, tc.want)
			}
		})
	}
}

// withTrackedFiles swaps the package-level lister for the duration of a test.
func withTrackedFiles(t *testing.T, files []string, err error) *[][]string {
	t.Helper()
	prev := TrackedFiles
	var calls [][]string
	TrackedFiles = func(_ string, pathspecs []string) ([]string, error) {
		calls = append(calls, append([]string(nil), pathspecs...))
		return files, err
	}
	t.Cleanup(func() { TrackedFiles = prev })
	return &calls
}

func TestListGuardFilesAppliesScopeAndExclusions(t *testing.T) {
	tracked := []string{
		"configuration/versions.yaml",
		"configuration/schema/network.schema.yaml",
		"configuration/environments/localdev.yaml",
		"configuration/environments/homelab.yaml",         // excluded: real values
		"configuration/environments/homelab.yaml.example", // excluded: .example is not a scannable extension
		"configuration/templates/helm-addons.tmpl",        // excluded: not a scannable extension
		"configuration/README.md",
		"configuration/exports/apps.generated.json", // excluded: generated
		"configuration/.configu.yaml",
		"configuration/versions.yaml", // duplicate
	}
	withTrackedFiles(t, tracked, nil)

	got, err := ListGuardFiles("/repo", nil)
	if err != nil {
		t.Fatalf("ListGuardFiles: %v", err)
	}
	want := []string{
		"configuration/.configu.yaml",
		"configuration/README.md",
		"configuration/environments/localdev.yaml",
		"configuration/schema/network.schema.yaml",
		"configuration/versions.yaml",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d files %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("file[%d] = %q, want %q (list must be sorted and deduplicated)", i, got[i], want[i])
		}
	}
}

func TestListGuardFilesPathspecs(t *testing.T) {
	tests := []struct {
		name      string
		pathspecs []string
		want      []string
	}{
		{name: "default scope mirrors the pre-commit hook", pathspecs: nil, want: DefaultGuardPathspecs},
		{name: "explicit scope is passed through", pathspecs: []string{"charts/**/values-homelab.yaml"}, want: []string{"charts/**/values-homelab.yaml"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			calls := withTrackedFiles(t, nil, nil)
			if _, err := ListGuardFiles("/repo", tc.pathspecs); err != nil {
				t.Fatalf("ListGuardFiles: %v", err)
			}
			if len(*calls) != 1 {
				t.Fatalf("lister called %d times, want 1", len(*calls))
			}
			got := (*calls)[0]
			if len(got) != len(tc.want) {
				t.Fatalf("pathspecs = %v, want %v", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("pathspec[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

func TestListGuardFilesPropagatesListerError(t *testing.T) {
	withTrackedFiles(t, nil, os.ErrPermission)
	if _, err := ListGuardFiles("/repo", nil); err == nil {
		t.Fatal("expected the lister error to propagate")
	}
}

func TestScanFileForPIIShape(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []string // keys expected to be flagged
	}{
		{
			name:    "routable host IP on a PII-shaped key",
			content: "DOMAIN: homelab.local\nTRUENAS_IP: \"172.16.100.150\"\n",
			want:    []string{"TRUENAS_IP"},
		},
		{
			name:    "committed localdev values are clean",
			content: "DOMAIN: homelab.local\nGATEWAY_IP: \"127.0.0.1\"\nTRUENAS_IP: \"127.0.0.1\"\nCP_VIP: \"127.0.0.1\"\nLB_POOL_START: \"127.0.0.100\"\nNFS_SHARE_ALLOW: \"127.0.0.0/8\"\nNFS_MAPALL_USER: localdev\nACME_EMAIL: test@homelab.local\nEXTERNAL_DNS_DEFAULT_TARGET: homelab-dev.duckdns.org\n",
			want:    nil,
		},
		{
			name:    "control-plane virtual address is covered",
			content: "CP_VIP: \"172.16.100.10\"\n",
			want:    []string{"CP_VIP"},
		},
		{
			name:    "committed defaults are clean",
			content: "DOMAIN: example.com\nK8S_POD_CIDR: \"10.244.0.0/16\"\nK8S_SERVICE_CIDR: \"10.96.0.0/12\"\nBGP_K8S_ASN: \"64512\"\nACME_EMAIL: \"\"\n",
			want:    nil,
		},
		{
			name:    "schema files declare keys without values",
			content: "keys:\n  GATEWAY_IP:\n    description: Default gateway / router IP\n    default: \"10.244.0.0/16\"\n    pattern: \"^(?:\\\\d{1,3}\\\\.){3}\\\\d{1,3}$\"\n",
			want:    nil,
		},
		{
			name:    "non-PII keys with routable IPs are ignored",
			content: "K8S_POD_CIDR: 10.244.0.1\nMOSQUITTO_MQTT_PORT: \"1883\"\n",
			want:    nil,
		},
		{
			name:    "inline comment and quotes are stripped",
			content: "WORKER1_IP: \"172.16.100.21\" # GPU node\n",
			want:    []string{"WORKER1_IP"},
		},
		{
			name:    "several leaks are all reported",
			content: "GATEWAY_IP: 172.16.100.1\nfiller: x\nPROXMOX_IP: 172.16.100.250\n",
			want:    []string{"GATEWAY_IP", "PROXMOX_IP"},
		},
		{
			name:    "markdown table rows are not key/value lines",
			content: "| Service | IP |\n|---|---|\n| TrueNAS | 172.16.100.150 |\n",
			want:    nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "f.yaml")
			if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			res := ScanFileForPIIShape(path)
			if len(res.Matches) != len(tc.want) {
				t.Fatalf("got %d match(es) %+v, want %d for %v", len(res.Matches), res.Matches, len(tc.want), tc.want)
			}
			for i, key := range tc.want {
				if !strings.Contains(res.Matches[i].Pattern, key) {
					t.Errorf("match[%d].Pattern = %q, want it to name %q", i, res.Matches[i].Pattern, key)
				}
			}
		})
	}
}

func TestRunGuardEmptyCIScopeIsFailure(t *testing.T) {
	withTrackedFiles(t, nil, nil)

	report, err := RunGuard(GuardOptions{RepoRoot: "/repo", CI: true})
	if !errors.Is(err, ErrGuardNoFiles) {
		t.Fatalf("err = %v, want ErrGuardNoFiles so CI cannot pass vacuously", err)
	}
	if report != nil && len(report.Files) != 0 {
		t.Errorf("report should carry an empty file list, got %v", report.Files)
	}
}

func TestRunGuardMissingEnvFileDegrades(t *testing.T) {
	dir := t.TempDir()
	dirty := filepath.Join(dir, "dirty.yaml")
	if err := os.WriteFile(dirty, []byte("DOMAIN: ryanmcafee.com\nTRUENAS_IP: 172.16.100.150\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	report, err := RunGuard(GuardOptions{
		RepoRoot: dir,
		Files:    []string{dirty},
		EnvPath:  filepath.Join(dir, "does-not-exist.yaml"),
	})
	if err != nil {
		t.Fatalf("a missing environment file must not be fatal: %v", err)
	}
	if !report.EnvMissing {
		t.Error("report.EnvMissing should be set so the caller can warn")
	}
	if report.ValuePatterns != 0 {
		t.Errorf("ValuePatterns = %d, want 0 without an environment file", report.ValuePatterns)
	}
	// Value-based detection is gone, but shape-based detection still catches
	// both the real domain and the routable address on their PII-shaped keys.
	if n := report.MatchCount(); n != 2 {
		t.Fatalf("MatchCount() = %d, want 2 from shape-based detection alone", n)
	}
	var kinds []string
	for _, m := range report.Results[0].Matches {
		kinds = append(kinds, m.Pattern)
	}
	joined := strings.Join(kinds, " ")
	if !strings.Contains(joined, "DOMAIN (real hostname)") {
		t.Errorf("expected the domain to be reported as a hostname, got %v", kinds)
	}
	if !strings.Contains(joined, "TRUENAS_IP (routable host IP)") {
		t.Errorf("expected the address to be reported as an IP, got %v", kinds)
	}
}

func TestRunGuardValueModeFindsLeaksAndDoesNotDoubleReport(t *testing.T) {
	dir := t.TempDir()
	env := filepath.Join(dir, "homelab.yaml")
	if err := os.WriteFile(env, []byte("DOMAIN: ryanmcafee.com\nTRUENAS_IP: 172.16.100.150\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dirty := filepath.Join(dir, "snapshot.yaml")
	if err := os.WriteFile(dirty, []byte("portal: 172.16.100.150:3260\nhost: plex.ryanmcafee.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	clean := filepath.Join(dir, "clean.yaml")
	if err := os.WriteFile(clean, []byte("host: plex.example.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	report, err := RunGuard(GuardOptions{RepoRoot: dir, Files: []string{dirty, clean}, EnvPath: env})
	if err != nil {
		t.Fatalf("RunGuard: %v", err)
	}
	if report.EnvMissing {
		t.Error("EnvMissing should be false when the environment file loaded")
	}
	if report.ValuePatterns == 0 {
		t.Error("ValuePatterns should be non-zero in value mode")
	}
	if n := report.MatchCount(); n != 2 {
		t.Fatalf("MatchCount() = %d, want 2 (one per leaking line, no double report)", n)
	}
	if len(report.Files) != 2 {
		t.Errorf("report.Files = %v, want both scanned files", report.Files)
	}
}

func TestRunGuardExplicitFilesBypassPathspecs(t *testing.T) {
	calls := withTrackedFiles(t, []string{"configuration/versions.yaml"}, nil)
	dir := t.TempDir()
	f := filepath.Join(dir, "a.yaml")
	if err := os.WriteFile(f, []byte("x: 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	report, err := RunGuard(GuardOptions{RepoRoot: dir, Files: []string{f}, EnvPath: filepath.Join(dir, "none.yaml")})
	if err != nil {
		t.Fatalf("RunGuard: %v", err)
	}
	if len(*calls) != 0 {
		t.Errorf("the lister must not run when explicit files are given, calls: %v", *calls)
	}
	if len(report.Files) != 1 || report.Files[0] != f {
		t.Errorf("report.Files = %v, want %v", report.Files, []string{f})
	}
}

func TestIsRealHostname(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		// Real infrastructure.
		{name: "bare domain", value: "ryanmcafee.com", want: true},
		{name: "subdomain", value: "plex.ryanmcafee.com", want: true},
		{name: "email mailbox is stripped", value: "admin@ryanmcafee.com", want: true},
		{name: "url scheme and path are stripped", value: "https://argocd.ryanmcafee.com/applications", want: true},
		{name: "port is stripped", value: "truenas.ryanmcafee.com:443", want: true},
		{name: "uppercase is normalised", value: "PLEX.RyanMcAfee.COM", want: true},

		// Documentation placeholders.
		{name: "example.com", value: "example.com", want: false},
		{name: "example.org", value: "example.org", want: false},
		{name: "your- marker", value: "your-domain.com", want: false},
		{name: "your- subdomain marker", value: "your-subdomain.duckdns.org", want: false},
		{name: "placeholder email", value: "admin@your-domain.com", want: false},
		{name: "angle-bracket placeholder", value: "<domain>.com", want: false},
		{name: "changeme", value: "changeme.io", want: false},

		// Reserved suffixes.
		{name: "dot local", value: "homelab.local", want: false},
		{name: "dot local email", value: "test@homelab.local", want: false},
		{name: "dot internal", value: "truenas.internal", want: false},
		{name: "dot test", value: "foo.test", want: false},
		{name: "localhost", value: "localhost", want: false},

		// Allowlisted committed value.
		{name: "localdev duckdns target", value: "homelab-dev.duckdns.org", want: false},

		// Not hostnames at all.
		{name: "empty", value: "", want: false},
		{name: "no dot", value: "homelab-dev", want: false},
		{name: "username", value: "localdev", want: false},
		{name: "IPv4 is handled as an IP", value: "172.16.100.150", want: false},
		{name: "CIDR", value: "10.244.0.0/16", want: false},
		{name: "numeric TLD", value: "1.36.1", want: false},
		{name: "single-letter TLD", value: "foo.x", want: false},
		{name: "storage class", value: "democratic-csi-nfs", want: false},
		{name: "vault path", value: "vaults/homelab/items/truenas", want: false},
		{name: "timezone", value: "America/New_York", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isRealHostname(tc.value); got != tc.want {
				t.Errorf("isRealHostname(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestIsTemplateFile(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "configuration/environments/homelab.yaml.example", want: true},
		{path: "configuration/environments/homelab.yaml.template", want: true},
		{path: "CLAUDE.local.md.example", want: true},
		{path: "app.conf.sample", want: true},
		{path: "nginx.conf.dist", want: true},
		{path: "configuration/environments/localdev.yaml", want: false},
		{path: "configuration/environments/homelab.yaml", want: false},
		{path: "tests/snapshots/homelab/addons.yaml", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.path, func(t *testing.T) {
			if got := IsTemplateFile(tc.path); got != tc.want {
				t.Errorf("IsTemplateFile(%q) = %v, want %v", tc.path, got, tc.want)
			}
		})
	}
}

func TestScanFileForPIIShapeHostnames(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		content  string
		want     []string
	}{
		{
			name:     "real domain on a PII-shaped key",
			filename: "f.yaml",
			content:  "DOMAIN: ryanmcafee.com\n",
			want:     []string{"DOMAIN"},
		},
		{
			name:     "real mailbox",
			filename: "f.yaml",
			content:  "ACME_EMAIL: admin@ryanmcafee.com\n",
			want:     []string{"ACME_EMAIL"},
		},
		{
			name:     "external-dns target",
			filename: "f.yaml",
			content:  "EXTERNAL_DNS_DEFAULT_TARGET: home.ryanmcafee.com\n",
			want:     []string{"EXTERNAL_DNS_DEFAULT_TARGET"},
		},
		{
			name:     "allowed domains list",
			filename: "f.yaml",
			content:  "TRAEFIK_OIDC_ALLOWED_DOMAINS: ryanmcafee.com\n",
			want:     []string{"TRAEFIK_OIDC_ALLOWED_DOMAINS"},
		},
		{
			name:     "committed localdev hostnames stay clean",
			filename: "localdev.yaml",
			content:  "DOMAIN: homelab.local\nACME_EMAIL: test@homelab.local\nTRAEFIK_OIDC_ALLOWED_DOMAINS: homelab.local\nEXTERNAL_DNS_DEFAULT_TARGET: homelab-dev.duckdns.org\nDUCKDNS_SUBDOMAIN: homelab-dev\nNFS_MAPALL_USER: localdev\n",
			want:     nil,
		},
		{
			name:     "committed defaults stay clean",
			filename: "defaults.yaml",
			content:  "DOMAIN: example.com\nACME_EMAIL: \"\"\nDUCKDNS_SUBDOMAIN: \"\"\nEXTERNAL_DNS_DEFAULT_TARGET: \"\"\nTRAEFIK_OIDC_PROVIDER_URL: \"https://accounts.google.com\"\n",
			want:     nil,
		},
		{
			name:     "the environment template is skipped entirely",
			filename: "homelab.yaml.example",
			content:  "DOMAIN: your-domain.com\nGATEWAY_IP: \"192.168.1.1\"\nTRUENAS_IP: \"192.168.1.100\"\nCP_VIP: \"192.168.1.10\"\n",
			want:     nil,
		},
		{
			name:     "a real address in a non-template file is still caught",
			filename: "homelab.yaml",
			content:  "GATEWAY_IP: \"192.168.1.1\"\n",
			want:     []string{"GATEWAY_IP"},
		},
		{
			name:     "IP and hostname on different keys are both reported",
			filename: "f.yaml",
			content:  "DOMAIN: ryanmcafee.com\nTRUENAS_IP: 172.16.100.150\n",
			want:     []string{"DOMAIN", "TRUENAS_IP"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc.filename)
			if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			res := ScanFileForPIIShape(path)
			if len(res.Matches) != len(tc.want) {
				t.Fatalf("got %d match(es) %+v, want %d for %v", len(res.Matches), res.Matches, len(tc.want), tc.want)
			}
			for i, key := range tc.want {
				if !strings.Contains(res.Matches[i].Pattern, key) {
					t.Errorf("match[%d].Pattern = %q, want it to name %q", i, res.Matches[i].Pattern, key)
				}
			}
		})
	}
}
