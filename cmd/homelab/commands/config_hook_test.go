package commands

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// CI installs pre-commit and enables this test. The ordinary Go suite remains
// runnable with Go alone; opt-in must fail, rather than skip, if the hook engine
// is unavailable. Only the launcher is replaced with a built CLI: production
// arguments, filename selection, and exclusions come from the real hook.
func TestConfigGuardPreCommit(t *testing.T) {
	if os.Getenv("CONFIG_GUARD_PRECOMMIT_TEST") != "1" {
		t.Skip("enable CONFIG_GUARD_PRECOMMIT_TEST=1 with pre-commit installed")
	}
	hookEngine, err := exec.LookPath("pre-commit")
	if err != nil {
		t.Fatal(err)
	}
	root, err := findProjectRoot()
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(t.TempDir(), "homelab")
	build := exec.Command("go", "build", "-o", binary, "./cmd/homelab")
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(root, ".pre-commit-config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Repos []struct {
			Repo  string                   `yaml:"repo"`
			Hooks []map[string]interface{} `yaml:"hooks"`
		} `yaml:"repos"`
	}
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	var hook map[string]interface{}
	for _, repo := range cfg.Repos {
		for _, candidate := range repo.Hooks {
			if candidate["id"] == "config-guard" {
				hook = candidate
			}
		}
	}
	if hook == nil {
		t.Fatal("production config-guard hook missing")
	}
	entry, ok := hook["entry"].(string)
	if !ok || !strings.HasPrefix(entry, "go run ./cmd/homelab ") {
		t.Fatalf("unexpected hook launcher: %v", hook["entry"])
	}
	hook["entry"] = strconv.Quote(binary) + " " + strings.TrimPrefix(entry, "go run ./cmd/homelab ")
	minimal := map[string]interface{}{"repos": []interface{}{map[string]interface{}{"repo": "local", "hooks": []interface{}{hook}}}}
	hookYAML, err := yaml.Marshal(minimal)
	if err != nil {
		t.Fatal(err)
	}
	fixture := t.TempDir()
	write := func(path, content string) {
		t.Helper()
		p := filepath.Join(fixture, path)
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	write(".pre-commit-config.yaml", string(hookYAML))
	write("Taskfile.yml", "version: '3'\n")
	write("configuration/environments/homelab.yaml", "TRUENAS_IP: 192.168.1.50\nDOMAIN: corp.acme.org\nACME_EMAIL: admin@corp.acme.org\n")
	init := exec.Command("git", "init", "--quiet")
	init.Dir = fixture
	if out, err := init.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v %s", err, out)
	}
	cases := []struct {
		name, body string
		bad        bool
	}{
		{"scripts/good.yaml.example", "TRUENAS_IP: 192.168.1.50\nDOMAIN: example.com\n", false},
		{"scripts/bad.yaml.example", "TRUENAS_IP: 10.23.1.4\nDOMAIN: corp.acme.org\nACME_EMAIL: admin@corp.acme.org\n", true},
		{"scripts/deployment.yaml", "TRUENAS_IP: 192.168.1.50\n", true},
		{"terragrunt/bad.tfvars", "domain = \"corp.acme.org\"\n", true},
		{"terragrunt/good.hcl", "locals { domain = local.domain }\n", false},
		{"terragrunt/bad.tf", "variable \"truenas_hostname\" { default = \"nas.acme.org\" }\n", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			write(tc.name, tc.body)
			cmd := exec.Command(hookEngine, "run", "config-guard", "--files", tc.name)
			cmd.Dir = fixture
			output, err := cmd.CombinedOutput()
			text := string(output)
			if (err != nil) != tc.bad || strings.Contains(text, "Skipped") {
				t.Fatalf("bad=%v err=%v\n%s", tc.bad, err, text)
			}
			if tc.bad && (!strings.Contains(text, tc.name+":1") || strings.Contains(text, "[OK]")) {
				t.Fatalf("missing actionable failure or false success:\n%s", text)
			}
		})
	}
}
