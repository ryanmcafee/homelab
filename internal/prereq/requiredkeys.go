package prereq

import (
	"fmt"
	"path/filepath"
	"sort"

	"github.com/ryanmcafee/homelab/internal/config"
)

// The document `homelab bootstrap --print-required-keys` emits.
//
// Fork-ability check 2 (docs/contracts/fork-ability.md) holds every tier's
// example ConfigSet against the keys "the render OR the bootstrap requires".
// The gate cannot see the bootstrap half by rendering charts, and copying this
// key list into the gate would fork the key list — the exact defect check 2
// exists to catch. So the list is published here and consumed as data. The
// shape is the contract agreed on MCAA-65; internal/verify parses it and
// enumerates no key names of its own.

// RequiredKeysVersion is the document version. The consumer refuses any other
// value rather than parsing an unrecognised shape into an empty key set and
// passing vacuously, so a shape change is a coordinated bump.
const RequiredKeysVersion = 1

// Where a key's requirement comes from.
const (
	// KeySourceSchema: declared required: true in configuration/schema.
	KeySourceSchema = "schema"
	// KeySourceBootstrap: a bootstrap phase needs it whatever the schema says.
	KeySourceBootstrap = "bootstrap"
)

// Whether the key belongs in the tier's example ConfigSet. Three states,
// because "has a default" and "must not be set" are different facts and only
// this side can tell them apart.
const (
	// ExampleRequired: nothing supplies the value, so the example must carry a
	// placeholder or a fork cannot discover the key.
	ExampleRequired = "required"
	// ExampleOptional: a schema default supplies it, but an operator may
	// reasonably override it. Present or absent both pass.
	ExampleOptional = "optional"
	// ExampleForbidden: the value is computed or not operator-facing, so a
	// value in the example is ignored at render — a lie in the file a fork
	// starts from.
	ExampleForbidden = "forbidden"
)

// RequiredKey is one entry of the document.
type RequiredKey struct {
	Name        string `json:"name"`
	Required    bool   `json:"required"`
	Source      string `json:"source"`
	Description string `json:"description"`
	Example     string `json:"example"`
}

// RequiredKeysTier is one tier's key set plus the inputs this side assumed
// while computing it, so the consumer can tell a genuine gap from a different
// assumed input. Assumptions is empty today: ADR-035 removed
// CONTROL_PLANE_COUNT, and the control-plane family admits members by key-name
// pattern, so no value decides the key set.
type RequiredKeysTier struct {
	Tier        Tier              `json:"tier"`
	Assumptions map[string]string `json:"assumptions,omitempty"`
	Keys        []RequiredKey     `json:"keys"`
}

// RequiredKeysDoc is every tier the CLI can bootstrap. Emitting all of them is
// deliberate: a tier the consumer has no example ConfigSet for then fails the
// gate instead of shipping unchecked.
type RequiredKeysDoc struct {
	Version int                `json:"version"`
	Tiers   []RequiredKeysTier `json:"tiers"`
}

// AllTiers is every tier bootstrap can run, in bring-up order.
func AllTiers() []Tier { return []Tier{Localdev, Homelab} }

// bootstrapRequiredKeys names keys a bootstrap phase needs that the schema does
// not declare required, per tier.
//
// It is empty today, and that is a measured statement rather than a stub: every
// value the bootstrap reads from the resolved config is either already
// required: true in configuration/schema (PROXMOX_IP) or a computed const
// (ARGOCD_HOSTNAME). The table exists so that when a phase does start needing a
// key the schema does not demand, it is declared once, here, and the gate sees
// it without anyone maintaining a second list.
var bootstrapRequiredKeys = map[Tier][]RequiredKey{}

// BuildRequiredKeys builds the document for every tier from the schema under
// o.ConfigRoot.
//
// It reads configuration/schema only — no ConfigSet, no cluster, no network, no
// 1Password — so it answers on a machine that has none of the prerequisites.
// That is the point: a fork needs to know which values to gather before owning
// the hardware that would let the prerequisite table pass.
func BuildRequiredKeys(o Options) (*RequiredKeysDoc, error) {
	schema, err := config.LoadSchemaDir(filepath.Join(o.ConfigRoot, "schema"))
	if err != nil {
		return nil, fmt.Errorf("loading schemas: %w", err)
	}

	doc := &RequiredKeysDoc{Version: RequiredKeysVersion}
	for _, tier := range AllTiers() {
		keys, err := requiredKeysForTier(schema, tier)
		if err != nil {
			return nil, err
		}
		doc.Tiers = append(doc.Tiers, RequiredKeysTier{Tier: tier, Keys: keys})
	}
	return doc, nil
}

// requiredKeysForTier is the schema's required keys plus the tier's
// bootstrap-only keys, sorted by name.
//
// Key PATTERNS contribute nothing: validateKeyPattern refuses required: true on
// a family, because a regex has no name to demand. CP1_IP is a literal key and
// is covered above; CP2_IP upward are admitted by the family and optional.
func requiredKeysForTier(schema *config.Schema, tier Tier) ([]RequiredKey, error) {
	byName := make(map[string]RequiredKey, len(schema.Keys))
	for name, key := range schema.Keys {
		if !key.Required {
			continue
		}
		byName[name] = RequiredKey{
			Name:        name,
			Required:    true,
			Source:      KeySourceSchema,
			Description: key.Description,
			Example:     examplePlacement(key),
		}
	}

	for _, key := range bootstrapRequiredKeys[tier] {
		if _, ok := byName[key.Name]; ok {
			// Two declarations of the same requirement is the forked key list
			// this document exists to prevent, so it fails the build rather
			// than picking one.
			return nil, fmt.Errorf(
				"key %q is declared required by both configuration/schema and bootstrapRequiredKeys[%s]; "+
					"drop the bootstrapRequiredKeys entry so the requirement has one source", key.Name, tier)
		}
		key.Source = KeySourceBootstrap
		byName[key.Name] = key
	}

	keys := make([]RequiredKey, 0, len(byName))
	for _, key := range byName {
		keys = append(keys, key)
	}
	// schema.Keys is a map, and the consumer rejects an unsorted list: without
	// this the gate would pass or fail by Go's randomised iteration order.
	sort.Slice(keys, func(i, j int) bool { return keys[i].Name < keys[j].Name })
	return keys, nil
}

// examplePlacement decides where a required key belongs in an example ConfigSet.
func examplePlacement(key config.SchemaKey) string {
	switch {
	case key.Const != "", key.Hidden:
		return ExampleForbidden
	case key.Default != "":
		return ExampleOptional
	default:
		return ExampleRequired
	}
}

// OperatorSuppliedKeys are the tier's ExampleRequired keys: the values a fork
// has to supply itself, because neither a schema default nor a const expression
// produces them. This is the set the text output shows an operator.
func (t RequiredKeysTier) OperatorSuppliedKeys() []RequiredKey {
	var keys []RequiredKey
	for _, key := range t.Keys {
		if key.Required && key.Example == ExampleRequired {
			keys = append(keys, key)
		}
	}
	return keys
}
