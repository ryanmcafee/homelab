package verify

import (
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/config"
)

// ForkAbilityAddressesCheck is the check name. It covers one family of the
// fork-ability contract's check 1 (docs/contracts/fork-ability.md): an address
// literal in the rendered output that did not come from the ConfigSet.
//
// The hostname family is already covered, by tests/policy/hostname.rego, which
// requires every HTTPRoute/Gateway/Certificate/DNSEndpoint host and every host
// in an Application's inline helm values to end with the environment's own
// domain. That file deliberately exempts IP literals -- its looks_like_hostname
// filters out `192.168.1.100:3260` by name -- so addresses were the one family
// of the contract nothing checked. This closes that hole and nothing wider.
const ForkAbilityAddressesCheck = "forkability/addresses"

// ipv4Literal matches a dotted quad. Membership is decided by net.ParseIP
// afterwards, so an over-wide match here costs nothing.
var ipv4Literal = regexp.MustCompile(`[0-9]{1,3}(?:\.[0-9]{1,3}){3}`)

// publicAddressAllowlist are addresses the charts commit on purpose. Each entry
// names a global service or a reserved block, never one operator's network. Add
// one only after confirming that, and record why.
var publicAddressAllowlist = map[string]string{
	// Public recursive resolvers: blackbox-exporter DNS probes and the
	// dnsConfig nameservers that must resolve before cluster DNS exists.
	"1.1.1.1": "Cloudflare public resolver",
	"1.0.0.1": "Cloudflare public resolver",
	"8.8.8.8": "Google public resolver",
	"8.8.4.4": "Google public resolver",

	// Base addresses of reserved blocks, used to classify a client as private
	// rather than to reach anything.
	"10.0.0.0":    "RFC 1918 block base",
	"172.16.0.0":  "RFC 1918 block base",
	"192.168.0.0": "RFC 1918 block base",
	"100.64.0.0":  "RFC 6598 shared address space base",

	// Kubernetes' own default cluster DNS address. Fixed by the distribution,
	// not by the operator.
	"10.96.0.10": "Kubernetes default cluster DNS service address",
}

// AddressLeak is one address literal in the render that no ConfigSet value
// supplied.
type AddressLeak struct {
	Address string
	// File is the render-relative path, so a finding points at the manifest
	// rather than only at the address.
	File string
	Line int
}

// scanAddresses returns every routable IPv4 literal in data that is neither
// sanctioned by the ConfigSet nor allowlisted, keyed by address so one
// hard-coded value in a chart used by forty apps reports once per file.
func scanAddresses(rel string, data []byte, sanctioned map[string]bool) []AddressLeak {
	var leaks []AddressLeak
	seen := map[string]bool{}
	for i, line := range strings.Split(string(data), "\n") {
		for _, loc := range ipv4Literal.FindAllStringIndex(line, -1) {
			addr := line[loc[0]:loc[1]]
			if seen[addr] || sanctioned[addr] {
				continue
			}
			if _, ok := publicAddressAllowlist[addr]; ok {
				continue
			}
			if isImageTag(line, loc[0]) || octetOverflow(addr) {
				continue
			}
			// Limited broadcast names no host, and Go's IsUnspecified covers
			// only 0.0.0.0, so IsRoutableHostIP does not exclude it.
			if addr == "255.255.255.255" || !config.IsRoutableHostIP(addr) {
				continue
			}
			seen[addr] = true
			leaks = append(leaks, AddressLeak{Address: addr, File: rel, Line: i + 1})
		}
	}
	return leaks
}

// isImageTag reports whether the quad starting at idx is an image tag rather
// than an address. `clickhouse/clickhouse-server:26.8.10.6` parses as a valid
// IPv4 and is not one. An address always sits *before* its colon
// (`192.168.1.100:3260`), and YAML always puts a space after a key's colon, so
// a quad glued directly to a preceding colon is a tag.
func isImageTag(line string, idx int) bool {
	if idx == 0 || line[idx-1] != ':' {
		return false
	}
	before := strings.TrimRight(line[:idx-1], " ")
	return before != "" && !strings.ContainsAny(before[len(before)-1:], "0123456789")
}

// octetOverflow reports whether any octet exceeds 255, which net.ParseIP
// rejects but a four-part version string reaches often.
func octetOverflow(addr string) bool {
	return net.ParseIP(addr) == nil
}

