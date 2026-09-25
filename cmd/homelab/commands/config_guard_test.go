package commands

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfigGuardCLI(t *testing.T) {
	root, err := findProjectRoot()
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "homelab")
	build := exec.Command("go", "build", "-o", binary, "./cmd/homelab")
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	for _, tc := range []struct {
		name, body string
		bad        bool
	}{
		{"approved.yaml.example", "TRUENAS_IP: 192.168.1.50\nDOMAIN: example.com\n", false},
		{"deployment.yaml", "TRUENAS_IP: 192.168.1.50\n", true},
		{"hostname.yaml.example", "DOMAIN: corp.acme.org\n", true},
		{"email.yaml.example", "ACME_EMAIL: admin@corp.acme.org\n", true},
		{"address.yaml.example", "TRUENAS_IP: 10.23.1.4\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := t.TempDir()
			write := func(name, body string) {
				t.Helper()
				p := filepath.Join(fixture, name)
				if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, []byte(body), 0644); err != nil {
					t.Fatal(err)
				}
			}
			write("Taskfile.yml", "version: '3'\n")
			write("environment.yaml", "TRUENAS_IP: 192.168.1.50\nDOMAIN: corp.acme.org\nACME_EMAIL: admin@corp.acme.org\n")
			name := "scripts/" + tc.name
			write(name, tc.body)
			for _, args := range [][]string{{"init", "--quiet"}, {"add", "."}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "fixture"}} {
				cmd := exec.Command("git", args...)
				cmd.Dir = fixture
				if out, err := cmd.CombinedOutput(); err != nil {
					t.Fatalf("git: %v %s", err, out)
				}
			}
			for _, mode := range [][]string{{"--", name}, {"--ci", "--paths", "scripts/**"}} {
				args := append([]string{"config", "guard", "--env-file", filepath.Join(fixture, "environment.yaml")}, mode...)
				cmd := exec.Command(binary, args...)
				cmd.Dir = fixture
				output, err := cmd.CombinedOutput()
				text := string(output)
				if (err != nil) != tc.bad {
					t.Fatalf("mode=%v bad=%v err=%v\n%s", mode, tc.bad, err, text)
				}
				if tc.bad && (!strings.Contains(text, name+":1") || strings.Contains(text, "[OK]")) {
					t.Fatalf("unactionable failure or false success:\n%s", text)
				}
				if !strings.Contains(text, "Scanning 1 ") {
					t.Fatalf("scope was not one tracked/explicit file:\n%s", text)
				}
			}
		})
	}
}

func TestConfigValidatePoolCLI(t *testing.T) {
	root, err := findProjectRoot()
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "homelab")
	build := exec.Command("go", "build", "-o", binary, "./cmd/homelab")
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v %s", err, out)
	}
	fixture := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		p := filepath.Join(fixture, name)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write("schema/network.schema.yaml", `keys:
  LB_POOL_START:
    addressRole: lb-pool-range
  LB_POOL_END:
    addressRole: lb-pool-range
  NAS_ADDRESS:
    addressRole: infrastructure-address
  INGRESS_ADDRESS:
    addressRole: lb-allocation
  CP_VIP:
    addressRole: dedicated-pool-allocation
  LAN:
    addressRole: network-range
`)
	write("versions.yaml", "charts: {}\nimages: {}\ntools: {}\n")
	write("environments/defaults.yaml", "{}\n")
	for _, tc := range []struct {
		name, nas, ingress, end, enabled string
		bad                              bool
	}{
		{"valid allocation at end", "192.0.2.20/24", "192.0.2.200", "192.0.2.200", "true", false},
		{"valid allocation at start", "192.0.2.20", "192.0.2.100", "192.0.2.200", "true", false},
		{"NAS at start", "192.0.2.100", "192.0.2.150", "192.0.2.200", "true", true},
		{"NAS at end", "192.0.2.200", "192.0.2.150", "192.0.2.200", "true", true},
		{"NAS prefix host", "192.0.2.150/24", "192.0.2.200", "192.0.2.200", "true", true},
		{"LB outside", "192.0.2.20", "192.0.2.201", "192.0.2.200", "true", true},
		{"malformed endpoint", "192.0.2.20", "192.0.2.150", "192.0.2.999", "true", true},
		{"reversed range", "192.0.2.20", "192.0.2.150", "192.0.2.99", "true", true},
		{"unused pool", "192.0.2.150", "192.0.2.250", "bad", "false", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			write("environments/fixture.yaml", "CNI_PROVIDER: cilium\nLOAD_BALANCER_ENABLED: '"+tc.enabled+"'\nLB_POOL_START: 192.0.2.100\nLB_POOL_END: "+tc.end+"\nNAS_ADDRESS: "+tc.nas+"\nINGRESS_ADDRESS: "+tc.ingress+"\nCP_VIP: 192.0.2.10\nLAN: 192.0.2.0/24\n")
			cmd := exec.Command(binary, "config", "validate", "--config-root", fixture, "--set", "fixture")
			output, err := cmd.CombinedOutput()
			text := string(output)
			if (err != nil) != tc.bad {
				t.Fatalf("bad=%v err=%v\n%s", tc.bad, err, text)
			}
			if tc.bad && (strings.Contains(text, "[OK]") || strings.Contains(text, "Configuration valid") || !strings.Contains(text, "invalid LB pool configuration")) {
				t.Fatalf("false success or missing failure:\n%s", text)
			}
			if !tc.bad && !strings.Contains(text, "Configuration valid") {
				t.Fatalf("missing success:\n%s", text)
			}
		})
	}
}
