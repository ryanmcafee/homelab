package prereq

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeEnv is the injected environment: every probe the checks make goes
// through it, so a test decides which tool is missing, which daemon is down
// and which host answers.
type fakeEnv struct {
	missing map[string]bool  // LookPath fails for these names
	runErr  map[string]error // Run fails for these command names
	noStat  map[string]bool  // Stat fails for these paths
	dialErr error            // Dial result
	dialed  []string         // every address Dial was asked for
}

func (f *fakeEnv) LookPath(name string) (string, error) {
	if f.missing[name] {
		return "", errors.New("not found: " + name)
	}
	return "/usr/local/bin/" + name, nil
}

func (f *fakeEnv) Dial(network, addr string, timeout time.Duration) error {
	f.dialed = append(f.dialed, addr)
	return f.dialErr
}

func (f *fakeEnv) Stat(path string) (os.FileInfo, error) {
	if f.noStat[path] {
		return nil, os.ErrNotExist
	}
	return nil, nil
}

func (f *fakeEnv) Run(name string, args ...string) (string, error) {
	if err, ok := f.runErr[name]; ok {
		return "", err
	}
	return "ok", nil
}

// writeConfigRoot lays out a minimal configuration/ tree so the in-process
// config validation has real files to load.
func writeConfigRoot(t *testing.T, homelabYAML string) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"schema/network.schema.yaml": `keys:
  DOMAIN:
    description: Base domain
    required: true
  PROXMOX_IP:
    description: Proxmox hypervisor IP
    required: true
    pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$"
`,
		"versions.yaml": `charts:
  argocd: "9.4.7"
images:
  homelab-cmp: "0.1.0"
tools:
  talos: "v1.12.2"
`,
		"environments/defaults.yaml": "DOMAIN: example.com\n",
	}
	if homelabYAML != "" {
		files["environments/homelab.yaml"] = homelabYAML
	}
	for rel, body := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestDetectTier(t *testing.T) {
	tests := []struct {
		name      string
		cfgExists bool
		addr      string
		addrOK    bool
		dialErr   error
		want      Tier
		wantDial  bool
	}{
		{name: "no config is localdev", cfgExists: false, addr: "10.0.0.1:8006", addrOK: true, want: Localdev},
		{name: "config without a proxmox address is localdev", cfgExists: true, addrOK: false, want: Localdev},
		{name: "config with an unreachable proxmox is localdev", cfgExists: true, addr: "10.0.0.1:8006", addrOK: true, dialErr: errors.New("timeout"), want: Localdev, wantDial: true},
		{name: "config with a reachable proxmox suggests homelab", cfgExists: true, addr: "10.0.0.1:8006", addrOK: true, want: Homelab, wantDial: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := &fakeEnv{dialErr: tc.dialErr, noStat: map[string]bool{}}
			cfg := "configuration/environments/homelab.yaml"
			if !tc.cfgExists {
				env.noStat[cfg] = true
			}
			got := DetectTier(env, cfg, func() (string, bool) { return tc.addr, tc.addrOK })
			if got != tc.want {
				t.Errorf("DetectTier = %q, want %q", got, tc.want)
			}
			if tc.wantDial && len(env.dialed) != 1 {
				t.Errorf("expected exactly one dial, got %v", env.dialed)
			}
			if !tc.wantDial && len(env.dialed) != 0 {
				t.Errorf("expected no dial without a config file, got %v", env.dialed)
			}
		})
	}
}

