// Package prereq is the tier-aware prerequisite model behind `homelab
// validate` and `homelab bootstrap`: which tools, daemons, files and hosts a
// tier needs, how the default tier is detected, and how the flags resolve to
// one tier. Every probe goes through Env so tests inject a fake.
package prereq

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ryanmcafee/homelab/internal/config"
)

// Env is the machine as the checks see it.
type Env interface {
	LookPath(name string) (string, error)
	Dial(network, addr string, timeout time.Duration) error
	Stat(path string) (os.FileInfo, error)
	Run(name string, args ...string) (stdout string, err error)
}

// RealEnv probes the real machine.
type RealEnv struct{}

func (RealEnv) LookPath(name string) (string, error) { return exec.LookPath(name) }

func (RealEnv) Dial(network, addr string, timeout time.Duration) error {
	conn, err := net.DialTimeout(network, addr, timeout)
	if err != nil {
		return err
	}
	return conn.Close()
}

func (RealEnv) Stat(path string) (os.FileInfo, error) { return os.Stat(path) }

func (RealEnv) Run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			return "", err
		}
		return "", fmt.Errorf("%w: %s", err, lastLine(msg))
	}
	return string(out), nil
}

// lastLine is the diagnostic a failing CLI prints last (docker info prints
// its client section before "Cannot connect to the Docker daemon").
func lastLine(s string) string {
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[i+1:])
	}
	return s
}

// Tier is a deployment target. Localdev is the Kind loop; Homelab is the
// Proxmox/Talos production cluster.
type Tier string

const (
	Localdev Tier = "localdev"
	Homelab  Tier = "homelab"
)

// rank orders tiers: a check with Tier t is required by every tier >= t.
func (t Tier) rank() int {
	switch t {
	case Localdev:
		return 0
	case Homelab:
		return 1
	}
	return -1
}

// ParseTier maps a --environment value to a Tier.
func ParseTier(s string) (Tier, error) {
	switch Tier(s) {
	case Localdev:
		return Localdev, nil
	case Homelab:
		return Homelab, nil
	}
	return "", fmt.Errorf("unknown environment %q (expected localdev or homelab)", s)
}

// Check is one prerequisite. Tier is the minimum tier that requires it.
type Check struct {
	Name string
	Tier Tier
	Hint string
	Run  func(Env) error
}

// Result is a Check after it ran.
type Result struct {
	Check
	Err error
}

// Options locate the files the homelab checks read.
type Options struct {
	// ConfigRoot is the configuration/ directory (schema/, versions.yaml,
	// environments/).
	ConfigRoot string
	// AgeKeyFile is the SOPS age key file ($SOPS_AGE_KEY_FILE or
	// ~/.config/sops/age/keys.txt).
	AgeKeyFile string
}

// ProxmoxPort is the Proxmox VE web/API port the reachability check dials.
const ProxmoxPort = "8006"

// DialTimeout bounds the Proxmox TCP probe.
const DialTimeout = time.Second

// DefaultOptions resolves the options for the current process: the config
// root is found by walking up from the working directory to the directory
// holding Taskfile.yml.
func DefaultOptions() Options {
	opts := Options{ConfigRoot: "configuration"}
	if root, ok := projectRoot(); ok {
		opts.ConfigRoot = filepath.Join(root, "configuration")
	}
	if f := os.Getenv("SOPS_AGE_KEY_FILE"); f != "" {
		opts.AgeKeyFile = f
	} else if home, err := os.UserHomeDir(); err == nil {
		opts.AgeKeyFile = filepath.Join(home, ".config", "sops", "age", "keys.txt")
	}
	return opts
}

