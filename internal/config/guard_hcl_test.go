package config

import (
	"os"
	"path/filepath"
	"testing"
)

// Inventory names identify each source surface, not a mutable production row count.
func TestGuardHCLInventory(t *testing.T) {
	cases := []struct {
		name, source string
		want         int
	}{
		{"terragrunt.hcl", `locals { base_fqdn = "corp.acme.org" }`, 1},
		{"environments/homelab/env.hcl", `locals { truenas_ip = "10.23.1.4" }`, 1},
		{"modules/truenas/variables.tf", "variable \"truenas_hostname\" {\n type = string\n default = \"nas.acme.org\"\n}", 1},
		{"prefix.tf", `variable "lan_ip_address" { default = "10.23.1.4/24" }`, 1},
		{"nested.tfvars", `nodes = [{ ip = "10.23.1.5" }]`, 1},
		{"derived.hcl", `locals { truenas_hostname = "truenas.${local.base_fqdn}" }`, 0},
		{"reference.tfvars", `domain = var.domain`, 0},
		{"comment.hcl", "# domain = \"corp.acme.org\"\n", 0},
		{"unrelated.tf", "variable \"description\" { default = \"docs.acme.org\" }\nvariable \"domain\" { type = string }", 0},
		{"approved.tfvars.example", "domain = \"example.com\"\ntruenas_ip = \"192.168.1.50\"", 0},
		{"bad.tfvars.example", `domain = "corp.acme.org"`, 1},
		{"deployment.tfvars", `truenas_ip = "192.168.1.50"`, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tc.name)
			if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(tc.source), 0644); err != nil {
				t.Fatal(err)
			}
			got, err := ScanFileForPIIShape(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Matches) != tc.want {
				t.Fatalf("findings = %#v; want %d", got.Matches, tc.want)
			}
			for _, finding := range got.Matches {
				if finding.Line < 1 || finding.Content == "" {
					t.Fatalf("missing location: %#v", finding)
				}
			}
		})
	}
}

func TestGuardMalformedHCLFailsClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.tf")
	if err := os.WriteFile(path, []byte(`variable "domain" { default =`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := ScanFileForPIIShape(path); err == nil {
		t.Fatal("malformed HCL must fail")
	}
}

func TestGuardSourceMemoryExclusions(t *testing.T) {
	for _, path := range []string{"docs/project_notes/issues.md", "terragrunt/.claude/memory.md", "scripts/.serena/state.yaml", ".agents/notes.md"} {
		if !IsGuardExcluded(path) {
			t.Errorf("memory must be excluded: %s", path)
		}
	}
	for _, path := range []string{"terragrunt/modules/truenas/README.md", "docs/runbooks/verification.md", "terragrunt/terragrunt.hcl"} {
		if IsGuardExcluded(path) {
			t.Errorf("contributor source must remain in scope: %s", path)
		}
	}
}
