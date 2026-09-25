package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGuardTemplateLiteralContext(t *testing.T) {
	for _, tc := range []struct {
		name, body, pattern string
		bad                 bool
	}{
		{"approved.yaml.example", "TRUENAS_IP: 192.168.1.50\n", "192.168.1.50", false},
		{"deployment.yaml", "TRUENAS_IP: 192.168.1.50\n", "192.168.1.50", true},
		{"private.yaml.example", "TRUENAS_IP: 10.23.1.4\n", "10.23.1.4", true},
		{"domain.yaml.example", "DOMAIN: corp.acme.org\n", "corp.acme.org", true},
		{"email.yaml.example", "ACME_EMAIL: admin@corp.acme.org\n", "admin@corp.acme.org", true},
		{"suffix.yaml.example", "DOMAIN: example.com.attacker.net\n", "example.com.attacker.net", true},
		{"suffix-email.yaml.example", "ACME_EMAIL: admin@example.com.attacker.net\n", "admin@example.com.attacker.net", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc.name)
			if err := os.WriteFile(path, []byte(tc.body), 0644); err != nil {
				t.Fatal(err)
			}
			result, err := ScanFileForPII(path, []string{tc.pattern})
			if err != nil {
				t.Fatal(err)
			}
			if (len(result.Matches) > 0) != tc.bad {
				t.Fatalf("bad=%v matches=%#v", tc.bad, result.Matches)
			}
		})
	}
}