func projectRoot() (string, bool) {
	dir, err := os.Getwd()
	if err != nil {
		return "", false
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "Taskfile.yml")); err == nil {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

// HomelabConfigPath is the production environment file under ConfigRoot.
func (o Options) HomelabConfigPath() string {
	return filepath.Join(o.ConfigRoot, "environments", string(Homelab)+".yaml")
}

// LoadHomelabConfig runs the same in-process pipeline as `homelab config
// validate --set homelab`: schemas, versions, defaults and the environment
// file, then Eval, which validates required keys, patterns and enums.
func LoadHomelabConfig(o Options) (*config.ResolvedConfig, error) {
	schema, err := config.LoadSchemaDir(filepath.Join(o.ConfigRoot, "schema"))
	if err != nil {
		return nil, fmt.Errorf("loading schemas: %w", err)
	}
	versions, err := config.LoadVersions(filepath.Join(o.ConfigRoot, "versions.yaml"))
	if err != nil {
		return nil, fmt.Errorf("loading versions: %w", err)
	}
	defaults, err := config.LoadEnvironment(filepath.Join(o.ConfigRoot, "environments", "defaults.yaml"))
	if err != nil {
		return nil, fmt.Errorf("loading defaults: %w", err)
	}
	env, err := config.LoadEnvironment(o.HomelabConfigPath())
	if err != nil {
		return nil, fmt.Errorf("loading environment homelab: %w", err)
	}
	return config.Eval(schema, versions, string(Homelab), defaults, env)
}

// ProxmoxAddr returns a resolver for the Proxmox host:port from the homelab
// configuration. ok is false when the config is absent or invalid, or when it
// carries no PROXMOX_IP.
func ProxmoxAddr(o Options) func() (string, bool) {
	return func() (string, bool) {
		rc, err := LoadHomelabConfig(o)
		if err != nil {
			return "", false
		}
		ip := strings.TrimSpace(rc.Values["PROXMOX_IP"].Value)
		if ip == "" {
			return "", false
		}
		return net.JoinHostPort(ip, ProxmoxPort), true
	}
}

// Checks returns every prerequisite row for the current process.
func Checks() []Check { return ChecksWith(DefaultOptions()) }

// ChecksWith returns every prerequisite row, homelab rows reading files under
// opts. The config is loaded once and shared by the rows that need it.
func ChecksWith(opts Options) []Check {
	var (
		once   sync.Once
		cfg    *config.ResolvedConfig
		cfgErr error
	)
	loadCfg := func() (*config.ResolvedConfig, error) {
		once.Do(func() { cfg, cfgErr = LoadHomelabConfig(opts) })
		return cfg, cfgErr
	}

	binary := func(name string, tier Tier, hint string) Check {
		return Check{
			Name: name,
			Tier: tier,
			Hint: hint,
			Run: func(env Env) error {
				_, err := env.LookPath(name)
				return err
			},
		}
	}
	mise := "mise install -y (task install-tools)"

	return []Check{
		binary("mise", Localdev, "curl https://mise.run | sh, then mise trust && mise install"),
		binary("task", Localdev, mise),
		binary("bun", Localdev, mise),
		{
			Name: "docker",
			Tier: Localdev,
			Hint: "start Docker Desktop (open -a Docker) or the docker daemon; `docker info` must succeed",
			Run: func(env Env) error {
				if _, err := env.LookPath("docker"); err != nil {
					return err
				}
				_, err := env.Run("docker", "info")
				return err
			},
		},
		binary("kind", Localdev, mise),
		binary("kubectl", Localdev, mise),
		binary("helm", Localdev, mise),
		binary("argocd", Localdev, mise),
		binary("chainsaw", Localdev, mise),

		binary("terragrunt", Homelab, mise),
		binary("talosctl", Homelab, mise),
		binary("ansible-playbook", Homelab, mise+", then task ansible:init for the Galaxy collections"),
		{
			Name: "op",
			Tier: Homelab,
			Hint: "install the 1Password CLI and sign in: `op signin` (or export OP_SERVICE_ACCOUNT_TOKEN); `op whoami` must succeed",
			Run: func(env Env) error {
				if _, err := env.LookPath("op"); err != nil {
					return err
				}
				_, err := env.Run("op", "whoami")
				return err
			},
		},
		{
			Name: "age-key",
			Tier: Homelab,
			Hint: fmt.Sprintf("SOPS age key missing at %s: run `task sops:setup` or set SOPS_AGE_KEY_FILE", opts.AgeKeyFile),
			Run: func(env Env) error {
				if opts.AgeKeyFile == "" {
					return fmt.Errorf("no age key path (set SOPS_AGE_KEY_FILE)")
				}
				_, err := env.Stat(opts.AgeKeyFile)
				return err
			},
		},
		{
			Name: "homelab.yaml",
			Tier: Homelab,
			Hint: fmt.Sprintf("copy %s.example to %s and fill it in; `task config:validate` must pass", opts.HomelabConfigPath(), opts.HomelabConfigPath()),
			Run: func(env Env) error {
				if _, err := env.Stat(opts.HomelabConfigPath()); err != nil {
					return err
				}
				_, err := loadCfg()
				return err
			},
		},
		{
			Name: "proxmox",
			Tier: Homelab,
			Hint: fmt.Sprintf("PROXMOX_IP:%s (from homelab.yaml) must accept a TCP connection; check the network, VPN or Tailscale route", ProxmoxPort),
			Run: func(env Env) error {
				rc, err := loadCfg()
				if err != nil {
					return fmt.Errorf("cannot resolve PROXMOX_IP: %w", err)
				}
				ip := strings.TrimSpace(rc.Values["PROXMOX_IP"].Value)
				if ip == "" {
					return fmt.Errorf("PROXMOX_IP is empty")
				}
				return env.Dial("tcp", net.JoinHostPort(ip, ProxmoxPort), DialTimeout)
			},
		},
	}
}

// RunChecks runs every check whose Tier is at or below tier, in order.
func RunChecks(env Env, tier Tier) []Result { return runChecks(Checks(), env, tier) }

func runChecks(checks []Check, env Env, tier Tier) []Result {
	var results []Result
	for _, c := range checks {
		if c.Tier.rank() > tier.rank() {
			continue
		}
		results = append(results, Result{Check: c, Err: c.Run(env)})
	}
	return results
}

// Failed counts the results that carry an error.
func Failed(results []Result) int {
	n := 0
	for _, r := range results {
		if r.Err != nil {
			n++
		}
	}
	return n
}

// DetectTier suggests a default tier. It returns Homelab only when cfgPath
// exists, proxmoxAddr resolves and the address accepts a TCP connection within
// DialTimeout; otherwise Localdev. Detection only sets the prompt default: it
// never selects production by itself (see ResolveTier).
func DetectTier(env Env, cfgPath string, proxmoxAddr func() (string, bool)) Tier {
	if _, err := env.Stat(cfgPath); err != nil {
		return Localdev
	}
	addr, ok := proxmoxAddr()
	if !ok {
		return Localdev
	}
	if err := env.Dial("tcp", addr, DialTimeout); err != nil {
		return Localdev
	}
	return Homelab
}

// ResolveTier turns the flags into one tier. An explicit flag wins; --yes
// without a flag is Localdev, never Homelab, so no bare invocation reaches
// production; otherwise the caller prompts with detected as the default.
func ResolveTier(flag string, yes bool, detected Tier, prompt func(def Tier) Tier) (Tier, error) {
	if flag != "" {
		return ParseTier(flag)
	}
	if yes {
		return Localdev, nil
	}
	if detected.rank() < 0 {
		detected = Localdev
	}
	return prompt(detected), nil
}
