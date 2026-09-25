package config

import "regexp"

// SchemaKey declares a single configuration key with validation rules.
type SchemaKey struct {
	Description string   `yaml:"description"`
	Required    bool     `yaml:"required"`
	Pattern     string   `yaml:"pattern,omitempty"`
	Default     string   `yaml:"default,omitempty"`
	Const       string   `yaml:"const,omitempty"`
	Enum        []string `yaml:"enum,omitempty"`
	Hidden      bool     `yaml:"hidden,omitempty"`
	Label       string   `yaml:"label,omitempty"`
}

// RoleControlPlaneAddress marks the key-name pattern whose matching keys are
// the cluster's control-plane addresses. The resolver derives
// ResolvedConfig.ControlPlane from it, and contracts/cluster/topology.v1.yaml
// (`controlPlane.countKeyPattern`) states the same pattern string — the two are
// asserted identical by TestControlPlaneKeyPatternMatchesContract. At most one
// pattern in the merged schema may carry this role.
const RoleControlPlaneAddress = "control-plane-address"

// SchemaKeyPattern declares a FAMILY of configuration keys by key-name regex
// rather than by literal name. The map key is the anchored regex.
//
// This exists because some facts are a set, not a scalar: the control plane is
// however many addresses the operator listed. Three individually required
// CP1/CP2/CP3 keys encode a shape just as firmly as a literal 3 does, and no
// value-level check can see it (ADR-035).
//
// A pattern declares only the rules for a matching key's VALUE. It never makes
// a key required — a family cannot demand a member it has no name for. Where a
// specific member must exist (CP1_IP), declare it as an ordinary literal key;
// the literal wins over the pattern for validation.
type SchemaKeyPattern struct {
	SchemaKey `yaml:",inline"`

	// Role, when set, tells the resolver what the matching keys mean. The only
	// recognized value is RoleControlPlaneAddress.
	Role string `yaml:"role,omitempty"`
}

// SchemaFile represents a single .schema.yaml file.
type SchemaFile struct {
	Keys map[string]SchemaKey `yaml:"keys"`
	// KeyPatterns is keyed by an anchored key-name regex, not by a key name.
	KeyPatterns map[string]SchemaKeyPattern `yaml:"keyPatterns,omitempty"`
}

// Schema is the merged set of all schema keys across all schema files.
type Schema struct {
	Keys map[string]SchemaKey
	// KeyPatterns is keyed by an anchored key-name regex. Compiled forms live
	// in compiledKeyPatterns, built once by LoadSchemaDir.
	KeyPatterns map[string]SchemaKeyPattern

	// compiledKeyPatterns is the name-sorted, already-compiled view of
	// KeyPatterns. Sorted so every diagnostic this package emits is the same
	// string run over run: schema.Keys is a map whose iteration order already
	// leaks into CI diffs (see the sort in ValidateValues), and a second
	// unordered source would reintroduce that.
	compiledKeyPatterns []compiledKeyPattern
}

// compiledKeyPattern is one KeyPatterns entry with its regex already compiled.
type compiledKeyPattern struct {
	pattern string
	re      *regexp.Regexp
	key     SchemaKeyPattern
}

// ControlPlaneMember is one control-plane address, derived by the resolver from
// the RoleControlPlaneAddress key pattern.
type ControlPlaneMember struct {
	// Ordinal is the pattern's first capture group parsed as an integer: the 1
	// in CP1_IP. Exposed so a template can name cp-N without re-deriving the
	// key-name rule, which would restate the pattern once per consumer.
	Ordinal int
	// Key is the config key this member came from, e.g. "CP1_IP".
	Key string
	// Address is the resolved value.
	Address string
}

// Versions holds chart, image, and tool version strings.
type Versions struct {
	Charts map[string]string `yaml:"charts"`
	Images map[string]string `yaml:"images"`
	Tools  map[string]string `yaml:"tools"`
}

// ConfigValue is a resolved key-value pair with provenance.
type ConfigValue struct {
	Key    string
	Value  string
	Source string // "const", "defaults", "<set>" (e.g. "homelab"), "schema-default" or "unknown"; see eval.go
}

// ResolvedConfig is the output of the eval pipeline.
type ResolvedConfig struct {
	Values   map[string]ConfigValue
	Versions Versions
	Set      string // environment name (e.g. "homelab")

	// ControlPlane is the derived control-plane address list, ascending by
	// ordinal. Derived ONCE, here, from the RoleControlPlaneAddress key
	// pattern — templates and the #39 guard read this field rather than
	// re-deriving it, so the `^CP([0-9]+)_IP$` rule is stated in exactly two
	// places that a test holds identical: the topology contract and the schema.
	//
	// Nil when the schema declares no control-plane address pattern (small
	// fixture schemas in tests). len() is the member count ADR-035 derives;
	// ordinals need not be contiguous, so CP1/CP2/CP5 is three members.
	ControlPlane []ControlPlaneMember
}

// ExportFormat identifies an output format.
type ExportFormat string

const (
	FormatHelmAddons ExportFormat = "helm-addons"
	FormatHelmApps   ExportFormat = "helm-apps"
	FormatDotenv     ExportFormat = "env"
	FormatJSON       ExportFormat = "json"
)

// GuardResult holds PII scan results for a single file.
type GuardResult struct {
	File    string
	Matches []GuardMatch
}

// GuardMatch is a single PII pattern match.
type GuardMatch struct {
	Line    int
	Pattern string
	Content string
	// Note, when set, is printed instead of the standard "PII detected"
	// phrasing. A non-placeholder value in a template file is a different
	// finding: the value may not be PII at all, but a template may hold only
	// values from the documented placeholder set.
	Note string
}
