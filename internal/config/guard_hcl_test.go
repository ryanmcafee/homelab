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
		{"approved.tfvars.example", "domain = \"example.com\"\ntruenas_ip = \"198.51.100.50\"", 0},
		{"bad.tfvars.example", `domain = "corp.acme.org"`, 1},
		{"deployment.tfvars", `truenas_ip = "198.51.100.50"`, 1},
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

// Every locals assignment in terragrunt/environments/homelab/env.hcl that
// resolves an operator identity out of the ConfigSet, with the reference
// replaced by the literal it exists to keep out. The shape rule is the half
// that runs in a clone with no homelab.yaml, so a key missing here is a key a
// regression can hard-code and still pass CI.
func TestGuardHCLCoversBootstrapIdentityKeys(t *testing.T) {
	cases := []struct{ key, literal string }{
		{"proxmox_host", `"10.23.1.2"`},
		{"proxmox_node", `"pve-01.corp.acme.org"`},
		{"subnet", `"10.23.1.4/24"`},
		{"gateway", `"10.23.1.1"`},
		{"cluster_endpoint", `"10.23.1.10"`},
		{"vip_endpoint", `"10.23.1.9"`},
		{"lb_pool_start", `"10.23.1.200"`},
		{"lb_pool_end", `"10.23.1.250"`},
		{"bgp_peer_ip", `"10.23.1.1"`},
		{"truenas_ip", `"10.23.1.4"`},
		{"base_fqdn", `"corp.acme.org"`},
		{"dns_servers", `["10.23.1.1"]`},
	}
	for _, tc := range cases {
		t.Run(tc.key, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "env.hcl")
			source := "locals {\n  " + tc.key + " = " + tc.literal + "\n}\n"
			if err := os.WriteFile(path, []byte(source), 0644); err != nil {
				t.Fatal(err)
			}
			got, err := ScanFileForPIIShape(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Matches) != 1 {
				t.Fatalf("%s = %s: findings = %#v; want 1", tc.key, tc.literal, got.Matches)
			}
		})
	}
}

// The same keys reading the ConfigSet, which is what the tree commits today.
// A traversal is an identifier, not a value, inside a list as well as outside.
func TestGuardHCLIgnoresConfigSetReferences(t *testing.T) {
	source := `locals {
  config           = jsondecode(file("resolved.json")).values
  proxmox_host     = local.config.PROXMOX_IP
  subnet           = local.config.LAN_CIDR
  gateway          = local.config.GATEWAY_IP
  cluster_endpoint = local.config.CP1_IP
  vip_endpoint     = local.config.CP_VIP
  lb_pool_start    = local.config.LB_POOL_START
  lb_pool_end      = local.config.LB_POOL_END
  dns_servers      = [local.config.DNS_SERVER_IP]
  proxmox_endpoint = "https://${local.config.PROXMOX_IP}:8006"
  vlan_id          = 100
}
`
	path := filepath.Join(t.TempDir(), "env.hcl")
	if err := os.WriteFile(path, []byte(source), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := ScanFileForPIIShape(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Matches) != 0 {
		t.Fatalf("findings = %#v; want none", got.Matches)
	}
}

// A literal beside a reference in the same list still reports: the list is
// judged element by element, not rejected because one element is unresolvable.
func TestGuardHCLJudgesFlowListPerElement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "env.hcl")
	source := "locals {\n  dns_servers = [\n    local.config.DNS_SERVER_IP,\n    \"10.23.1.1\",\n  ]\n}\n"
	if err := os.WriteFile(path, []byte(source), 0644); err != nil {
		t.Fatal(err)
	}
	got, err := ScanFileForPIIShape(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Matches) != 1 {
		t.Fatalf("findings = %#v; want 1", got.Matches)
	}
	if got.Matches[0].Line != 4 {
		t.Fatalf("line = %d; want 4 (the literal element, not the assignment)", got.Matches[0].Line)
	}
}

// terragrunt/environments/localdev/env.hcl commits subnet = "10.244.0.0/16":
// Kind's own pod network, identical in every fork and deliberately not a
// ConfigSet value. Shape cannot tell an operator's LAN CIDR from that one, so
// a network address is the value rule's business and must not red the gate.
// A host address carrying a netmask is a different literal and still reports.
func TestGuardHCLLeavesNetworkCIDRsToTheValueRule(t *testing.T) {
	cases := []struct {
		literal string
		want    int
	}{
		{`"10.244.0.0/16"`, 0},
		{`"10.23.1.0/24"`, 0},
		{`"10.23.1.4/24"`, 1},
	}
	for _, tc := range cases {
		t.Run(tc.literal, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "env.hcl")
			source := "locals {\n  subnet = " + tc.literal + "\n}\n"
			if err := os.WriteFile(path, []byte(source), 0644); err != nil {
				t.Fatal(err)
			}
			got, err := ScanFileForPIIShape(path)
			if err != nil {
				t.Fatal(err)
			}
			if len(got.Matches) != tc.want {
				t.Fatalf("findings = %#v; want %d", got.Matches, tc.want)
			}
		})
	}
}
