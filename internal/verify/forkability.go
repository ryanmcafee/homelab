package verify

import (
	"context"
	"encoding/json"
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
			if isImageTag(line, loc[0]) || inLongerDottedNumber(line, loc[0], loc[1]) || octetOverflow(addr) {
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

// inLongerDottedNumber reports whether the quad at line[start:end] is only part
// of a longer digit run, as in the version tag 1.43.5.11029.
func inLongerDottedNumber(line string, start, end int) bool {
	digitAt := func(i int) bool { return i >= 0 && i < len(line) && line[i] >= '0' && line[i] <= '9' }
	if digitAt(end) || (end < len(line) && line[end] == '.' && digitAt(end+1)) {
		return true
	}
	return digitAt(start-1) || (start > 0 && line[start-1] == '.' && digitAt(start-2))
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

// Fork-ability check 2 (docs/contracts/fork-ability.md): every key the render
// or the bootstrap requires appears in the tier's example ConfigSet with a
// REPLACEME- or clearly synthetic value.
//
// The bootstrap half of that union is NOT maintained here. Hand-copying the
// bootstrap's key list into this package would fork the key list, which is the
// exact defect check 2 exists to catch. Instead the list is read from
// `homelab bootstrap --print-required-keys`, whose document shape is the
// contract agreed on MCAA-65. Everything below consumes that document; nothing
// below enumerates keys.

// RequiredKeysVersion is the only document version this consumer understands.
// An unknown version fails the check rather than parsing into an empty key set
// and passing vacuously.
const RequiredKeysVersion = 1

// Key sources. `schema` keys are declared `required: true` in
// configuration/schema/*.yaml; `bootstrap` keys are needed by a bootstrap phase
// regardless of the schema.
const (
	KeySourceSchema    = "schema"
	KeySourceBootstrap = "bootstrap"
)

// Example placement: whether the key belongs in the tier's example ConfigSet.
// Three states, not two, because "has a default" and "must not be set" are
// different things and only the producer can tell them apart.
const (
	// ExampleRequired: nothing supplies this key, so the example must carry a
	// placeholder or a fork cannot discover it. This is the check's teeth.
	ExampleRequired = "required"
	// ExampleOptional: a default in defaults.yaml or the schema supplies it, but
	// an operator may reasonably want to override it. Present or absent both
	// pass; the example is a curated starting point, not a dump of every key.
	ExampleOptional = "optional"
	// ExampleForbidden: the value is computed (a schema `const`) or hidden, so
	// setting it in the example is ignored at render — a lie in the file a fork
	// starts from.
	ExampleForbidden = "forbidden"
)

// RequiredKey is one entry of the producer's document.
type RequiredKey struct {
	Name        string `json:"name"`
	Required    bool   `json:"required"`
	Source      string `json:"source"`
	Description string `json:"description"`
	Example     string `json:"example"`
}

// RequiredKeysTier is the key set for one deployment tier, plus any inputs the
// producer assumed while computing it. Assumptions is how the consumer tells a
// genuine drift from a different assumed input. It is empty against today's
// producer: ADR-035 replaced CONTROL_PLANE_COUNT with the ^CP([0-9]+)_IP$
// family, and a family cannot be required, so no value decides the key set.
type RequiredKeysTier struct {
	Tier        string            `json:"tier"`
	Assumptions map[string]string `json:"assumptions,omitempty"`
	Keys        []RequiredKey     `json:"keys"`
}

// RequiredKeysDoc is the whole document: every tier the CLI knows about.
// Emitting every tier is deliberate — it means a new tier this package has no
// example-ConfigSet mapping for fails the gate instead of going unchecked.
type RequiredKeysDoc struct {
	Version int                `json:"version"`
	Tiers   []RequiredKeysTier `json:"tiers"`
}

// ParseRequiredKeys decodes and validates a producer document. Every rule here
// is a way the gate could otherwise pass while checking nothing.
func ParseRequiredKeys(stdout []byte) (*RequiredKeysDoc, error) {
	var doc RequiredKeysDoc
	dec := json.NewDecoder(strings.NewReader(string(stdout)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("decoding --print-required-keys output: %w", err)
	}

	if doc.Version != RequiredKeysVersion {
		return nil, fmt.Errorf("unsupported document version %d (this consumer understands %d)", doc.Version, RequiredKeysVersion)
	}
	if len(doc.Tiers) == 0 {
		return nil, fmt.Errorf("document declares no tiers")
	}

	seenTier := map[string]bool{}
	for _, tier := range doc.Tiers {
		if tier.Tier == "" {
			return nil, fmt.Errorf("a tier entry has an empty name")
		}
		if seenTier[tier.Tier] {
			return nil, fmt.Errorf("tier %q appears twice", tier.Tier)
		}
		seenTier[tier.Tier] = true

		if len(tier.Keys) == 0 {
			return nil, fmt.Errorf("tier %q declares no keys", tier.Tier)
		}
		if countRequired(tier.Keys) == 0 {
			return nil, fmt.Errorf("tier %q declares no required keys", tier.Tier)
		}
		if err := validateKeys(tier.Tier, tier.Keys); err != nil {
			return nil, err
		}
	}
	return &doc, nil
}

func validateKeys(tier string, keys []RequiredKey) error {
	for i, k := range keys {
		if k.Name == "" {
			return fmt.Errorf("tier %q: key at index %d has an empty name", tier, i)
		}
		switch k.Source {
		case KeySourceSchema, KeySourceBootstrap:
		default:
			return fmt.Errorf("tier %q: key %q has unknown source %q", tier, k.Name, k.Source)
		}
		switch k.Example {
		case ExampleRequired, ExampleOptional, ExampleForbidden:
		default:
			return fmt.Errorf("tier %q: key %q has unknown example placement %q", tier, k.Name, k.Example)
		}
		if i > 0 {
			if prev := keys[i-1].Name; prev == k.Name {
				return fmt.Errorf("tier %q: key %q appears twice", tier, k.Name)
			} else if prev > k.Name {
				return fmt.Errorf("tier %q: keys are not sorted by name (%q before %q)", tier, prev, k.Name)
			}
		}
	}
	return nil
}

// exampleConfigSets maps a tier to the committed ConfigSet a fork starts from,
// relative to the repository root. A tier the producer emits that is absent
// here fails the check; that is the point of the producer emitting every tier.
var exampleConfigSets = map[string]string{
	"homelab":  filepath.Join("configuration", "environments", "homelab.yaml.example"),
	"localdev": filepath.Join("configuration", "environments", "localdev.yaml"),
}

// RequiredKeysProducer fetches the key document. Production reads the CLI;
// tests supply a fake so the gate's own failure modes are exercised.
type RequiredKeysProducer func(ctx context.Context) ([]byte, error)

// CLIRequiredKeysProducer runs `homelab bootstrap --print-required-keys`.
// stdout is JSON only; logs go to stderr, so no filtering is needed.
func CLIRequiredKeysProducer(runner Runner, repoRoot, binary string) RequiredKeysProducer {
	return func(ctx context.Context) ([]byte, error) {
		stdout, stderr, err := runner.Run(ctx, repoRoot, binary, "bootstrap", "--print-required-keys", "--format", "json")
		if err != nil {
			return nil, fmt.Errorf("%s bootstrap --print-required-keys: %w: %s", binary, err, strings.TrimSpace(string(stderr)))
		}
		return stdout, nil
	}
}

// ForkAbilityCheck2 runs check 2 over every tier the producer reports.
// It emits one check per tier plus one for the document contract itself.
func ForkAbilityCheck2(ctx context.Context, repoRoot string, produce RequiredKeysProducer) []Check {
	start := time.Now()

	raw, err := produce(ctx)
	if err != nil {
		return []Check{FailCheck("forkability/required-keys/contract", start,
			"could not read the bootstrap's required-key document", err.Error())}
	}

	doc, err := ParseRequiredKeys(raw)
	if err != nil {
		return []Check{FailCheck("forkability/required-keys/contract", start,
			"the bootstrap's required-key document does not match the agreed format (MCAA-65)", err.Error())}
	}

	checks := []Check{PassCheck("forkability/required-keys/contract", start,
		fmt.Sprintf("document v%d, %d tier(s)", doc.Version, len(doc.Tiers)))}

	for _, tier := range doc.Tiers {
		checks = append(checks, checkTierExample(repoRoot, tier))
	}
	return checks
}

func checkTierExample(repoRoot string, tier RequiredKeysTier) Check {
	start := time.Now()
	name := "forkability/example-completeness/" + tier.Tier

	rel, ok := exampleConfigSets[tier.Tier]
	if !ok {
		return FailCheck(name, start,
			fmt.Sprintf("tier %q has no example ConfigSet mapping in internal/verify/forkability.go", tier.Tier),
			"add the tier's committed example ConfigSet to exampleConfigSets, or the tier ships unchecked")
	}

	path := filepath.Join(repoRoot, rel)
	data, err := os.ReadFile(path)
	if err != nil {
		return FailCheck(name, start, "reading "+rel, err.Error())
	}
	present := parseConfigSetKeys(data)

	var findings []string
	for _, k := range tier.Keys {
		if !k.Required {
			continue
		}
		value, inExample := present[k.Name]
		switch k.Example {
		case ExampleRequired:
			switch {
			case !inExample:
				findings = append(findings, fmt.Sprintf(
					"%s (%s-required) is missing from %s: %s — a fork cannot discover it",
					k.Name, k.Source, rel, k.Description))
			case value == "":
				// A key present with an empty value is discoverable but not
				// fillable-in: the fork copies the file and renders nothing.
				findings = append(findings, fmt.Sprintf(
					"%s is present in %s with an empty value; it needs a REPLACEME- or synthetic placeholder", k.Name, rel))
			case !isSyntheticPlaceholder(value):
				findings = append(findings, fmt.Sprintf(
					"%s is %q in %s, which is not a REPLACEME- or reserved (RFC 2606/5737) placeholder; a fork that keeps it renders that value",
					k.Name, value, rel))
			}
		case ExampleForbidden:
			if inExample {
				findings = append(findings, fmt.Sprintf(
					"%s is computed (example:forbidden) but is set in %s; the value there is ignored at render", k.Name, rel))
			}
		case ExampleOptional:
			// Defaulted and operator-tunable: present or absent both pass. Only
			// an empty override is wrong, because it resolves to nothing.
			if inExample && value == "" {
				findings = append(findings, fmt.Sprintf(
					"%s is present in %s with an empty value, which overrides its default with nothing", k.Name, rel))
			}
		}
	}

	findings = append(findings, checkAssumptions(rel, tier, present)...)

	if len(findings) > 0 {
		sort.Strings(findings)
		return FailCheck(name, start,
			fmt.Sprintf("%s does not cover every key the render or the bootstrap requires", rel), findings...)
	}
	return PassCheck(name, start,
		fmt.Sprintf("%s covers all %d required key(s)", rel, countRequired(tier.Keys)))
}

// checkAssumptions holds the example ConfigSet to the inputs the producer
// assumed. If the example disagrees with an assumption, the key list the
// example implies is not the key list that was checked. No input qualifies
// today, so this is a no-op until a computed key set reappears.
func checkAssumptions(rel string, tier RequiredKeysTier, present map[string]string) []string {
	var findings []string
	for key, assumed := range tier.Assumptions {
		actual, ok := present[key]
		if !ok {
			continue
		}
		if actual != assumed {
			findings = append(findings, fmt.Sprintf(
				"%s is %q in %s but the required-key document was computed assuming %q",
				key, actual, rel, assumed))
		}
	}
	return findings
}

// isSyntheticPlaceholder reports whether an example:required value fails loudly
// if a fork forgets it: a REPLACEME- token anywhere, or a guard placeholder.
func isSyntheticPlaceholder(value string) bool {
	tokens := strings.FieldsFunc(strings.ToLower(value), func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-'
	})
	for _, token := range tokens {
		if strings.HasPrefix(token, "replaceme-") {
			return true
		}
	}
	return config.IsExamplePlaceholder(value)
}

func countRequired(keys []RequiredKey) int {
	n := 0
	for _, k := range keys {
		if k.Required {
			n++
		}
	}
	return n
}

// parseConfigSetKeys reads the flat `KEY: value` ConfigSet form and returns
// key -> unquoted value. It is deliberately not a YAML unmarshal: the file is
// flat by contract, and a hand-rolled scan keeps the check independent of how
// the renderer happens to load it.
func parseConfigSetKeys(data []byte) map[string]string {
	keys := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		// Only top-level keys; an indented line is part of a nested block.
		if line != strings.TrimLeft(line, " \t") {
			continue
		}
		name, value, ok := strings.Cut(trimmed, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		keys[name] = value
	}
	return keys
}