func TestResolveTier(t *testing.T) {
	tests := []struct {
		name       string
		flag       string
		yes        bool
		detected   Tier
		promptPick Tier
		want       Tier
		wantErr    string
		wantPrompt bool
		wantDef    Tier
	}{
		{name: "yes alone is localdev even when homelab was detected", yes: true, detected: Homelab, want: Localdev},
		{name: "yes with an explicit homelab flag is homelab", flag: "homelab", yes: true, detected: Localdev, want: Homelab},
		{name: "explicit localdev flag wins over detection", flag: "localdev", detected: Homelab, want: Localdev},
		{name: "an unknown flag value is an error", flag: "prod", detected: Localdev, wantErr: "unknown environment"},
		{name: "prompt defaults to the detected tier", detected: Homelab, promptPick: Homelab, want: Homelab, wantPrompt: true, wantDef: Homelab},
		{name: "prompt default is localdev when nothing was detected", detected: Localdev, promptPick: Localdev, want: Localdev, wantPrompt: true, wantDef: Localdev},
		{name: "the prompt answer is what is returned", detected: Localdev, promptPick: Homelab, want: Homelab, wantPrompt: true, wantDef: Localdev},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			prompted := false
			var gotDef Tier
			prompt := func(def Tier) Tier {
				prompted = true
				gotDef = def
				return tc.promptPick
			}
			got, err := ResolveTier(tc.flag, tc.yes, tc.detected, prompt)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want it to mention %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("ResolveTier = %q, want %q", got, tc.want)
			}
			if prompted != tc.wantPrompt {
				t.Errorf("prompted = %v, want %v", prompted, tc.wantPrompt)
			}
			if tc.wantPrompt && gotDef != tc.wantDef {
				t.Errorf("prompt default = %q, want %q", gotDef, tc.wantDef)
			}
		})
	}
}

