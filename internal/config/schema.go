package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// ErrInvalidKeyPattern marks a schema file that parsed but declares an
// unusable keyPatterns entry.
//
// LoadSchemaDir deliberately skips files it cannot parse, because the schema
// directory also holds test fixtures. That tolerance must not extend to a
// malformed key pattern: silently dropping the file that declares the
// control-plane address family would turn "your pattern is wrong" into "half
// the network schema does not exist", and the operator would debug the wrong
// thing. Errors wrapping this sentinel are surfaced, not skipped.
var ErrInvalidKeyPattern = errors.New("invalid key pattern")

// LoadSchemaFile loads and parses a single .schema.yaml file.
func LoadSchemaFile(path string) (*SchemaFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading schema %s: %w", path, err)
	}

	var sf SchemaFile
	if err := yaml.Unmarshal(data, &sf); err != nil {
		return nil, fmt.Errorf("parsing schema %s: %w", path, err)
	}

	if len(sf.Keys) == 0 {
		return nil, fmt.Errorf("schema %s has no 'keys' field or keys are empty", path)
	}

	// Sorted so a file with two bad patterns reports the same one first every
	// run; map order would make the message flap between CI runs.
	patterns := make([]string, 0, len(sf.KeyPatterns))
	for pattern := range sf.KeyPatterns {
		patterns = append(patterns, pattern)
	}
	sort.Strings(patterns)
	for _, pattern := range patterns {
		if err := validateKeyPattern(pattern, sf.KeyPatterns[pattern]); err != nil {
			return nil, fmt.Errorf("schema %s: %w", path, err)
		}
	}

	return &sf, nil
}

// validateKeyPattern rejects a keyPatterns entry that cannot be resolved
// safely. Every rule here fails at LOAD rather than at first match: a pattern
// that quietly matches the wrong key names mis-derives the control-plane member
// count, and that count gates a destructive operation (#39).
func validateKeyPattern(pattern string, kp SchemaKeyPattern) error {
	if !strings.HasPrefix(pattern, "^") || !strings.HasSuffix(pattern, "$") {
		// Unanchored, CP[0-9]+_IP also matches OLD_CP1_IP_BACKUP. A leftover
		// key in an environment file would then be counted as a control-plane
		// member and the guard would refuse on a healthy cluster — the exact
		// failure ADR-035 exists to prevent.
		return fmt.Errorf("%w: %q must be anchored with ^ and $", ErrInvalidKeyPattern, pattern)
	}

	re, err := regexp.Compile(pattern)
	if err != nil {
		return fmt.Errorf("%w: %q is not a valid regexp: %v", ErrInvalidKeyPattern, pattern, err)
	}

	switch {
	case kp.Required:
		// A pattern matches zero or more keys and has no name to demand. A
		// member that must exist is a literal key (CP1_IP), not a family.
		return fmt.Errorf("%w: %q cannot be required; declare the mandatory member as a literal key instead",
			ErrInvalidKeyPattern, pattern)
	case kp.Const != "":
		return fmt.Errorf("%w: %q cannot declare const; a computed key has exactly one name, so declare it literally",
			ErrInvalidKeyPattern, pattern)
	case kp.Default != "":
		// ApplyDefaults needs a key name to write to, and a family has none.
		return fmt.Errorf("%w: %q cannot declare a default; there is no key name to apply it to",
			ErrInvalidKeyPattern, pattern)
	}

	switch kp.Role {
	case "":
	case RoleControlPlaneAddress:
		if re.NumSubexp() != 1 {
			return fmt.Errorf("%w: %q has role %q and needs exactly one capture group for the member ordinal, found %d",
				ErrInvalidKeyPattern, pattern, RoleControlPlaneAddress, re.NumSubexp())
		}
	default:
		return fmt.Errorf("%w: %q declares unknown role %q", ErrInvalidKeyPattern, pattern, kp.Role)
	}

	return nil
}

