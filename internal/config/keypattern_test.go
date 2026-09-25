package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// cpPatternSchema builds a schema shaped like the real one: a literal CP1_IP
// and a control-plane address family, so tests exercise the interaction
// between the two rather than the family alone.
func cpPatternSchema(t *testing.T) *Schema {
	t.Helper()
	s, err := NewSchema(
		map[string]SchemaKey{
			"CP1_IP": {Required: true, Pattern: `^(?:\d{1,3}\.){3}\d{1,3}$`},
			"CP_VIP": {Required: true, Pattern: `^(?:\d{1,3}\.){3}\d{1,3}$`},
		},
		map[string]SchemaKeyPattern{
			`^CP([0-9]+)_IP$`: {
				SchemaKey: SchemaKey{Pattern: `^(?:\d{1,3}\.){3}\d{1,3}$`},
				Role:      RoleControlPlaneAddress,
			},
		},
	)
	if err != nil {
		t.Fatalf("building schema: %v", err)
	}
	return s
}

// TestKeyPatternMustBeAnchored is the Architect's condition 1. Unanchored,
// `CP[0-9]+_IP` also matches OLD_CP1_IP_BACKUP, so a leftover key in an
// environment file would be counted as a control-plane member and the guard
// would refuse on a healthy cluster.
func TestKeyPatternMustBeAnchored(t *testing.T) {
	for _, pattern := range []string{
		`CP([0-9]+)_IP`,  // neither anchor
		`^CP([0-9]+)_IP`, // no trailing $
		`CP([0-9]+)_IP$`, // no leading ^
	} {
		t.Run(pattern, func(t *testing.T) {
			_, err := NewSchema(nil, map[string]SchemaKeyPattern{
				pattern: {Role: RoleControlPlaneAddress},
			})
			if err == nil {
				t.Fatalf("unanchored pattern %q was accepted", pattern)
			}
			if !errors.Is(err, ErrInvalidKeyPattern) {
				t.Errorf("error %v does not wrap ErrInvalidKeyPattern", err)
			}
			if !strings.Contains(err.Error(), "anchored") {
				t.Errorf("error %q does not say why", err)
			}
		})
	}

	// And the anchored form still matches what it should, but not the decoys.
	s := cpPatternSchema(t)
	cp, ok := s.controlPlanePattern()
	if !ok {
		t.Fatal("anchored control-plane pattern was not registered")
	}
	for _, key := range []string{"CP1_IP", "CP2_IP", "CP10_IP"} {
		if !cp.re.MatchString(key) {
			t.Errorf("%q should be a control-plane address key", key)
		}
	}
	for _, key := range []string{"OLD_CP1_IP_BACKUP", "CP1_IP_OLD", "MY_CP1_IP", "CP_VIP", "WORKER1_IP"} {
		if cp.re.MatchString(key) {
			t.Errorf("%q must not be counted as a control-plane member", key)
		}
	}
}

// TestLiteralKeyWinsOverPattern is the first half of condition 2. CP1_IP is
// declared both literally and by the family; the literal's rules govern it.
func TestLiteralKeyWinsOverPattern(t *testing.T) {
	s, err := NewSchema(
		map[string]SchemaKey{
			// Deliberately stricter than the family: only 10.x is allowed here.
			"CP1_IP": {Required: true, Pattern: `^10\.`},
		},
		map[string]SchemaKeyPattern{
			`^CP([0-9]+)_IP$`: {
				SchemaKey: SchemaKey{Pattern: `^192\.0\.2\.`},
				Role:      RoleControlPlaneAddress,
			},
		},
	)
	if err != nil {
		t.Fatalf("building schema: %v", err)
	}

	// A value the family would accept but the literal rejects must be rejected:
	// the literal is the source of rules for its own name.
	err = ValidateValues(s, map[string]string{"CP1_IP": "192.0.2.11"})
	if err == nil {
		t.Fatal("literal key CP1_IP was validated against the family pattern, not its own")
	}
	// The message must cite the literal's own pattern, not the family's — that
	// is the observable difference between "literal wins" and "family wins".
	if strings.Contains(err.Error(), `192\.0\.2\.`) {
		t.Errorf("error %q cites the family pattern; the literal should have governed CP1_IP", err)
	}
	if !strings.Contains(err.Error(), `10`) {
		t.Errorf("error %q does not cite the literal key's own pattern", err)
	}

	// The converse: the literal's value is fine, a family member's is not.
	err = ValidateValues(s, map[string]string{"CP1_IP": "10.0.0.1", "CP2_IP": "10.0.0.2"})
	if err == nil {
		t.Fatal("CP2_IP was not validated against the family pattern")
	}
	if !strings.Contains(err.Error(), "CP2_IP") {
		t.Errorf("error %q does not name the offending family member", err)
	}
}

