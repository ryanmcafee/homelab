package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/config"
)

// schemaFieldsCheck runs the gate over one fixture repo root and returns its
// single check.
func schemaFieldsCheck(t *testing.T, root string) Check {
	t.Helper()
	checks := SchemaFields(root)
	if len(checks) != 1 {
		t.Fatalf("want exactly one check, got %d: %+v", len(checks), checks)
	}
	return checks[0]
}

// This is the compatibility test the strict/lenient split turns on, and the two assertions are
// deliberately opposite. One fixture file carrying an unknown field must fail
// the level-0 gate AND still load through the resolver, because those are the
// two halves of the decision: strict where binary and schema share a commit,
// lenient where a fork's binary may predate its schema files.
//
// Either assertion alone is the wrong design. Drop the first and the typo is
// silent again; drop the second and an older binary hard-fails on a field that
// is merely new to it.
func TestSchemaFieldsRejectsWhatTheResolverAccepts(t *testing.T) {
	root := filepath.Join("testdata", "schema-typo")

	c := schemaFieldsCheck(t, root)
	if c.Status != StatusFail {
		t.Fatalf("gate: want fail on a misspelled field, got %s: %s", c.Status, c.Detail)
	}
	for _, want := range []string{"requred", "patern"} {
		if !strings.Contains(strings.Join(c.Findings, "\n"), want) {
			t.Errorf("gate: findings do not name %q: %v", want, c.Findings)
		}
	}

	schema, err := config.LoadSchemaDir(filepath.Join(root, ConfigSchemaPath))
	if err != nil {
		t.Fatalf("resolver: want the same file to load, got %v", err)
	}
	// The resolver's tolerance is exactly the hazard the gate covers: it reads
	// the file, and the misspelled field is gone rather than fatal.
	if key, ok := schema.Keys["TYPO_REQUIRED"]; !ok {
		t.Error("resolver: TYPO_REQUIRED did not load")
	} else if key.Required {
		t.Error("resolver: TYPO_REQUIRED is required, so `requred:` was not the silent drop this gate exists for")
	}
	if key, ok := schema.Keys["TYPO_PATTERN"]; !ok {
		t.Error("resolver: TYPO_PATTERN did not load")
	} else if key.Pattern != "" {
		t.Errorf("resolver: TYPO_PATTERN kept a pattern %q, so `patern:` was not silently dropped", key.Pattern)
	}
}

// A directory with no schema file must not pass. The check reports one file
// count and no findings, which reads exactly like a clean scan.
func TestSchemaFieldsFailsWhenItInspectedNothing(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(ConfigSchemaPath)), 0o755); err != nil {
		t.Fatal(err)
	}

	c := schemaFieldsCheck(t, root)
	if c.Status != StatusFail {
		t.Fatalf("want fail on an empty schema directory, got %s: %s", c.Status, c.Detail)
	}
}

// A missing directory is a failure too, not a skip: the configuration contract
// is not optional, and "the path moved" must not read as "no typos found".
func TestSchemaFieldsFailsWhenTheDirectoryIsAbsent(t *testing.T) {
	c := schemaFieldsCheck(t, t.TempDir())
	if c.Status != StatusFail {
		t.Fatalf("want fail on an absent schema directory, got %s: %s", c.Status, c.Detail)
	}
}

// The gate is only real if the contract it guards passes it. Without this the
// check can be committed green against fixtures while the committed schema
// already carries a typo (quality-gates.md sec. 2 point 4).
func TestSchemaFieldsPassesOnTheCommittedSchema(t *testing.T) {
	root, err := FindRepoRoot(mustGetwd(t))
	if err != nil {
		t.Fatal(err)
	}
	c := schemaFieldsCheck(t, root)
	if c.Status != StatusPass {
		t.Fatalf("%s on %s: %s -- %s%v", c.Name, ConfigSchemaPath, c.Status, c.Detail, c.Findings)
	}
}