// LoadSchemaDir loads all .schema.yaml files from a directory and merges them into a single Schema.
func LoadSchemaDir(dir string) (*Schema, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("reading schema directory %s: %w", dir, err)
	}

	schema := &Schema{
		Keys:        make(map[string]SchemaKey),
		KeyPatterns: make(map[string]SchemaKeyPattern),
	}
	patternSource := make(map[string]string)

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".schema.yaml") {
			continue
		}

		sf, err := LoadSchemaFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			if errors.Is(err, ErrInvalidKeyPattern) {
				return nil, err
			}
			// Skip otherwise-invalid files in directory mode (e.g. test fixtures)
			continue
		}

		for name, key := range sf.Keys {
			if _, exists := schema.Keys[name]; exists {
				return nil, fmt.Errorf("duplicate key %q found in %s", name, entry.Name())
			}
			schema.Keys[name] = key
		}

		for pattern, kp := range sf.KeyPatterns {
			if _, exists := schema.KeyPatterns[pattern]; exists {
				return nil, fmt.Errorf("duplicate key pattern %q found in %s and %s",
					pattern, patternSource[pattern], entry.Name())
			}
			schema.KeyPatterns[pattern] = kp
			patternSource[pattern] = entry.Name()
		}
	}

	if len(schema.Keys) == 0 {
		return nil, fmt.Errorf("no valid schema keys found in %s", dir)
	}

	if err := schema.compileKeyPatterns(); err != nil {
		return nil, err
	}

	return schema, nil
}

// NewSchema builds a Schema from literal keys and key patterns, running the
// same load-time validation LoadSchemaDir runs. Use it instead of a Schema
// literal whenever key patterns are involved: a Schema literal leaves the
// compiled pattern list empty, so every pattern silently does nothing.
func NewSchema(keys map[string]SchemaKey, keyPatterns map[string]SchemaKeyPattern) (*Schema, error) {
	s := &Schema{
		Keys:        make(map[string]SchemaKey, len(keys)),
		KeyPatterns: make(map[string]SchemaKeyPattern, len(keyPatterns)),
	}
	for name, key := range keys {
		s.Keys[name] = key
	}
	for pattern, kp := range keyPatterns {
		s.KeyPatterns[pattern] = kp
	}
	if err := s.compileKeyPatterns(); err != nil {
		return nil, err
	}
	return s, nil
}

// compileKeyPatterns builds the sorted, compiled pattern list and enforces the
// merged-schema invariants a single file cannot see.
func (s *Schema) compileKeyPatterns() error {
	patterns := make([]string, 0, len(s.KeyPatterns))
	for pattern := range s.KeyPatterns {
		patterns = append(patterns, pattern)
	}
	sort.Strings(patterns)

	compiled := make([]compiledKeyPattern, 0, len(patterns))
	controlPlane := ""
	for _, pattern := range patterns {
		kp := s.KeyPatterns[pattern]
		if err := validateKeyPattern(pattern, kp); err != nil {
			return err
		}
		re, err := regexp.Compile(pattern)
		if err != nil {
			return fmt.Errorf("%w: %q is not a valid regexp: %v", ErrInvalidKeyPattern, pattern, err)
		}
		if kp.Role == RoleControlPlaneAddress {
			if controlPlane != "" {
				// Two control-plane families means two answers to "how many
				// members are there", which is the second source of truth
				// ADR-035 removed.
				return fmt.Errorf("%w: %q and %q both declare role %q; there can be only one control-plane address family",
					ErrInvalidKeyPattern, controlPlane, pattern, RoleControlPlaneAddress)
			}
			controlPlane = pattern
		}
		compiled = append(compiled, compiledKeyPattern{pattern: pattern, re: re, key: kp})
	}

	s.compiledKeyPatterns = compiled
	return nil
}

// matchKeyPattern returns the pattern entry governing a key name that has no
// literal declaration, and whether one matched.
//
// Two patterns matching the same key name is an ERROR, never last-one-wins:
// regex intersection is not decidable at load, so the conflict is caught here,
// at the first name that exhibits it. Either answer would otherwise depend on
// map iteration order, and a resolver whose output depends on map order is not
// a resolver.
func (s *Schema) matchKeyPattern(name string) (SchemaKeyPattern, bool, error) {
	var match SchemaKeyPattern
	matched := ""
	for _, cp := range s.compiledKeyPatterns {
		if !cp.re.MatchString(name) {
			continue
		}
		if matched != "" {
			return SchemaKeyPattern{}, false, fmt.Errorf(
				"key %q matches two key patterns, %q and %q; a key must have exactly one source of validation rules",
				name, matched, cp.pattern)
		}
		match, matched = cp.key, cp.pattern
	}
	return match, matched != "", nil
}

// controlPlanePattern returns the compiled RoleControlPlaneAddress pattern.
func (s *Schema) controlPlanePattern() (compiledKeyPattern, bool) {
	for _, cp := range s.compiledKeyPatterns {
		if cp.key.Role == RoleControlPlaneAddress {
			return cp, true
		}
	}
	return compiledKeyPattern{}, false
}
