package config

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

// SchemaFile represents a single .schema.yaml file.
type SchemaFile struct {
	Keys map[string]SchemaKey `yaml:"keys"`
}

// Schema is the merged set of all schema keys across all schema files.
type Schema struct {
	Keys map[string]SchemaKey
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
}

// ExportFormat identifies an output format.
type ExportFormat string

const (
	FormatHelmAddons ExportFormat = "helm-addons"
	FormatHelmApps   ExportFormat = "helm-apps"
	FormatTfvars     ExportFormat = "tfvars"
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
