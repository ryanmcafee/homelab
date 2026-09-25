package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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

	cleanResults, err := ScanFileForPII(cleanFile, patterns)
	if err != nil {
		t.Fatalf("scanning the clean file: %v", err)
	}
	if len(cleanResults.Matches) != 0 {
		t.Errorf("clean file should have 0 matches, got %d", len(cleanResults.Matches))
	}

	dirtyResults, err := ScanFileForPII(dirtyFile, patterns)
	if err != nil {
		t.Fatalf("scanning the dirty file: %v", err)
	}
	// 4 matches: line 1 matches "ryanmcafee.com", line 2 matches "172.16.100.",
	// line 3 matches both "ryanmcafee.com" and "admin@ryanmcafee.com"
	if len(dirtyResults.Matches) != 4 {
		t.Errorf("dirty file should have 4 matches, got %d", len(dirtyResults.Matches))
	}
}

func TestScannersReportUnreadableFiles(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist.yaml")

	if _, err := ScanFileForPII(missing, []string{"secret"}); err == nil {
		t.Error("ScanFileForPII must not report an unreadable file as clean")
	}
	if _, err := ScanFileForPIIShape(missing); err == nil {
		t.Error("ScanFileForPIIShape must not report an unreadable file as clean")
	}

	// A directory opens but cannot be read as a file.
	dir := t.TempDir()
	if _, err := ScanFileForPII(dir, []string{"secret"}); err == nil {
		t.Error("scanning a directory should fail rather than return no matches")
	}
}