// sanctionedAddresses returns every IPv4 literal reachable from a resolved
// ConfigSet, including the ones embedded in a compound value: a CIDR
// (`192.168.1.0/24`), a portal (`192.168.1.100:3260`) and the comma-separated
// NETWORK_NAMES pairs all yield their addresses. A value that reaches the
// render through the ConfigSet is by definition not hard-coded -- a fork
// supplies its own.
func sanctionedAddresses(resolved *config.ResolvedConfig) map[string]bool {
	out := map[string]bool{}
	for _, v := range resolved.Values {
		for _, addr := range ipv4Literal.FindAllString(v.Value, -1) {
			out[addr] = true
		}
	}
	for _, m := range resolved.ControlPlane {
		for _, addr := range ipv4Literal.FindAllString(m.Address, -1) {
			out[addr] = true
		}
	}
	return out
}

// renderedFiles lists every rendered YAML file for env, including the
// underscore-prefixed `_values/` and `_inherited/` trees. LoadRenderDir skips
// those because they are not manifests; they are still shipped configuration
// and an address hard-coded in one reaches the cluster exactly the same way.
func renderedFiles(envDir string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(envDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(path, ".yaml") {
			files = append(files, path)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

// ForkAbilityAddresses fails when the render contains an address literal that
// no ConfigSet value supplied.
//
// The contract's rule is that a stranger's fork comes up on their own network,
// so the invariant is about provenance, not about which ranges look private:
// `192.168.1.100` is fine when it arrived from TRUENAS_IP and is a defect when
// a chart spells it out, and the two are indistinguishable by shape alone.
func ForkAbilityAddresses(repoRoot, renderDir string, envs []Env) []Check {
	start := time.Now()

	if len(envs) == 0 {
		return []Check{FailCheck(ForkAbilityAddressesCheck, start,
			"no environments to scan",
			"a fork-ability scan over zero environments proves nothing")}
	}

	var (
		leaks    []AddressLeak
		scanned  int
		examined int
	)
	for _, env := range envs {
		resolved, err := resolveEnvConfig(repoRoot, env)
		if err != nil {
			return []Check{FailCheck(ForkAbilityAddressesCheck, start,
				"resolving the "+env.ConfigSet+" ConfigSet", err.Error())}
		}
		sanctioned := sanctionedAddresses(resolved)
		if len(sanctioned) == 0 {
			return []Check{FailCheck(ForkAbilityAddressesCheck, start,
				"resolving the "+env.ConfigSet+" ConfigSet",
				env.EnvFile+" supplied no address values, so every address in the render would read as hard-coded")}
		}
		examined += len(sanctioned)

		envDir := filepath.Join(renderDir, env.Name)
		files, err := renderedFiles(envDir)
		if err != nil {
			return []Check{FailCheck(ForkAbilityAddressesCheck, start,
				"reading the "+env.Name+" render", err.Error())}
		}
		for _, path := range files {
			data, err := os.ReadFile(path)
			if err != nil {
				return []Check{FailCheck(ForkAbilityAddressesCheck, start,
					"reading "+path, err.Error())}
			}
			rel, relErr := filepath.Rel(renderDir, path)
			if relErr != nil {
				rel = path
			}
			leaks = append(leaks, scanAddresses(filepath.ToSlash(rel), data, sanctioned)...)
			scanned++
		}
	}

	// A scan that saw nothing reports a green that covers every future chart
	// too, so an empty render is a failure rather than a pass.
	if scanned == 0 {
		return []Check{FailCheck(ForkAbilityAddressesCheck, start,
			"scanning the render",
			"found no rendered YAML under "+renderDir+"; a scan of zero files cannot clear anything")}
	}

	if len(leaks) > 0 {
		findings := make([]string, 0, len(leaks))
		for _, l := range leaks {
			findings = append(findings, fmt.Sprintf(
				"%s is hard-coded at %s:%d — no ConfigSet key supplies it, so a fork renders this operator's address",
				l.Address, l.File, l.Line))
		}
		return []Check{FailCheck(ForkAbilityAddressesCheck, start,
			fmt.Sprintf("%d address literal(s) escaped the ConfigSet", len(leaks)),
			findings...)}
	}

	return []Check{PassCheck(ForkAbilityAddressesCheck, start, fmt.Sprintf(
		"%d rendered files scanned; every routable address traces to one of %d ConfigSet values or the %d-entry public allowlist",
		scanned, examined, len(publicAddressAllowlist)))}
}