func TestParseTier(t *testing.T) {
	tests := []struct {
		in      string
		want    Tier
		wantErr bool
	}{
		{in: "localdev", want: Localdev},
		{in: "homelab", want: Homelab},
		{in: "", wantErr: true},
		{in: "production", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.in, func(t *testing.T) {
			got, err := ParseTier(tc.in)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ParseTier(%q) err = %v, wantErr %v", tc.in, err, tc.wantErr)
			}
			if got != tc.want {
				t.Errorf("ParseTier(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

var (
	localdevRows = []string{"mise", "task", "deno", "docker", "kind", "kubectl", "helm", "argocd", "chainsaw"}
	homelabRows  = []string{"terragrunt", "talosctl", "ansible-playbook", "op", "age-key", "homelab.yaml", "proxmox"}
)

func names(results []Result) []string {
	out := make([]string, 0, len(results))
	for _, r := range results {
		out = append(out, r.Name)
	}
	return out
}

func byName(results []Result, name string) (Result, bool) {
	for _, r := range results {
		if r.Name == name {
			return r, true
		}
	}
	return Result{}, false
}

func TestRunChecksTierFiltering(t *testing.T) {
	root := writeConfigRoot(t, "PROXMOX_IP: \"10.0.0.1\"\n")
	opts := Options{ConfigRoot: root, AgeKeyFile: "/home/x/.config/sops/age/keys.txt"}
	env := &fakeEnv{}

	tests := []struct {
		tier    Tier
		present []string
		absent  []string
	}{
		{tier: Localdev, present: localdevRows, absent: homelabRows},
		{tier: Homelab, present: append(append([]string{}, localdevRows...), homelabRows...)},
	}
	for _, tc := range tests {
		t.Run(string(tc.tier), func(t *testing.T) {
			results := runChecks(ChecksWith(opts), env, tc.tier)
			got := names(results)
			for _, want := range tc.present {
				if _, ok := byName(results, want); !ok {
					t.Errorf("tier %s is missing row %q (rows: %v)", tc.tier, want, got)
				}
			}
			for _, unwanted := range tc.absent {
				if _, ok := byName(results, unwanted); ok {
					t.Errorf("tier %s must not run row %q (rows: %v)", tc.tier, unwanted, got)
				}
			}
			if len(results) != len(tc.present) {
				t.Errorf("tier %s ran %d rows, want %d: %v", tc.tier, len(results), len(tc.present), got)
			}
		})
	}
}

func TestRunChecksRows(t *testing.T) {
	validRoot := writeConfigRoot(t, "PROXMOX_IP: \"10.0.0.1\"\n")
	invalidRoot := writeConfigRoot(t, "PROXMOX_IP: \"not-an-ip\"\n")
	missingRoot := writeConfigRoot(t, "")
	ageKey := "/home/x/.config/sops/age/keys.txt"

	tests := []struct {
		name     string
		root     string
		env      *fakeEnv
		row      string
		wantFail bool
		wantDial string
	}{
		{name: "every row passes on a fully provisioned machine", root: validRoot, env: &fakeEnv{}, row: ""},
		{name: "a missing binary fails its row", root: validRoot, env: &fakeEnv{missing: map[string]bool{"kind": true}}, row: "kind", wantFail: true},
		{name: "docker fails when the daemon is unreachable", root: validRoot, env: &fakeEnv{runErr: map[string]error{"docker": errors.New("cannot connect")}}, row: "docker", wantFail: true},
		{name: "op fails when not signed in", root: validRoot, env: &fakeEnv{runErr: map[string]error{"op": errors.New("not signed in")}}, row: "op", wantFail: true},
		{name: "age key fails when the file is absent", root: validRoot, env: &fakeEnv{noStat: map[string]bool{ageKey: true}}, row: "age-key", wantFail: true},
		{name: "homelab.yaml fails when absent", root: missingRoot, env: &fakeEnv{}, row: "homelab.yaml", wantFail: true},
		{name: "homelab.yaml fails when schema-invalid", root: invalidRoot, env: &fakeEnv{}, row: "homelab.yaml", wantFail: true},
		{name: "proxmox fails when the port does not answer", root: validRoot, env: &fakeEnv{dialErr: errors.New("timeout")}, row: "proxmox", wantFail: true, wantDial: "10.0.0.1:8006"},
		{name: "proxmox dials the configured address on port 8006", root: validRoot, env: &fakeEnv{}, row: "proxmox", wantDial: "10.0.0.1:8006"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts := Options{ConfigRoot: tc.root, AgeKeyFile: ageKey}
			results := runChecks(ChecksWith(opts), tc.env, Homelab)

			if tc.row == "" {
				if n := Failed(results); n != 0 {
					for _, r := range results {
						if r.Err != nil {
							t.Errorf("row %q failed: %v", r.Name, r.Err)
						}
					}
					t.Fatalf("Failed = %d, want 0", n)
				}
				return
			}

			r, ok := byName(results, tc.row)
			if !ok {
				t.Fatalf("row %q not found in %v", tc.row, names(results))
			}
			if (r.Err != nil) != tc.wantFail {
				t.Errorf("row %q err = %v, wantFail %v", tc.row, r.Err, tc.wantFail)
			}
			if tc.wantFail && strings.TrimSpace(r.Hint) == "" {
				t.Errorf("row %q failed without a fix hint", tc.row)
			}
			if tc.wantDial != "" {
				found := false
				for _, d := range tc.env.dialed {
					if d == tc.wantDial {
						found = true
					}
				}
				if !found {
					t.Errorf("expected a dial to %q, got %v", tc.wantDial, tc.env.dialed)
				}
			}
		})
	}
}

func TestEveryCheckHasAHint(t *testing.T) {
	for _, c := range Checks() {
		if strings.TrimSpace(c.Hint) == "" {
			t.Errorf("check %q has no hint", c.Name)
		}
		if c.Tier != Localdev && c.Tier != Homelab {
			t.Errorf("check %q has an unknown tier %q", c.Name, c.Tier)
		}
	}
}

func TestFailed(t *testing.T) {
	tests := []struct {
		name    string
		results []Result
		want    int
	}{
		{name: "no results", results: nil, want: 0},
		{name: "all passing", results: []Result{{Check: Check{Name: "a"}}, {Check: Check{Name: "b"}}}, want: 0},
		{name: "two of three failing", results: []Result{
			{Check: Check{Name: "a"}, Err: errors.New("x")},
			{Check: Check{Name: "b"}},
			{Check: Check{Name: "c"}, Err: errors.New("y")},
		}, want: 2},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Failed(tc.results); got != tc.want {
				t.Errorf("Failed = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestProxmoxAddr(t *testing.T) {
	tests := []struct {
		name   string
		root   string
		want   string
		wantOK bool
	}{
		{name: "resolves from the config", root: writeConfigRoot(t, "PROXMOX_IP: \"10.0.0.1\"\n"), want: "10.0.0.1:8006", wantOK: true},
		{name: "absent config yields nothing", root: writeConfigRoot(t, ""), wantOK: false},
		{name: "invalid config yields nothing", root: writeConfigRoot(t, "PROXMOX_IP: \"nope\"\n"), wantOK: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ProxmoxAddr(Options{ConfigRoot: tc.root})()
			if ok != tc.wantOK || got != tc.want {
				t.Errorf("ProxmoxAddr = (%q, %v), want (%q, %v)", got, ok, tc.want, tc.wantOK)
			}
		})
	}
}