// TestAmbiguousKeyPatternIsAnError is the second half of condition 2. Two
// patterns matching one key name must not resolve by map order.
func TestAmbiguousKeyPatternIsAnError(t *testing.T) {
	s, err := NewSchema(nil, map[string]SchemaKeyPattern{
		`^CP([0-9]+)_IP$`: {
			SchemaKey: SchemaKey{Pattern: `^(?:\d{1,3}\.){3}\d{1,3}$`},
			Role:      RoleControlPlaneAddress,
		},
		// Overlaps the family on CP1_IP. Regex intersection is not decidable at
		// load, so the conflict surfaces at the first name that exhibits it.
		`^CP[0-9]_IP$`: {SchemaKey: SchemaKey{Pattern: `^nope$`}},
	})
	if err != nil {
		t.Fatalf("building schema: %v", err)
	}

	// Run repeatedly: a map-order-dependent implementation passes sometimes.
	for i := 0; i < 50; i++ {
		err := ValidateValues(s, map[string]string{"CP1_IP": "192.0.2.11"})
		if err == nil {
			t.Fatal("a key matching two patterns was silently resolved")
		}
		if !strings.Contains(err.Error(), "matches two key patterns") {
			t.Fatalf("error %q is not the ambiguity error", err)
		}
	}
}

// TestKeyPatternRejectsKeyLevelFields covers the fields that need a key name to
// mean anything. A family has no name to require, compute or default.
func TestKeyPatternRejectsKeyLevelFields(t *testing.T) {
	cases := map[string]SchemaKeyPattern{
		"required": {SchemaKey: SchemaKey{Required: true}},
		"const":    {SchemaKey: SchemaKey{Const: "x"}},
		"default":  {SchemaKey: SchemaKey{Default: "x"}},
	}
	for name, kp := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := NewSchema(nil, map[string]SchemaKeyPattern{`^CP([0-9]+)_IP$`: kp})
			if err == nil {
				t.Fatalf("pattern with %s was accepted", name)
			}
			if !errors.Is(err, ErrInvalidKeyPattern) {
				t.Errorf("error %v does not wrap ErrInvalidKeyPattern", err)
			}
		})
	}
}

// TestControlPlaneRoleRules covers the role's own preconditions: exactly one
// capture group for the ordinal, a known role name, and one family per schema.
func TestControlPlaneRoleRules(t *testing.T) {
	t.Run("needs exactly one capture group", func(t *testing.T) {
		for _, pattern := range []string{`^CP[0-9]+_IP$`, `^CP([0-9])([0-9])_IP$`} {
			_, err := NewSchema(nil, map[string]SchemaKeyPattern{
				pattern: {Role: RoleControlPlaneAddress},
			})
			if err == nil {
				t.Errorf("pattern %q was accepted with the control-plane role", pattern)
			}
		}
	})

	t.Run("unknown role is rejected", func(t *testing.T) {
		_, err := NewSchema(nil, map[string]SchemaKeyPattern{
			`^CP([0-9]+)_IP$`: {Role: "worker-address"},
		})
		if err == nil || !strings.Contains(err.Error(), "unknown role") {
			t.Fatalf("unknown role was accepted or misreported: %v", err)
		}
	})

	t.Run("two control-plane families is a load error", func(t *testing.T) {
		_, err := NewSchema(nil, map[string]SchemaKeyPattern{
			`^CP([0-9]+)_IP$`:   {Role: RoleControlPlaneAddress},
			`^NODE([0-9]+)_IP$`: {Role: RoleControlPlaneAddress},
		})
		if err == nil {
			t.Fatal("two control-plane address families were accepted — that is two answers to one question")
		}
	})
}

