package config

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"
	"text/template"
)

// ValidateValues checks that all values satisfy schema constraints (required, pattern, enum).
func ValidateValues(schema *Schema, values map[string]string) error {
	var errs []string

	for name, key := range schema.Keys {
		// Skip const keys — they are computed, not user-provided
		if key.Const != "" {
			continue
		}

		val, exists := values[name]

		if key.Required && (!exists || val == "") {
			errs = append(errs, fmt.Sprintf("required key %q is missing or empty", name))
			continue
		}

		if !exists || val == "" {
			continue
		}

		if key.Pattern != "" {
			re, err := regexp.Compile(key.Pattern)
			if err != nil {
				errs = append(errs, fmt.Sprintf("key %q has invalid pattern %q: %v", name, key.Pattern, err))
				continue
			}
			if !re.MatchString(val) {
				errs = append(errs, fmt.Sprintf("key %q value %q does not match pattern %q", name, val, key.Pattern))
			}
		}

		if len(key.Enum) > 0 {
			found := false
			for _, allowed := range key.Enum {
				if val == allowed {
					found = true
					break
				}
			}
			if !found {
				errs = append(errs, fmt.Sprintf("key %q value %q is not in enum %v", name, val, key.Enum))
			}
		}
	}

	if len(errs) > 0 {
		return fmt.Errorf("validation errors:\n  %s", strings.Join(errs, "\n  "))
	}
	return nil
}

// ApplyDefaults fills in missing values from schema defaults. Does not override existing values.
func ApplyDefaults(schema *Schema, values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for k, v := range values {
		result[k] = v
	}

	for name, key := range schema.Keys {
		if key.Default != "" {
			if _, exists := result[name]; !exists {
				result[name] = key.Default
			}
		}
	}

	return result
}

// ResolveExpressions evaluates all const expressions in the schema using the provided values.
// Uses multi-pass resolution to handle expressions that reference other computed keys.
func ResolveExpressions(schema *Schema, values map[string]string) (map[string]string, error) {
	result := make(map[string]string, len(values))
	for k, v := range values {
		result[k] = v
	}

	// Collect all const keys
	constKeys := make(map[string]string)
	for name, key := range schema.Keys {
		if key.Const != "" {
			constKeys[name] = key.Const
		}
	}

	// Multi-pass resolution (max 10 passes to detect circular refs)
	for pass := 0; pass < 10; pass++ {
		resolved := 0
		for name, expr := range constKeys {
			tmpl, err := template.New(name).Parse(expr)
			if err != nil {
				return nil, fmt.Errorf("parsing expression for %q: %w", name, err)
			}

			var buf bytes.Buffer
			if err := tmpl.Execute(&buf, result); err != nil {
				// May fail if referenced keys aren't resolved yet — try next pass
				continue
			}

			val := buf.String()
			if !strings.Contains(val, "<no value>") {
				result[name] = val
				delete(constKeys, name)
				resolved++
			}
		}

		if len(constKeys) == 0 {
			break
		}
		if resolved == 0 {
			unresolved := make([]string, 0, len(constKeys))
			for name := range constKeys {
				unresolved = append(unresolved, name)
			}
			return nil, fmt.Errorf("circular or unresolvable expressions: %v", unresolved)
		}
	}

	return result, nil
}

// Eval runs the full config pipeline: merge hierarchy -> apply defaults -> validate -> resolve expressions.
func Eval(schema *Schema, versions *Versions, setName string, layers ...map[string]string) (*ResolvedConfig, error) {
	// 1. Merge hierarchy
	merged := ResolveHierarchy(layers...)

	// 2. Apply schema defaults
	merged = ApplyDefaults(schema, merged)

	// 3. Validate
	if err := ValidateValues(schema, merged); err != nil {
		return nil, fmt.Errorf("validation failed for set %q: %w", setName, err)
	}

	// 4. Resolve expressions
	resolved, err := ResolveExpressions(schema, merged)
	if err != nil {
		return nil, fmt.Errorf("expression resolution failed: %w", err)
	}

	// 5. Build ResolvedConfig with provenance
	values := make(map[string]ConfigValue, len(resolved))
	for key, val := range resolved {
		source := "unknown"
		if sk, ok := schema.Keys[key]; ok && sk.Const != "" {
			source = "const"
		} else {
			// Determine source by checking layers in reverse
			for i := len(layers) - 1; i >= 0; i-- {
				if _, ok := layers[i][key]; ok {
					if i == 0 {
						source = "defaults"
					} else {
						source = setName
					}
					break
				}
			}
			if source == "unknown" {
				if sk, ok := schema.Keys[key]; ok && sk.Default != "" {
					source = "schema-default"
				}
			}
		}

		values[key] = ConfigValue{
			Key:    key,
			Value:  val,
			Source: source,
		}
	}

	return &ResolvedConfig{
		Values:   values,
		Versions: *versions,
		Set:      setName,
	}, nil
}
