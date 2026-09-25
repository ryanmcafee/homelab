package config

import (
	"bytes"
	"fmt"
	"regexp"
	"sort"
	"strconv"
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

		errs = append(errs, validateValue(name, val, key)...)
	}

	// Keys no literal declaration covers, but a key pattern does. The literal
	// always wins: a name present in schema.Keys was validated above and is
	// skipped here, so CP1_IP is governed by its own entry, never the family's.
	//
	// Until this loop existed, a key an environment file declared but the
	// schema did not name flowed through Eval untouched. The state a fork was
	// actually in was therefore not "CP4_IP is forbidden" but "CP4_IP is
	// unvalidated and unread", which is the worse of the two.
	for _, name := range sortedNames(values) {
		if _, literal := schema.Keys[name]; literal {
			continue
		}
		kp, ok, err := schema.matchKeyPattern(name)
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		if !ok || values[name] == "" {
			continue
		}
		errs = append(errs, validateValue(name, values[name], kp.SchemaKey)...)
	}

	if len(errs) > 0 {
		// schema.Keys is a map, so these messages are collected in Go's
		// randomized iteration order. The joined string ends up verbatim in
		// the render/<env>/_config check detail, which level 0 emits as JSON
		// and CI diffs run over run, so it has to be stable.
		sort.Strings(errs)
		return fmt.Errorf("validation errors:\n  %s", strings.Join(errs, "\n  "))
	}
	return nil
}

// validateValue checks one non-empty value against a key's value rules and
// returns the messages, if any. Shared by the literal-key and pattern-key
// paths so a family member is held to exactly the rules a literal would be.
func validateValue(name, val string, key SchemaKey) []string {
	var errs []string

	if key.Pattern != "" {
		re, err := regexp.Compile(key.Pattern)
		if err != nil {
			return append(errs, fmt.Sprintf("key %q has invalid pattern %q: %v", name, key.Pattern, err))
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

	return errs
}

// sortedNames returns a map's keys in ascending order, so every loop over a
// value map produces its diagnostics in the same order run over run.
func sortedNames(m map[string]string) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
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
			// constKeys is a map; sort so the message, which reaches the
			// render/<env>/_config check detail, is the same every run.
			sort.Strings(unresolved)
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

	if err := ValidateAddressRoles(schema, resolved); err != nil {
		return nil, fmt.Errorf("validation failed for set %q: %w", setName, err)
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

	// 6. Derive the control-plane address list. Once, here — every consumer
	// reads the field instead of re-applying the key-name rule.
	controlPlane, err := DeriveControlPlane(schema, resolved)
	if err != nil {
		return nil, fmt.Errorf("control-plane derivation failed for set %q: %w", setName, err)
	}

	return &ResolvedConfig{
		Values:       values,
		Versions:     *versions,
		Set:          setName,
		ControlPlane: controlPlane,
	}, nil
}

// DeriveControlPlane resolves the control-plane address list from the schema's
// RoleControlPlaneAddress key pattern, ascending by ordinal.
//
// This is the single implementation of ADR-035's rule "the member count derives
// from the ConfigSet's control-plane address keys". It returns nil when the
// schema declares no such family, which is how the small fixture schemas in
// tests stay unaffected.
//
// Failure semantics come from contracts/cluster/topology.v1.yaml
// (`evaluation.onIndeterminate: unsafe`): a declared address key that cannot be
// resolved to an address makes the WHOLE set indeterminate, not one member
// smaller. Omitting an optional higher ordinal is a smaller cluster; declaring
// CP3_IP and leaving it blank is a question nobody answered, and the caller is
// on a path that destroys nodes.
func DeriveControlPlane(schema *Schema, values map[string]string) ([]ControlPlaneMember, error) {
	cp, ok := schema.controlPlanePattern()
	if !ok {
		return nil, nil
	}

	var members []ControlPlaneMember
	for _, name := range sortedNames(values) {
		m := cp.re.FindStringSubmatch(name)
		if m == nil {
			continue
		}
		value := strings.TrimSpace(values[name])
		if value == "" {
			return nil, fmt.Errorf(
				"control-plane address key %q is declared with an empty value: the member count is indeterminate, "+
					"which contracts/cluster/topology.v1.yaml treats as unsafe — give it an address or remove the key",
				name)
		}
		ordinal, err := strconv.Atoi(m[1])
		if err != nil {
			// Unreachable while the pattern's capture group is digits, but the
			// pattern is data and a future one may not be.
			return nil, fmt.Errorf("control-plane address key %q has non-numeric ordinal %q: %w", name, m[1], err)
		}
		members = append(members, ControlPlaneMember{Ordinal: ordinal, Key: name, Address: value})
	}

	if len(members) == 0 {
		return nil, fmt.Errorf(
			"no control-plane address key matched %q: the member count is indeterminate, "+
				"which contracts/cluster/topology.v1.yaml treats as unsafe", cp.pattern)
	}

	// Ascending by ordinal, not by key name: sorted as strings CP10_IP sorts
	// before CP2_IP, and cp-10 would then be rendered second.
	sort.Slice(members, func(i, j int) bool { return members[i].Ordinal < members[j].Ordinal })

	for i := 1; i < len(members); i++ {
		if members[i].Ordinal == members[i-1].Ordinal {
			// Two key names, one ordinal (CP1_IP and CP01_IP). Which one is
			// cp-1 would be arbitrary, so refuse rather than pick.
			return nil, fmt.Errorf("control-plane keys %q and %q both resolve to ordinal %d",
				members[i-1].Key, members[i].Key, members[i].Ordinal)
		}
	}

	return members, nil
}
