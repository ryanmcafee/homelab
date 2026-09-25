package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

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

// RequiredKeysTier is the key set for one deployment tier, plus the inputs the
// producer assumed while computing it. The key set is computed (it is a
// function of CONTROL_PLANE_COUNT), so Assumptions is how the consumer tells a
// genuine drift from a different assumed input.
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
// assumed. The key set is computed from values like CONTROL_PLANE_COUNT; if the
// example disagrees with the assumption, the key list the example implies is
// not the key list that was checked.
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
