package config

import (
	"os"
	"path/filepath"
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