func TestIsPIIKey(t *testing.T) {
	tests := []struct {
		key  string
		want bool
	}{
		{key: "DOMAIN", want: true},
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
		{key: "GOOGLE_OAUTH_1P_PATH", want: false},
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
		// The marker may sit on a directory, not just the file itself.
		{path: "configuration/exports.generated.d/values.yaml", want: true},
		{path: "a/b.generated.c/d/e.json", want: true},
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
		"configuration/environments/homelab.yaml", // excluded: real values
		// Included: the template is the likeliest place for a real value to be
		// pasted, so it is scanned as YAML under the placeholder allowlist.
		"configuration/environments/homelab.yaml.example",
		"configuration/templates/helm-addons.tmpl", // excluded: not a scannable extension
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
		"configuration/environments/homelab.yaml.example",
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
			res, err := ScanFileForPIIShape(path)
			if err != nil {
				t.Fatalf("ScanFileForPIIShape: %v", err)
			}
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
		{name: "REPLACEME- marker", value: "REPLACEME-domain.com", want: false},
		{name: "REPLACEME- subdomain marker", value: "REPLACEME-subdomain.duckdns.org", want: false},
		{name: "placeholder email", value: "admin@REPLACEME-domain.com", want: false},
		{name: "angle-bracket placeholder", value: "<domain>.com", want: false},
		// changeme.io is registrable, so it is no longer excused.
		{name: "retired changeme marker", value: "changeme.io", want: true},

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
			name:     "committed localdev hostnames stay clean",
			filename: "localdev.yaml",
			content:  "DOMAIN: homelab.local\nACME_EMAIL: test@homelab.local\nEXTERNAL_DNS_DEFAULT_TARGET: homelab-dev.duckdns.org\nDUCKDNS_SUBDOMAIN: homelab-dev\nNFS_MAPALL_USER: localdev\n",
			want:     nil,
		},
		{
			name:     "committed defaults stay clean",
			filename: "defaults.yaml",
			content:  "DOMAIN: example.com\nACME_EMAIL: \"\"\nDUCKDNS_SUBDOMAIN: \"\"\nEXTERNAL_DNS_DEFAULT_TARGET: \"\"\nGATEWAY_NAMESPACE: envoy-gateway-system\n",
			want:     nil,
		},
		{
			name:     "the environment template's documented placeholders pass",
			filename: "homelab.yaml.example",
			content:  "DOMAIN: REPLACEME-domain.com\nGATEWAY_IP: \"192.168.1.1\"\nTRUENAS_IP: \"192.168.1.100\"\nCP_VIP: \"192.168.1.10\"\nNFS_MAPALL_USER: REPLACEME-username\nACME_EMAIL: admin@REPLACEME-domain.com\nEXTERNAL_DNS_DEFAULT_TARGET: REPLACEME-subdomain.duckdns.org\n",
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
			res, err := ScanFileForPIIShape(path)
			if err != nil {
				t.Fatalf("ScanFileForPIIShape: %v", err)
			}
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

func TestRunGuardResolvesPathsAgainstRepoRoot(t *testing.T) {
	// git ls-files and pre-commit both hand over repository-relative paths.
	// Resolving them against the process working directory meant the guard
	// opened nothing when invoked from a subdirectory and called every file
	// clean.
	repo := t.TempDir()
	if err := os.MkdirAll(filepath.Join(repo, "charts", "plex"), 0o755); err != nil {
		t.Fatal(err)
	}
	planted := filepath.Join("charts", "plex", "values-homelab.yaml")
	if err := os.WriteFile(filepath.Join(repo, planted), []byte("DOMAIN: ryanmcafee.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Run with a working directory that is not the repository root, and below it.
	below := filepath.Join(repo, "charts")
	prev, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(below); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(prev) })

	report, err := RunGuard(GuardOptions{
		RepoRoot: repo,
		Files:    []string{planted},
		EnvPath:  filepath.Join(repo, "absent.yaml"),
	})
	if err != nil {
		t.Fatalf("RunGuard: %v", err)
	}
	if len(report.Unreadable) != 0 {
		t.Fatalf("file should have been readable via RepoRoot, got %+v", report.Unreadable)
	}
	if n := report.MatchCount(); n != 1 {
		t.Fatalf("MatchCount() = %d, want 1: the planted leak must be found from a subdirectory", n)
	}
	if got := report.Results[0].File; got != planted {
		t.Errorf("reported path = %q, want the repository-relative %q", got, planted)
	}
}

func TestRunGuardReportsUnreadableFiles(t *testing.T) {
	repo := t.TempDir()

	tests := []struct {
		name  string
		files []string
	}{
		{name: "missing file", files: []string{"does-not-exist.yaml"}},
		{name: "missing absolute file", files: []string{filepath.Join(repo, "nope.yaml")}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			report, err := RunGuard(GuardOptions{
				RepoRoot: repo,
				Files:    tc.files,
				EnvPath:  filepath.Join(repo, "absent.yaml"),
			})
			if err != nil {
				t.Fatalf("RunGuard: %v", err)
			}
			if len(report.Unreadable) != 1 {
				t.Fatalf("Unreadable = %+v, want exactly one entry: an unscanned file is not a clean file", report.Unreadable)
			}
			if report.Unreadable[0].Err == nil {
				t.Error("the unreadable entry must carry the underlying error")
			}
			if report.MatchCount() != 0 {
				t.Error("an unreadable file yields no matches, only an unreadable entry")
			}
		})
	}
}

func TestRunGuardUnreadableAlongsideValuePatterns(t *testing.T) {
	repo := t.TempDir()
	env := filepath.Join(repo, "homelab.yaml")
	if err := os.WriteFile(env, []byte("DOMAIN: ryanmcafee.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Value-based detection runs first, so the unreadable file must be caught
	// on that path too, not only on the shape path.
	report, err := RunGuard(GuardOptions{
		RepoRoot: repo,
		Files:    []string{"gone.yaml"},
		EnvPath:  env,
	})
	if err != nil {
		t.Fatalf("RunGuard: %v", err)
	}
	if report.ValuePatterns == 0 {
		t.Fatal("expected value patterns to be built")
	}
	if len(report.Unreadable) != 1 {
		t.Fatalf("Unreadable = %+v, want one entry", report.Unreadable)
	}
}

func TestHasScannableExtension(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "configuration/versions.yaml", want: true},
		{path: "configuration/a.yml", want: true},
		{path: "configuration/a.json", want: true},
		{path: "configuration/README.md", want: true},
		// A template suffix is looked through, so the highest-risk file in the
		// repository stays in scope instead of falling out on its name.
		{path: "configuration/environments/homelab.yaml.example", want: true},
		{path: "configuration/environments/homelab.yaml.template", want: true},
		{path: "notes.md.sample", want: true},
		{path: "configuration/templates/helm-addons.tmpl", want: false},
		{path: "configuration/environments/.gitkeep", want: false},
		// scripts/ is guarded, so a TypeScript script is scannable: several hardcoded
		// real addresses, hostnames and a username while .ts was out of scope.
		{path: "scripts/run.ts", want: true},
		{path: "scripts/run_test.ts", want: true},
		// .github/ is guarded, so the README header SVG is scannable: its text
		// nodes name hostnames and must stay <DOMAIN> placeholders.
		{path: ".github/homelab.svg", want: true},
		{path: ".github/workflows/verify.yml", want: true},
		{path: ".github/CODEOWNERS", want: false},
		{path: "binary.example", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.path, func(t *testing.T) {
			if got := hasScannableExtension(tc.path); got != tc.want {
				t.Errorf("hasScannableExtension(%q) = %v, want %v", tc.path, got, tc.want)
			}
		})
	}
}

func TestIsExamplePlaceholder(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		// Allowed: the documentation subnet used throughout the template.
		{name: "documentation subnet gateway", value: "192.168.1.1", want: true},
		{name: "documentation subnet host", value: "192.168.1.100", want: true},
		{name: "documentation subnet edge", value: "192.168.1.255", want: true},
		{name: "documentation subnet with a port", value: "192.168.1.100:3260", want: true},
		{name: "documentation CIDR", value: "192.168.1.0/24", want: true},
		{name: "loopback", value: "127.0.0.1", want: true},
		{name: "loopback CIDR", value: "127.0.0.0/8", want: true},
		// Allowed: documented placeholder hostnames and mailboxes on them.
		{name: "placeholder domain", value: "REPLACEME-domain.com", want: true},
		{name: "placeholder subdomain", value: "gateway.REPLACEME-domain.com", want: true},
		{name: "placeholder mailbox", value: "you@REPLACEME-domain.com", want: true},
		{name: "admin mailbox on the placeholder domain", value: "admin@REPLACEME-domain.com", want: true},
		{name: "example.com", value: "example.com", want: true},
		{name: "mailbox on example.com", value: "you@example.com", want: true},
		// Allowed: the repository's fill-me-in prefix and reserved suffixes.
		{name: "placeholder username", value: "REPLACEME-username", want: true},
		{name: "placeholder subdomain label", value: "REPLACEME-subdomain", want: true},
		{name: "placeholder duckdns target", value: "REPLACEME-subdomain.duckdns.org", want: true},
		{name: "reserved local suffix", value: "truenas.local", want: true},
		{name: "empty", value: "", want: true},
		{name: "empty quoted", value: `""`, want: true},
		{name: "named documentation CIDRs", value: "homelab=192.168.1.0/25,lan=192.168.1.128/25", want: true},

		// Rejected: anything a real environment would contain.
		{name: "real private address", value: "172.16.100.10", want: false},
		{name: "real private address in another range", value: "10.0.0.5", want: false},
		{name: "adjacent documentation subnet is not allowed", value: "192.168.2.10", want: false},
		{name: "real public address", value: "203.0.113.10", want: false},
		{name: "real domain", value: "ryanmcafee.com", want: false},
		{name: "real subdomain", value: "plex.ryanmcafee.com", want: false},
		{name: "real mailbox", value: "admin@ryanmcafee.com", want: false},
		{name: "real username", value: "rmcafee", want: false},
		{name: "real duckdns target", value: "homelab-dev.duckdns.org", want: false},
		{name: "real CIDR", value: "172.16.100.0/24", want: false},
		{name: "named real CIDR", value: "homelab=192.168.1.0/24,lan=172.16.10.0/24", want: false},
		{name: "named list with a non-CIDR item", value: "homelab=192.168.1.0/24,lan", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isExamplePlaceholder(tc.value); got != tc.want {
				t.Errorf("isExamplePlaceholder(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestScanTemplateFileRequiresPlaceholders(t *testing.T) {
	tests := []struct {
		name     string
		content  string
		wantKeys []string
		wantVals []string
	}{
		{
			name:     "a real address pasted into the template",
			content:  "DOMAIN: REPLACEME-domain.com\nCP_VIP: \"172.16.100.10\"\n",
			wantKeys: []string{"CP_VIP"},
			wantVals: []string{"172.16.100.10"},
		},
		{
			name:     "a real domain pasted into the template",
			content:  "DOMAIN: ryanmcafee.com\nGATEWAY_IP: \"192.168.1.1\"\n",
			wantKeys: []string{"DOMAIN"},
			wantVals: []string{"ryanmcafee.com"},
		},
		{
			name:     "a real username, which shape detection alone cannot see",
			content:  "NFS_MAPALL_USER: rmcafee\n",
			wantKeys: []string{"NFS_MAPALL_USER"},
			wantVals: []string{"rmcafee"},
		},
		{
			name:     "a real mailbox",
			content:  "ACME_EMAIL: admin@ryanmcafee.com\n",
			wantKeys: []string{"ACME_EMAIL"},
			wantVals: []string{"admin@ryanmcafee.com"},
		},
		{
			name:     "every leak in one paste is reported",
			content:  "DOMAIN: ryanmcafee.com\nTRUENAS_IP: \"172.16.100.150\"\nNFS_MAPALL_USER: rmcafee\n",
			wantKeys: []string{"DOMAIN", "TRUENAS_IP", "NFS_MAPALL_USER"},
			wantVals: []string{"ryanmcafee.com", "172.16.100.150", "rmcafee"},
		},
		{
			name:     "non-PII keys are still out of scope",
			content:  "K8S_POD_CIDR: \"10.244.0.0/16\"\nTIMEZONE: \"America/New_York\"\nSTORAGE_CLASS_NFS: democratic-csi-nfs\n",
			wantKeys: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "homelab.yaml.example")
			if err := os.WriteFile(path, []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			res, err := ScanFileForPIIShape(path)
			if err != nil {
				t.Fatalf("ScanFileForPIIShape: %v", err)
			}
			if len(res.Matches) != len(tc.wantKeys) {
				t.Fatalf("got %d match(es) %+v, want %d for %v",
					len(res.Matches), res.Matches, len(tc.wantKeys), tc.wantKeys)
			}
			for i, key := range tc.wantKeys {
				m := res.Matches[i]
				if !strings.Contains(m.Pattern, key) {
					t.Errorf("match[%d].Pattern = %q, want it to name %q", i, m.Pattern, key)
				}
				// The Note carries the exact operator-facing message.
				wantNote := "non-placeholder value in example file (" + tc.wantVals[i] + ")"
				if m.Note != wantNote {
					t.Errorf("match[%d].Note = %q, want %q", i, m.Note, wantNote)
				}
			}
		})
	}
}

func TestScanCommittedTemplateIsClean(t *testing.T) {
	// The committed template must satisfy its own allowlist, or the rule is
	// unenforceable in CI. This reads the real file rather than a fixture.
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "..", "..", "configuration", "environments", "homelab.yaml.example")
	if _, err := os.Stat(path); err != nil {
		t.Skipf("template not found at %s: %v", path, err)
	}

	res, err := ScanFileForPIIShape(path)
	if err != nil {
		t.Fatalf("ScanFileForPIIShape: %v", err)
	}
	for _, m := range res.Matches {
		t.Errorf("committed template line %d is outside the placeholder allowlist: %s", m.Line, m.Note)
	}
}

func TestHasPlaceholderMarker(t *testing.T) {
	tests := []struct {
		name string
		host string
		want bool
	}{
		// The convention: REPLACEME on its own, or as a REPLACEME- prefix.
		// Matching is case-insensitive because hosts are lowercased first.
		{name: "REPLACEME- prefix form", host: "replaceme-domain.com", want: true},
		{name: "REPLACEME- prefix on a deeper label", host: "gateway.replaceme-domain.com", want: true},
		{name: "REPLACEME- prefix with no dot at all", host: "replaceme-username", want: true},
		{name: "REPLACEME alone as a whole label", host: "replaceme", want: true},
		{name: "REPLACEME as a deeper label", host: "replaceme.duckdns.org", want: true},
		{name: "angle brackets cannot occur in a real host", host: "<domain>.com", want: true},

		// Retired markers. Each of these is a registrable domain, which is why
		// the natural-language markers were replaced: recognising them as
		// placeholders waved a real host through.
		{name: "yourdomain.com is registrable", host: "yourdomain.com", want: false},
		{name: "changeme.io is registrable", host: "changeme.io", want: false},
		{name: "replace-me.net is registrable", host: "replace-me.net", want: false},
		{name: "todo.com is registrable", host: "todo.com", want: false},

		// A real host that merely contains a marker's letters.
		{name: "mytodolist.com is a real host", host: "mytodolist.com", want: false},
		{name: "todolist.com is a real host", host: "todolist.com", want: false},
		{name: "custodoservices.com is a real host", host: "custodoservices.com", want: false},
		{name: "notyourdomain.com is a real host", host: "notyourdomain.com", want: false},
		{name: "exchangemevents.com is a real host", host: "exchangemevents.com", want: false},
		{name: "notreplaceme.com is a real host", host: "notreplaceme.com", want: false},
		{name: "ryanmcafee.com", host: "ryanmcafee.com", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasPlaceholderMarker(tc.host); got != tc.want {
				t.Errorf("hasPlaceholderMarker(%q) = %v, want %v", tc.host, got, tc.want)
			}
		})
	}
}

func TestIsRealHostnameMarkerAnchoring(t *testing.T) {
	// The same anchoring, exercised through the public shape rule: a real host
	// containing a marker's letters must still be reported.
	tests := []struct {
		value string
		want  bool
	}{
		{value: "mytodolist.com", want: true},
		{value: "todolist.com", want: true},
		{value: "custodoservices.com", want: true},
		{value: "notyourdomain.com", want: true},
		{value: "admin@mytodolist.com", want: true},
		// Retired markers are now ordinary registrable domains.
		{value: "changeme.io", want: true},
		{value: "yourdomain.com", want: true},
		// The convention, judged on the reduced host.
		{value: "REPLACEME-domain.com", want: false},
		{value: "admin@REPLACEME-domain.com", want: false},
		{value: "REPLACEME-subdomain.duckdns.org", want: false},
		// A reserved suffix is a placeholder regardless of the marker.
		{value: "todo.internal", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.value, func(t *testing.T) {
			if got := isRealHostname(tc.value); got != tc.want {
				t.Errorf("isRealHostname(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestExamplePlaceholderPrefixIsAnchored(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		// The template's own values.
		{name: "placeholder domain", value: "REPLACEME-domain.com", want: true},
		{name: "placeholder username", value: "REPLACEME-username", want: true},
		{name: "placeholder mailbox", value: "admin@REPLACEME-domain.com", want: true},
		{name: "placeholder duckdns target", value: "REPLACEME-subdomain.duckdns.org", want: true},
		// A pasted value that merely contains the letters is not a placeholder.
		{name: "not a placeholder despite the letters", value: "notyourdomain.com", want: false},
		{name: "real host containing todo", value: "mytodolist.com", want: false},
		{name: "real username", value: "rmcafee", want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isExamplePlaceholder(tc.value); got != tc.want {
				t.Errorf("isExamplePlaceholder(%q) = %v, want %v", tc.value, got, tc.want)
			}
		})
	}
}

func TestCIScopeIncludesTheEnvironmentTemplate(t *testing.T) {
	// The template is the highest-risk file in the repository, so CI mode must
	// reach it. Extensions are resolved by looking through a template suffix
	// rather than by listing ".example" as a scannable type, which would pull
	// in unrelated files such as an archive named *.example.
	withTrackedFiles(t, []string{
		"configuration/environments/homelab.yaml.example",
		"configuration/environments/localdev.yaml",
		"configuration/archive.tar.example",
		"configuration/notes.txt.example",
	}, nil)

	got, err := ListGuardFiles("/repo", nil)
	if err != nil {
		t.Fatalf("ListGuardFiles: %v", err)
	}
	want := []string{
		"configuration/environments/homelab.yaml.example",
		"configuration/environments/localdev.yaml",
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("file[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestPlaceholderMarkersJudgeTheReducedHost pins that the template and
// non-template paths agree. A marker in a mailbox local part or a URL path used
// to make the template laxer than a plain file, which is backwards: the
// template is the higher-risk file.
func TestPlaceholderMarkersJudgeTheReducedHost(t *testing.T) {
	tests := []struct {
		name  string
		key   string
		value string
		// wantReported is true when the value must be a finding in BOTH the
		// template path and the plain path.
		wantReported bool
	}{
		{
			name:         "marker in the mailbox local part, real host",
			key:          "ACME_EMAIL",
			value:        "REPLACEME-name@realcorp-internal.com",
			wantReported: true,
		},
		{
			name:         "marker in the URL path, real host",
			key:          "EXTERNAL_DNS_DEFAULT_TARGET",
			value:        "real.corp.com/REPLACEME-path",
			wantReported: true,
		},
		{
			name:         "marker embedded mid-label, real host",
			key:          "DOMAIN",
			value:        "evil-REPLACEME-domain.com",
			wantReported: true,
		},
		{
			name:         "marker in a URL path with a port",
			key:          "EXTERNAL_DNS_DEFAULT_TARGET",
			value:        "real.corp.com:8443/REPLACEME-path",
			wantReported: true,
		},
		// The template's own values must still pass, or the rule is
		// unenforceable.
		{
			name:         "the template's placeholder mailbox",
			key:          "ACME_EMAIL",
			value:        "admin@REPLACEME-domain.com",
			wantReported: false,
		},
		{
			name:         "the template's placeholder target",
			key:          "EXTERNAL_DNS_DEFAULT_TARGET",
			value:        "REPLACEME-subdomain.duckdns.org",
			wantReported: false,
		},
		{
			name:         "the template's placeholder domain",
			key:          "DOMAIN",
			value:        "REPLACEME-domain.com",
			wantReported: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			content := tc.key + ": " + tc.value + "\n"
			dir := t.TempDir()

			// Template path: judged against the placeholder allowlist.
			tmpl := filepath.Join(dir, "homelab.yaml.example")
			if err := os.WriteFile(tmpl, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			tmplRes, err := ScanFileForPIIShape(tmpl)
			if err != nil {
				t.Fatalf("scanning the template: %v", err)
			}
			if got := len(tmplRes.Matches) > 0; got != tc.wantReported {
				t.Errorf("template path reported=%v, want %v (matches: %+v)", got, tc.wantReported, tmplRes.Matches)
			}

			// Plain path: judged by shape.
			plain := filepath.Join(dir, "homelab.yaml")
			if err := os.WriteFile(plain, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
			plainRes, err := ScanFileForPIIShape(plain)
			if err != nil {
				t.Fatalf("scanning the plain file: %v", err)
			}
			if got := len(plainRes.Matches) > 0; got != tc.wantReported {
				t.Errorf("plain path reported=%v, want %v (matches: %+v)", got, tc.wantReported, plainRes.Matches)
			}

			// The template must never be laxer than a plain file.
			if len(tmplRes.Matches) < len(plainRes.Matches) {
				t.Errorf("template path cleared what the plain path reported: %q", tc.value)
			}
		})
	}
}

func TestRetiredMarkersNoLongerExcuseRealHosts(t *testing.T) {
	// Every one of these is a registrable domain, which is why the
	// natural-language markers were replaced by the single REPLACEME token.
	// Both paths must report them: the shape rule because they are real
	// hostnames, the template allowlist because they are not documented
	// placeholders.
	realHosts := []string{
		// The retired markers themselves.
		"yourdomain.com",
		"changeme.io",
		"replace-me.net",
		"todo.com",
		// Hosts that merely contain a retired marker's letters, which the old
		// substring test cleared outright.
		"mytodolist.com",
		"custodoservices.com",
		"todolist.com",
		"custodian.co.uk",
		"notyourdomain.com",
		"exchangemevents.com",
		// And the same collision shape against the new token.
		"notreplaceme.com",
		"replacemenow.com",
	}

	for _, host := range realHosts {
		t.Run(host, func(t *testing.T) {
			if !isRealHostname(host) {
				t.Errorf("isRealHostname(%q) = false; a registrable domain must not be excused", host)
			}
			if isExamplePlaceholder(host) {
				t.Errorf("isExamplePlaceholder(%q) = true; a real host is not a documented placeholder", host)
			}
		})
	}
}

func TestDotfileTemplatesAreOutOfScope(t *testing.T) {
	// Documented limitation, asserted so the behaviour is deliberate rather
	// than accidental: a dotfile template has no inner extension to look
	// through, so hasScannableExtension does not reach it.
	for _, path := range []string{".envrc.example", ".env.example", ".npmrc.sample"} {
		if hasScannableExtension(path) {
			t.Errorf("hasScannableExtension(%q) = true; expected the documented gap", path)
		}
	}
	// A template with an inner extension is reached.
	if !hasScannableExtension("configuration/environments/homelab.yaml.example") {
		t.Error("a template with an inner extension must be in scope")
	}
}

// ---------------------------------------------------------------------------
// Pattern-set hygiene: a config set must be scannable against itself
// ---------------------------------------------------------------------------

// TestGuardPatternsFromASetDoNotFlagThatSet is the regression that turned the
// committed tree red: `config guard --set localdev --ci` reported 26 findings
// in 2 files, because the patterns were built from localdev.yaml and then
// hunted for in localdev.yaml and in prose in defaults.yaml.
func TestGuardPatternsFromASetDoNotFlagThatSet(t *testing.T) {
	dir := t.TempDir()
	envDir := filepath.Join(dir, "configuration", "environments")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}

	defaults := filepath.Join(envDir, "defaults.yaml")
	defaultsBody := "# Override per-environment in homelab.yaml or localdev.yaml.\n" +
		"CLUSTER_NAME: homelab\n"
	if err := os.WriteFile(defaults, []byte(defaultsBody), 0o644); err != nil {
		t.Fatal(err)
	}

	env := filepath.Join(envDir, "localdev.yaml")
	envBody := `# ConfigSet "localdev" — Kind + Tilt local development.
DOMAIN: homelab.local
GATEWAY_IP: "127.0.0.1"
TRUENAS_IP: "127.0.0.1"
LB_POOL_END: "127.0.0.200"
NFS_MAPALL_USER: localdev
ACME_EMAIL: test@homelab.local
DUCKDNS_SUBDOMAIN: homelab-dev
EXTERNAL_DNS_DEFAULT_TARGET: homelab-dev.duckdns.org
`
	if err := os.WriteFile(env, []byte(envBody), 0o644); err != nil {
		t.Fatal(err)
	}

	report, err := RunGuard(GuardOptions{
		RepoRoot: dir,
		Files:    []string{"configuration/environments/localdev.yaml", "configuration/environments/defaults.yaml"},
		EnvPath:  env,
	})
	if err != nil {
		t.Fatalf("RunGuard: %v", err)
	}
	if n := report.MatchCount(); n != 0 {
		t.Errorf("MatchCount() = %d, want 0; findings: %+v", n, report.Results)
	}
}

// TestGuardStillFindsAPlantedValueOutsideTheSourceFiles proves the exemption
// above narrows nothing that matters: a real value pasted into a chart values
// file is still reported.
func TestGuardStillFindsAPlantedValueOutsideTheSourceFiles(t *testing.T) {
	dir := t.TempDir()
	envDir := filepath.Join(dir, "configuration", "environments")
	if err := os.MkdirAll(envDir, 0o755); err != nil {
		t.Fatal(err)
	}
	env := filepath.Join(envDir, "homelab.yaml")
	if err := os.WriteFile(env, []byte("DOMAIN: ryanmcafee.com\nTRUENAS_IP: 172.16.100.150\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	chartDir := filepath.Join(dir, "charts", "addons")
	if err := os.MkdirAll(chartDir, 0o755); err != nil {
		t.Fatal(err)
	}
	planted := filepath.Join(chartDir, "values-homelab.yaml")
	body := "nfs:\n  server: truenas.ryanmcafee.com\n  portal: 172.16.100.150:3260\n"
	if err := os.WriteFile(planted, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	report, err := RunGuard(GuardOptions{
		RepoRoot: dir,
		Files:    []string{"charts/addons/values-homelab.yaml"},
		EnvPath:  env,
	})
	if err != nil {
		t.Fatalf("RunGuard: %v", err)
	}
	if n := report.MatchCount(); n != 2 {
		t.Fatalf("MatchCount() = %d, want 2 (one per planted line); findings: %+v", n, report.Results)
	}
}

// TestRunGuardIsDeterministic asserts the property CI depends on: the same
// tree scanned ten times prints the same report, so a guard failure is
// reproducible and a passing run cannot flip on map iteration order.
func TestRunGuardIsDeterministic(t *testing.T) {
	dir := t.TempDir()
	env := filepath.Join(dir, "homelab.yaml")
	if err := os.WriteFile(env, []byte("DOMAIN: ryanmcafee.com\nTRUENAS_IP: 172.16.100.150\nCP_VIP: 172.16.100.10\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"b.yaml": "host: truenas.ryanmcafee.com\nportal: 172.16.100.150\n",
		"a.yaml": "vip: 172.16.100.10\nGATEWAY_IP: 172.16.100.1\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	render := func() string {
		report, err := RunGuard(GuardOptions{
			RepoRoot: dir,
			Files:    []string{"b.yaml", "a.yaml"},
			EnvPath:  env,
		})
		if err != nil {
			t.Fatalf("RunGuard: %v", err)
		}
		var sb strings.Builder
		for _, res := range report.Results {
			for _, m := range res.Matches {
				fmt.Fprintf(&sb, "%s:%d:%s\n", res.File, m.Line, m.Pattern)
			}
		}
		return sb.String()
	}

	first := render()
	if strings.TrimSpace(first) == "" {
		t.Fatal("the fixture must produce findings for this test to mean anything")
	}
	for i := 0; i < 9; i++ {
		if got := render(); got != first {
			t.Fatalf("run %d differs from run 0:\n--- run 0 ---\n%s--- run %d ---\n%s", i+1, first, i+1, got)
		}
	}
}

func TestBuildGuardPatternsRejectsNonIdentifyingValues(t *testing.T) {
	patterns := BuildGuardPatterns(map[string]string{
		"GATEWAY_IP":                  "127.0.0.1",   // loopback on a PII-shaped key
		"CP_VIP":                      "0.0.0.0",     // unspecified
		"LINK_IP":                     "169.254.1.1", // link-local
		"DOMAIN":                      "homelab.local",
		"ACME_EMAIL":                  "test@homelab.local",
		"EXAMPLE_HOSTNAME":            "REPLACEME-domain.com",    // placeholder marker
		"EXTERNAL_DNS_DEFAULT_TARGET": "homelab-dev.duckdns.org", // committed-safe
		"SHORT_HOSTNAME":              "abc",                     // under MinGuardPatternLen
		"TRUENAS_IP":                  "172.16.100.150",          // the one real value
	})

	want := []string{"172.16.100.150"}
	if len(patterns) != 1 || patterns[0] != want[0] {
		t.Errorf("BuildGuardPatterns = %v, want %v", patterns, want)
	}
}

func TestBuildGuardPatternsIsSorted(t *testing.T) {
	patterns := BuildGuardPatterns(map[string]string{
		"A_IP":   "172.16.100.150",
		"B_IP":   "172.16.100.10",
		"DOMAIN": "ryanmcafee.com",
	})
	if !sort.StringsAreSorted(patterns) {
		t.Errorf("BuildGuardPatterns = %v, want sorted", patterns)
	}
}

func TestLineMatchesPatternRespectsTokenBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		line    string
		pattern string
		want    bool
	}{
		{"whole token", "portal: 172.16.100.150:3260", "172.16.100.150", true},
		{"longer address is not a match", "ip: 172.16.100.1500", "172.16.100.150", false},
		{"shorter prefix of an address", "ip: 172.16.100.100", "172.16.100.10", false},
		{"parent domain inside a subdomain", "host: plex.ryanmcafee.com", "ryanmcafee.com", true},
		{"word inside a longer identifier", "name: mylocaldevcluster", "localdev", false},
		{"word inside a hyphenated identifier", "name: my-localdev-cluster", "localdev", true},
		{"word followed by a dot", "see localdev.yaml", "localdev", true},
		{"open-ended subnet prefix still matches", "ip: 172.16.100.150", "172.16.100.", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := lineMatchesPattern(tc.line, tc.pattern); got != tc.want {
				t.Errorf("lineMatchesPattern(%q, %q) = %v, want %v", tc.line, tc.pattern, got, tc.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Helm values keys (charts/**/values-homelab.yaml)
// ---------------------------------------------------------------------------

// scanShapeFixture writes content under filename in a temp dir and scans it
// by shape, failing the test on any error.
func scanShapeFixture(t *testing.T, filename, content string) GuardResult {
	t.Helper()
	path := filepath.Join(t.TempDir(), filename)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ScanFileForPIIShape(path)
	if err != nil {
		t.Fatalf("ScanFileForPIIShape: %v", err)
	}
	return res
}

// patternsOf lists the Pattern of every match, in report order.
func patternsOf(res GuardResult) []string {
	var out []string
	for _, m := range res.Matches {
		out = append(out, m.Pattern)
	}
	return out
}

func TestScanFileForPIIShapeHelmKeys(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []string // exact Pattern of every expected match, in order
	}{
		// --- hits: the shapes the child charts' values-homelab.yaml carried ---
		{
			name:    "nested host with a real hostname",
			content: "dashboard:\n  enabled: true\n  host: gateway.ryanmcafee.com\n",
			want:    []string{"host (real hostname)"},
		},
		{
			name:    "iSCSI portal with a port is judged on its address",
			content: "volumes:\n  - name: config\n    csi:\n      volumeAttributes:\n        portal: \"172.16.100.150:3260\"\n",
			want:    []string{"portal (routable host IP)"},
		},
		{
			name:    "camelCase staticIP",
			content: "dashboard:\n  staticIP: \"172.16.100.200\"\n",
			want:    []string{"staticIP (routable host IP)"},
		},
		{
			name:    "mailbox on email is judged on its domain",
			content: "letsencrypt:\n  email: admin@ryanmcafee.com\n",
			want:    []string{"email (real hostname)"},
		},
		{
			name:    "domain under global",
			content: "global:\n  domain: ryanmcafee.com\n",
			want:    []string{"domain (real hostname)"},
		},
		{
			name:    "hostname deep inside an ingress block",
			content: "argocd:\n  values:\n    server:\n      ingress:\n        enabled: true\n        hostname: argocd.ryanmcafee.com\n",
			want:    []string{"hostname (real hostname)"},
		},
		{
			name:    "an annotation ending in /hostname is judged as hostname",
			content: "annotations:\n  external-dns.alpha.kubernetes.io/hostname: argocd.ryanmcafee.com\n",
			want:    []string{"external-dns.alpha.kubernetes.io/hostname (real hostname)"},
		},
		{
			name:    "a URL wrapping a real address on host",
			content: "unifi:\n  host: \"https://172.16.100.1\"\n",
			want:    []string{"host (routable host IP)"},
		},
		{
			name:    "a dotted subdomain names a real host",
			content: "duckdns:\n  subdomain: home.ryanmcafee.com\n",
			want:    []string{"subdomain (real hostname)"},
		},
		{
			name:    "targetPortal, loadBalancerIP and externalIP",
			content: "storage:\n  targetPortal: \"172.16.100.150:3260\"\nservice:\n  loadBalancerIP: 172.16.100.201\n  externalIP: 172.16.100.202\n",
			want:    []string{"targetPortal (routable host IP)", "loadBalancerIP (routable host IP)", "externalIP (routable host IP)"},
		},
		{
			name:    "a host key inside a list of maps",
			content: "ingress:\n  hosts:\n    - host: sonarr.ryanmcafee.com\n      paths:\n        - path: /\n",
			want:    []string{"host (real hostname)"},
		},
		{
			name:    "inline comment and quotes are stripped",
			content: "oidc:\n  host: 'auth.ryanmcafee.com' # SSO front door\n",
			want:    []string{"host (real hostname)"},
		},
		{
			name:    "several leaks are all reported in line order",
			content: "global:\n  domain: ryanmcafee.com\ndashboard:\n  host: gateway.ryanmcafee.com\n  staticIP: \"172.16.100.200\"\n",
			want:    []string{"domain (real hostname)", "host (real hostname)", "staticIP (routable host IP)"},
		},

		// --- misses: placeholders, reserved names and keys outside the set ---
		{
			name:    "the documentation domain",
			content: "global:\n  domain: example.com\n",
			want:    nil,
		},
		{
			name:    "a reserved test suffix",
			content: "dashboard:\n  host: gateway.homelab.test\n",
			want:    nil,
		},
		{
			name:    "a reserved local suffix and a REPLACEME marker",
			content: "dashboard:\n  host: gateway.homelab.local\noidc:\n  host: auth.REPLACEME-domain.com\n",
			want:    nil,
		},
		{
			name:    "repoUrl, providerURL, server and url are not PII keys",
			content: "repoUrl: https://github.com/ryanmcafee/homelab\noidc:\n  providerURL: https://accounts.google.com\nletsencrypt:\n  server: https://acme-v02.api.letsencrypt.org/directory\nurl: https://grafana.ryanmcafee.com\n",
			want:    nil,
		},
		{
			name:    "description prose naming a host is not a value",
			content: "description: reachable at truenas.ryanmcafee.com\n",
			want:    nil,
		},
		{
			name:    "empty and quoted-empty values",
			content: "volumes:\n  - csi:\n      volumeAttributes:\n        portal: \"\"\n        portals: ''\nemail:\n",
			want:    nil,
		},
		{
			name:    "loopback, unspecified and the localdev static address",
			content: "dashboard:\n  staticIP: \"127.0.0.200\"\nlistener:\n  address: 0.0.0.0\nunifi:\n  host: https://127.0.0.1\n",
			want:    nil,
		},
		{
			name:    "a bare DuckDNS label is not a hostname by shape",
			content: "duckdns:\n  subdomain: ryanmcafee\n",
			want:    nil, // value-based detection (DUCKDNS_SUBDOMAIN) covers it when the env file is present
		},
		{
			name:    "a key that only opens a nested block carries no value",
			content: "host:\n  name: x\nportal:\n  enabled: true\n",
			want:    nil,
		},
		{
			name:    "a key:value token without a space is not a mapping",
			content: "cmd: host:gateway.ryanmcafee.com\n",
			want:    nil,
		},
		{
			name:    "markdown table rows and JSON strings are not key/value lines",
			content: "| host | gateway.ryanmcafee.com |\n{\"host\": \"gateway.ryanmcafee.com\"}\n",
			want:    nil,
		},
		{
			name:    "a comment naming a host is skipped",
			content: "# host: gateway.ryanmcafee.com\ndashboard:\n  # portal: 172.16.100.150:3260\n  enabled: true\n",
			want:    nil,
		},

		// --- the two rules never both fire on one line ---
		{
			name:    "a SCREAMING key is decided by the config rule alone",
			content: "DOMAIN: ryanmcafee.com\nIP: 172.16.100.1\nHOST: gateway.ryanmcafee.com\n",
			// DOMAIN is PII-shaped for the config rule; the bare IP and HOST
			// are not, and the Helm rule does not second-guess them.
			want: []string{"DOMAIN (real hostname)"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := patternsOf(scanShapeFixture(t, "values-homelab.yaml", tc.content))
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Fatalf("patterns = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestScanFileForPIIShapeHelmListKeys(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []string
	}{
		{
			name:    "a real zone under dnsZones",
			content: "cloudflare:\n  dnsZones:\n    - ryanmcafee.com\n",
			want:    []string{"dnsZones[] (real hostname)"},
		},
		{
			name:    "every item is judged and reported in order",
			content: "oidc:\n  allowedDomains:\n    - example.com\n    - ryanmcafee.com\n    - \"home.ryanmcafee.com\"\n",
			want:    []string{"allowedDomains[] (real hostname)", "allowedDomains[] (real hostname)"},
		},
		{
			name:    "items at the same column as the key",
			content: "dnsZones:\n- ryanmcafee.com\n",
			want:    []string{"dnsZones[] (real hostname)"},
		},
		{
			name:    "a hosts list opened by a list item, as in ingress extraTls",
			content: "extraTls:\n  - hosts:\n      - argocd.ryanmcafee.com\n    secretName: argocd-server-tls\n",
			want:    []string{"hosts[] (real hostname)"},
		},
		{
			name:    "portals as a list of addresses with ports",
			content: "portals:\n  - 172.16.100.150:3260\n  - 172.16.100.151:3260\n",
			want:    []string{"portals[] (routable host IP)", "portals[] (routable host IP)"},
		},
		{
			name:    "a flow-style list on the key line",
			content: "oidc:\n  allowedDomains: [example.com, ryanmcafee.com]\n",
			want:    []string{"allowedDomains[] (real hostname)"},
		},
		{
			name:    "the list closes at the next key",
			content: "dnsZones:\n  - example.com\nscopes:\n  - ryanmcafee.com\n",
			want:    nil,
		},
		{
			name:    "the list closes when a shallower item follows",
			content: "a:\n  dnsZones:\n    - example.com\n- ryanmcafee.com\n",
			want:    nil,
		},
		{
			name:    "items under a key outside the list set are not judged",
			content: "oidc:\n  scopes:\n    - openid\n    - ryanmcafee.com\n",
			want:    nil,
		},
		{
			name:    "placeholder and reserved items are clean",
			content: "dnsZones:\n  - example.com\n  - homelab.local\n  - REPLACEME-domain.com\nallowedDomains: [homelab.test]\nportals: []\n",
			want:    nil,
		},
		{
			name:    "blank and comment lines do not close the list",
			content: "dnsZones:\n  # primary zone\n\n  - ryanmcafee.com\n",
			want:    []string{"dnsZones[] (real hostname)"},
		},
		{
			name:    "a list of maps is judged by the key rule, not the list rule",
			content: "hosts:\n  - host: sonarr.ryanmcafee.com\n    paths: [/]\n",
			want:    []string{"host (real hostname)"},
		},
		{
			name:    "a flow list spanning lines",
			content: "cloudflare:\n  dnsZones: [\n    example.com,\n    ryanmcafee.com,\n  ]\n",
			want:    []string{"dnsZones[] (real hostname)"},
		},
		{
			name:    "a flow list spanning lines reports each line once and closes at the bracket",
			content: "dnsZones: [ryanmcafee.com,\n  a.ryanmcafee.com, b.ryanmcafee.com]\nscopes: [\n  ryanmcafee.com]\n",
			want:    []string{"dnsZones[] (real hostname)", "dnsZones[] (real hostname)"},
		},
		{
			name:    "a flow mapping item is judged by its keys",
			content: "hosts:\n  - {host: radarr.ryanmcafee.com, paths: [/]}\n",
			want:    []string{"host (real hostname)"},
		},
		{
			name:    "a flow mapping item is judged in any list",
			content: "rules:\n  - {host: radarr.ryanmcafee.com}\n",
			want:    []string{"host (real hostname)"},
		},
		{
			name:    "a flow list inside a flow mapping item",
			content: "tls:\n  - {hosts: [plex.ryanmcafee.com], secretName: plex-tls}\n",
			want:    []string{"hosts[] (real hostname)"},
		},
		{
			name:    "a flow mapping on the key line",
			content: "dashboard: {enabled: true, host: gateway.ryanmcafee.com}\n",
			want:    []string{"host (real hostname)"},
		},
		{
			name:    "a flow mapping with placeholder values and safe keys is clean",
			content: "hosts:\n  - {host: plex.homelab.test, paths: [/]}\nsource: {repoUrl: https://github.com/x/y, host: 0.0.0.0}\n",
			want:    nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := patternsOf(scanShapeFixture(t, "values-homelab.yaml", tc.content))
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Fatalf("patterns = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestScanTemplateFileHelmKeysRequirePlaceholders(t *testing.T) {
	// In a template the Helm rule inverts exactly as the config rule does:
	// a documented placeholder passes, anything else is reported by Note.
	tests := []struct {
		name     string
		content  string
		wantKeys []string
		wantVals []string
	}{
		{
			name:    "documented placeholders on Helm keys pass",
			content: "global:\n  domain: example.com\ndashboard:\n  host: gateway.REPLACEME-domain.com\n  staticIP: \"192.168.1.200\"\nletsencrypt:\n  email: admin@example.com\nvolumes:\n  - csi:\n      volumeAttributes:\n        portal: \"192.168.1.100:3260\"\ndnsZones:\n  - example.com\n  - homelab.local\n",
		},
		{
			name:     "a real hostname pasted into a template",
			content:  "dashboard:\n  host: gateway.ryanmcafee.com\n",
			wantKeys: []string{"host"},
			wantVals: []string{"gateway.ryanmcafee.com"},
		},
		{
			name:     "an address outside the documentation subnet",
			content:  "volumes:\n  - csi:\n      volumeAttributes:\n        portal: \"172.16.100.150:3260\"\n",
			wantKeys: []string{"portal"},
			wantVals: []string{"172.16.100.150:3260"},
		},
		{
			name:     "a real zone in a list",
			content:  "dnsZones:\n  - example.com\n  - ryanmcafee.com\n",
			wantKeys: []string{"dnsZones[]"},
			wantVals: []string{"ryanmcafee.com"},
		},
		{
			name:     "a bare label, which shape detection cannot see in a plain file",
			content:  "duckdns:\n  subdomain: ryanmcafee\n",
			wantKeys: []string{"subdomain"},
			wantVals: []string{"ryanmcafee"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := scanShapeFixture(t, "values-homelab.yaml.example", tc.content)
			if len(res.Matches) != len(tc.wantKeys) {
				t.Fatalf("got %d match(es) %+v, want %d for %v", len(res.Matches), res.Matches, len(tc.wantKeys), tc.wantKeys)
			}
			for i, key := range tc.wantKeys {
				m := res.Matches[i]
				if want := key + " (non-placeholder value in example file)"; m.Pattern != want {
					t.Errorf("match[%d].Pattern = %q, want %q", i, m.Pattern, want)
				}
				if want := "non-placeholder value in example file (" + tc.wantVals[i] + ")"; m.Note != want {
					t.Errorf("match[%d].Note = %q, want %q", i, m.Note, want)
				}
			}
		})
	}
}

func TestRunGuardHelmValuesAreDeterministic(t *testing.T) {
	// No environment file: only the shape rules run, over files handed in
	// out of order, with the config rule and the Helm rule both firing.
	dir := t.TempDir()
	for name, body := range map[string]string{
		"charts/b/values-homelab.yaml": "global:\n  domain: ryanmcafee.com\ndashboard:\n  host: gateway.ryanmcafee.com\n  staticIP: \"172.16.100.200\"\ndnsZones:\n  - ryanmcafee.com\n",
		"charts/a/values-homelab.yaml": "volumes:\n  - csi:\n      volumeAttributes:\n        portal: \"172.16.100.150:3260\"\n",
		"configuration/x.yaml":         "TRUENAS_IP: 172.16.100.150\nhost: truenas.ryanmcafee.com\n",
	} {
		path := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	render := func() string {
		report, err := RunGuard(GuardOptions{
			RepoRoot: dir,
			Files:    []string{"configuration/x.yaml", "charts/b/values-homelab.yaml", "charts/a/values-homelab.yaml"},
		})
		if err != nil {
			t.Fatalf("RunGuard: %v", err)
		}
		var sb strings.Builder
		for _, res := range report.Results {
			for _, m := range res.Matches {
				fmt.Fprintf(&sb, "%s:%d:%s\n", res.File, m.Line, m.Pattern)
			}
		}
		return sb.String()
	}

	want := strings.Join([]string{
		"charts/a/values-homelab.yaml:4:portal (routable host IP)",
		"charts/b/values-homelab.yaml:2:domain (real hostname)",
		"charts/b/values-homelab.yaml:4:host (real hostname)",
		"charts/b/values-homelab.yaml:5:staticIP (routable host IP)",
		"charts/b/values-homelab.yaml:7:dnsZones[] (real hostname)",
		"configuration/x.yaml:1:TRUENAS_IP (routable host IP)",
		"configuration/x.yaml:2:host (real hostname)",
		"",
	}, "\n")
	first := render()
	if first != want {
		t.Fatalf("report:\n%s\nwant:\n%s", first, want)
	}
	for i := 0; i < 9; i++ {
		if got := render(); got != first {
			t.Fatalf("run %d differs from run 0:\n--- run 0 ---\n%s--- run %d ---\n%s", i+1, first, i+1, got)
		}
	}
}

func TestDefaultGuardScopeCoversChartHomelabValues(t *testing.T) {
	// The child charts' values-homelab.yaml files are committed and rendered
	// in production without the CMP, so they must be guarded by default, not
	// only when someone remembers --paths. scripts/ is in scope for the same
	// reason: a TypeScript script hardcoding a real address leaks exactly as much,
	// and several did while scripts/ was out of scope. .github/ is in scope
	// because the README header SVG spells out hostnames as <DOMAIN>
	// placeholders and the guard is what keeps a real one out of it.
	want := []string{
		"configuration/**",
		"charts/**/values-homelab.yaml",
		"scripts/**",
		"docs/**",
		".github/**",
		"Taskfile.yml",
		"ansible/**",
		"terragrunt/**",
	}
	if strings.Join(DefaultGuardPathspecs, " ") != strings.Join(want, " ") {
		t.Fatalf("DefaultGuardPathspecs = %v, want %v", DefaultGuardPathspecs, want)
	}

	calls := withTrackedFiles(t, []string{
		"configuration/environments/localdev.yaml",
		"charts/envoy-gateway-config/values-homelab.yaml",
		"charts/sonarr-config/values-homelab.yaml",
		".github/homelab.svg",
		".github/workflows/verify.yml",
		".github/CODEOWNERS", // excluded: not a scannable extension
	}, nil)
	files, err := ListGuardFiles("/repo", nil)
	if err != nil {
		t.Fatalf("ListGuardFiles: %v", err)
	}
	if got := strings.Join((*calls)[0], " "); got != strings.Join(want, " ") {
		t.Fatalf("lister pathspecs = %q, want %q", got, want)
	}
	wantFiles := []string{
		".github/homelab.svg",
		".github/workflows/verify.yml",
		"charts/envoy-gateway-config/values-homelab.yaml",
		"charts/sonarr-config/values-homelab.yaml",
		"configuration/environments/localdev.yaml",
	}
	if strings.Join(files, " ") != strings.Join(wantFiles, " ") {
		t.Fatalf("files = %v, want %v", files, wantFiles)
	}
}

// TestScanFileForPIIShapeHelmRuleEdges pins the edge cases found in review:
// a CIDR is a network and never a host, a flow list is reported once per
// line, in-cluster .svc names identify nothing outside the cluster, and a
// quoted annotation key is judged like an unquoted one.
func TestScanFileForPIIShapeHelmRuleEdges(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []string
	}{
		{
			name:    "CIDR under ip or address is a network, not a host",
			content: "ip: 172.16.100.0/24\naddress: 10.0.0.0/8\n",
			want:    nil,
		},
		{
			name:    "flow list with two real hostnames is one finding",
			content: "dnsZones: [ryanmcafee.com, \"x.ryanmcafee.com\"]\n",
			want:    []string{"dnsZones[] (real hostname)"},
		},
		{
			name:    "in-cluster .svc names are reserved",
			content: "host: oauth2-proxy.oauth2-proxy.svc\naddress: alertmanager.monitoring.svc:9093\n",
			want:    nil,
		},
		{
			name:    "quoted annotation key is judged by its last segment",
			content: "annotations:\n  \"external-dns.alpha.kubernetes.io/hostname\": plex.ryanmcafee.com\n",
			want:    []string{"external-dns.alpha.kubernetes.io/hostname (real hostname)"},
		},
		{
			name:    "single-quoted key too",
			content: "  'host': gateway.ryanmcafee.com\n",
			want:    []string{"host (real hostname)"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := patternsOf(scanShapeFixture(t, "values-homelab.yaml", tc.content))
			if strings.Join(got, "\n") != strings.Join(tc.want, "\n") {
				t.Fatalf("patterns:\n got %q\nwant %q", got, tc.want)
			}
		})
	}
}

// TestGuardDoesNotHuntTheSetName: localdev sets NFS_MAPALL_USER to the set's
// own name, which would otherwise become a value pattern and flag every
// comment that mentions the environment (issue #263 hit this in
// configuration/schema/platform.schema.yaml). The other patterns from the same
// file must keep working.
func TestGuardDoesNotHuntTheSetName(t *testing.T) {
	dir := t.TempDir()
	envDir := filepath.Join(dir, "configuration", "environments")
	schemaDir := filepath.Join(dir, "configuration", "schema")
	for _, d := range []string{envDir, schemaDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	env := filepath.Join(envDir, "localdev.yaml")
	envBody := "NFS_MAPALL_USER: localdev\nDUCKDNS_SUBDOMAIN: homelab-dev\n"
	if err := os.WriteFile(env, []byte(envBody), 0o644); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name      string
		body      string
		wantCount int
	}{
		{
			name:      "prose naming the environment file is not a finding",
			body:      "# Overridden in configuration/environments/localdev.yaml for Kind.\nkeys: {}\n",
			wantCount: 0,
		},
		{
			name:      "the set name on its own is not a finding",
			body:      "# The localdev set flips every capability below.\nkeys: {}\n",
			wantCount: 0,
		},
		{
			name:      "another value from the same file is still a finding",
			body:      "# Points at homelab-dev by default.\nkeys: {}\n",
			wantCount: 1,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			schema := filepath.Join(schemaDir, "platform.schema.yaml")
			if err := os.WriteFile(schema, []byte(tc.body), 0o644); err != nil {
				t.Fatal(err)
			}
			report, err := RunGuard(GuardOptions{
				RepoRoot: dir,
				Files:    []string{"configuration/schema/platform.schema.yaml"},
				EnvPath:  env,
			})
			if err != nil {
				t.Fatalf("RunGuard: %v", err)
			}
			if report.ValuePatterns != 1 {
				t.Errorf("ValuePatterns = %d, want 1 (homelab-dev only; the set name must be dropped)", report.ValuePatterns)
			}
			if n := report.MatchCount(); n != tc.wantCount {
				t.Errorf("MatchCount() = %d, want %d; findings: %+v", n, tc.wantCount, report.Results)
			}
		})
	}
}

func TestLineMatchesPatternForgeOwner(t *testing.T) {
	const owner = "ryanmcafee"
	tests := []struct {
		name    string
		line    string
		pattern string
		want    bool
	}{
		// The owner segment of a public code-forge URL is not a finding.
		{name: "repository URL in gitops values", line: "  repoUrl: https://github.com/ryanmcafee/homelab.git", pattern: owner, want: false},
		{name: "GitHub Pages Helm repository in a renovate comment", line: "  # renovate: datasource=helm depName=port-forwarding registryUrl=https://ryanmcafee.github.io/port-forwarding-controller", pattern: owner, want: false},
		{name: "repository URL without .git", line: `repo_url = "https://github.com/ryanmcafee/homelab"`, pattern: owner, want: false},
		{name: "owner URL at the end of the token", line: "see https://github.com/ryanmcafee", pattern: owner, want: false},
		{name: "owner repository named .git", line: "https://github.com/ryanmcafee.git", pattern: owner, want: false},
		{name: "SSH clone URL", line: "git@github.com:ryanmcafee/homelab.git", pattern: owner, want: false},
		{name: "pages host with a port", line: "https://ryanmcafee.github.io:443/charts", pattern: owner, want: false},
		{name: "host is matched case-insensitively", line: "https://GitHub.com/ryanmcafee/homelab", pattern: owner, want: false},
		{name: "GitLab repository", line: "https://gitlab.com/ryanmcafee/homelab.git", pattern: owner, want: false},
		{name: "GitLab pages", line: "https://ryanmcafee.gitlab.io/homelab", pattern: owner, want: false},
		{name: "GHCR image reference", line: `const IMAGE_REPO = "ghcr.io/ryanmcafee/homelab-cmp";`, pattern: owner, want: false},
		{name: "GHCR image with a tag", line: "image: ghcr.io/ryanmcafee/homelab-cmp:0.1.25", pattern: owner, want: false},
		{name: "GHCR owner at the end of the token", line: "see ghcr.io/ryanmcafee", pattern: owner, want: false},

		// The same value anywhere else is still a finding.
		{name: "bare value", line: "mapall: ryanmcafee", pattern: owner, want: true},
		{name: "value as a hostname label", line: "host: ryanmcafee.duckdns.org", pattern: owner, want: true},
		{name: "registry host has no pages form", line: "url: https://ryanmcafee.ghcr.io/x", pattern: owner, want: true},
		{name: "real domain is not excused by the registry entry", line: "host: truenas.ryanmcafee.com", pattern: "ryanmcafee.com", want: true},
		{name: "look-alike registry host", line: "https://notghcr.io/ryanmcafee/x", pattern: owner, want: true},
		{name: "value as a subdomain of a pages host", line: "https://sub.ryanmcafee.github.io/", pattern: owner, want: true},
		{name: "value before a look-alike pages domain", line: "https://ryanmcafee.github.io.example.com/", pattern: owner, want: true},
		{name: "another owner and the value elsewhere on the line", line: "https://github.com/other-owner/x # maintained by ryanmcafee", pattern: owner, want: true},
		{name: "value before another owner on the same line", line: "ryanmcafee: https://github.com/other-owner/x", pattern: owner, want: true},
		{name: "value inside the repository segment", line: "https://github.com/other-owner/ryanmcafee", pattern: owner, want: true},
		{name: "owner that merely starts with the value", line: "https://github.com/ryanmcafee-other/x", pattern: owner, want: true},
		{name: "look-alike host", line: "https://notgithub.com/ryanmcafee/x", pattern: owner, want: true},
		{name: "forge subdomain is not the forge", line: "https://api.github.com/ryanmcafee/x", pattern: owner, want: true},
		{name: "a domain is never an owner", line: "https://github.com/ryanmcafee.com/x", pattern: "ryanmcafee.com", want: true},
		{name: "a mailbox is never an owner", line: "https://github.com/admin@ryanmcafee.com", pattern: "admin@ryanmcafee.com", want: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := lineMatchesPattern(tc.line, tc.pattern); got != tc.want {
				t.Errorf("lineMatchesPattern(%q, %q) = %v, want %v", tc.line, tc.pattern, got, tc.want)
			}
		})
	}
}

func TestRunGuardForgeOwnerURLsAreNotFindings(t *testing.T) {
	dir := t.TempDir()
	// The owner name reaches the pattern set through any PII-shaped key that
	// happens to hold it: the NFS user and a dynamic-DNS label are both such keys.
	env := filepath.Join(dir, "homelab.yaml")
	if err := os.WriteFile(env, []byte("NFS_MAPALL_USER: ryanmcafee\nDUCKDNS_SUBDOMAIN: ryanmcafee\nDOMAIN: ryanmcafee.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		content string
		want    int
	}{
		{
			name: "the committed forge URLs pass",
			content: "  # renovate: datasource=helm depName=port-forwarding registryUrl=https://ryanmcafee.github.io/port-forwarding-controller\n" +
				"  repoUrl: https://github.com/ryanmcafee/homelab.git\n",
			want: 0,
		},
		{
			name:    "the same value outside a forge URL fails",
			content: "mapall: ryanmcafee\n",
			want:    1,
		},
		{
			name:    "another owner with the value elsewhere on the line fails",
			content: "repoUrl: https://github.com/other-owner/x # ryanmcafee\n",
			want:    1,
		},
		{
			// Both the domain and its first label are reported: neither is an
			// owner, since the value holds a dot and the label is followed by one.
			name:    "the domain inside a forge URL still fails",
			content: "repoUrl: https://github.com/ryanmcafee.com/x\n",
			want:    2,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := filepath.Join(t.TempDir(), "values-homelab.yaml")
			if err := os.WriteFile(f, []byte(tc.content), 0o644); err != nil {
				t.Fatal(err)
			}
			report, err := RunGuard(GuardOptions{RepoRoot: dir, Files: []string{f}, EnvPath: env})
			if err != nil {
				t.Fatalf("RunGuard: %v", err)
			}
			if report.EnvMissing || report.ValuePatterns == 0 {
				t.Fatalf("value patterns must be active: EnvMissing=%v ValuePatterns=%d", report.EnvMissing, report.ValuePatterns)
			}
			if n := report.MatchCount(); n != tc.want {
				t.Errorf("MatchCount() = %d, want %d; results: %+v", n, tc.want, report.Results)
			}
		})
	}
}

// TestShapeRulesNeedALiteralInCodeFiles pins the distinction that lets
// scripts/ be guarded at all: in YAML `host: foo.bar` is a value, but in
// TypeScript it is a property assignment naming an identifier. Judging the
// identifier blocked a commit over `host: args.proxmoxHost`.
func TestShapeRulesNeedALiteralInCodeFiles(t *testing.T) {
	tests := []struct {
		name    string
		file    string
		content string
		want    int
	}{
		{
			name:    "identifier in a flow mapping is not a hostname",
			file:    "run.ts",
			content: "  ssh: { user: args.sshUser, host: args.proxmoxHost },\n",
			want:    0,
		},
		{
			name:    "identifier as a block value is not a hostname",
			file:    "run.ts",
			content: "  host: args.proxmoxHost,\n",
			want:    0,
		},
		{
			name:    "a real hostname in a string literal is still caught",
			file:    "run.ts",
			content: "  host: \"truenas.acme-corp.net\",\n",
			want:    1,
		},
		{
			name:    "a routable address in a string literal is still caught",
			file:    "run.ts",
			content: "  host: \"203.0.113.9\",\n",
			want:    1,
		},
		{
			name:    "a literal in a flow mapping is still caught",
			file:    "run.ts",
			content: "  ssh: { user: u, host: \"truenas.acme-corp.net\" },\n",
			want:    1,
		},
		{
			name:    "a SCREAMING_SNAKE key needs a literal too",
			file:    "run.ts",
			content: "  PROXMOX_IP: args.proxmoxHost,\n",
			want:    0,
		},
		{
			// The quoting rule must not leak into YAML, where an unquoted
			// scalar is the normal way to write a value.
			name:    "yaml still judges an unquoted value",
			file:    "values-homelab.yaml",
			content: "host: truenas.acme-corp.net\n",
			want:    1,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, tc.file)
			if err := os.WriteFile(path, []byte(tc.content), 0o600); err != nil {
				t.Fatal(err)
			}
			res, err := ScanFileForPIIShape(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Matches) != tc.want {
				t.Fatalf("matches = %d, want %d (%v)", len(res.Matches), tc.want, res.Matches)
			}
		})
	}
}