// TestLoadSchemaDirSurfacesKeyPatternErrors pins that a bad pattern is reported
// as a bad pattern. LoadSchemaDir skips files it cannot parse (the directory
// holds fixtures), and that tolerance must not silently swallow the file that
// declares the control-plane family.
func TestLoadSchemaDirSurfacesKeyPatternErrors(t *testing.T) {
	dir := t.TempDir()
	body := "" +
		"keyPatterns:\n" +
		"  \"CP([0-9]+)_IP\":\n" +
		"    role: control-plane-address\n" +
		"keys:\n" +
		"  DOMAIN:\n" +
		"    required: true\n"
	if err := os.WriteFile(filepath.Join(dir, "network.schema.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := LoadSchemaDir(dir)
	if err == nil {
		t.Fatal("LoadSchemaDir skipped a file with an invalid key pattern instead of reporting it")
	}
	if !errors.Is(err, ErrInvalidKeyPattern) {
		t.Errorf("error %v does not wrap ErrInvalidKeyPattern", err)
	}
}

// TestDeriveControlPlaneFailsClosedOnIndeterminate pins the failure semantics
// the topology contract states (`evaluation.onIndeterminate: unsafe`). Omitting
// an optional higher ordinal is a smaller cluster; declaring one and leaving it
// blank is a question nobody answered, on a path that destroys nodes.
func TestDeriveControlPlaneFailsClosedOnIndeterminate(t *testing.T) {
	s := cpPatternSchema(t)

	t.Run("blank value refuses the whole set", func(t *testing.T) {
		_, err := DeriveControlPlane(s, map[string]string{
			"CP1_IP": "192.0.2.11",
			"CP2_IP": "   ",
		})
		if err == nil {
			t.Fatal("a blank control-plane address resolved to a two-member cluster minus one, rather than refusing")
		}
		if !strings.Contains(err.Error(), "CP2_IP") {
			t.Errorf("error %q does not name the indeterminate key", err)
		}
	})

	t.Run("omitting a higher ordinal is simply a smaller cluster", func(t *testing.T) {
		members, err := DeriveControlPlane(s, map[string]string{"CP1_IP": "192.0.2.11"})
		if err != nil {
			t.Fatalf("a one-member control plane was refused: %v", err)
		}
		if len(members) != 1 {
			t.Fatalf("derived %d members, want 1", len(members))
		}
	})

	t.Run("no matching key at all is indeterminate", func(t *testing.T) {
		if _, err := DeriveControlPlane(s, map[string]string{"CP_VIP": "192.0.2.10"}); err == nil {
			t.Fatal("an empty control-plane set resolved rather than refusing")
		}
	})

	t.Run("a non-address value is caught by the family's value pattern", func(t *testing.T) {
		err := ValidateValues(s, map[string]string{"CP1_IP": "192.0.2.11", "CP4_IP": "REPLACEME"})
		if err == nil {
			t.Fatal("CP4_IP was admitted without being validated — the old 'unvalidated and unread' state")
		}
	})
}

// TestSchemaWithoutKeyPatternsIsUnaffected pins that the construct is additive:
// a schema that declares no pattern derives no control plane and rejects
// nothing new.
func TestSchemaWithoutKeyPatternsIsUnaffected(t *testing.T) {
	s, err := NewSchema(map[string]SchemaKey{"DOMAIN": {Required: true}}, nil)
	if err != nil {
		t.Fatalf("building schema: %v", err)
	}

	members, err := DeriveControlPlane(s, map[string]string{"CP1_IP": "192.0.2.11"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if members != nil {
		t.Errorf("derived %v from a schema with no control-plane family", members)
	}

	// An undeclared key still passes through untouched, as it always has.
	if err := ValidateValues(s, map[string]string{"DOMAIN": "example.com", "WHATEVER": "x"}); err != nil {
		t.Errorf("unexpected validation error: %v", err)
	}
}
