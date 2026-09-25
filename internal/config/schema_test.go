package config

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func testdataPath(parts ...string) string {
	return filepath.Join(append([]string{"testdata"}, parts...)...)
}

func TestLoadSchemaFile(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
		wantN   int // expected number of keys
	}{
		{
			name:    "valid schema loads all keys",
			path:    testdataPath("schemas", "valid.schema.yaml"),
			wantErr: false,
			wantN:   5,
		},
		{
			name:    "missing file returns error",
			path:    testdataPath("schemas", "nonexistent.schema.yaml"),
			wantErr: true,
		},
		{
			name:    "schema with no keys field returns error",
			path:    testdataPath("schemas_invalid", "invalid_no_keys.schema.yaml"),
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sf, err := LoadSchemaFile(tt.path)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(sf.Keys) != tt.wantN {
				t.Errorf("got %d keys, want %d", len(sf.Keys), tt.wantN)
			}
		})
	}
}

func TestLoadSchemaDir(t *testing.T) {
	schema, err := LoadSchemaDir(testdataPath("schemas"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// valid.schema.yaml has 5 keys
	if len(schema.Keys) < 5 {
		t.Errorf("got %d keys, want at least 5", len(schema.Keys))
	}
	// Check a specific key
	k, ok := schema.Keys["DOMAIN"]
	if !ok {
		t.Fatal("DOMAIN key not found")
	}
	if !k.Required {
		t.Error("DOMAIN should be required")
	}
}

func TestSchemaKeyProperties(t *testing.T) {
	sf, err := LoadSchemaFile(testdataPath("schemas", "valid.schema.yaml"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tests := []struct {
		name      string
		key       string
		wantReq   bool
		wantPat   string
		wantDef   string
		wantConst string
		wantEnumN int
	}{
		{"required key", "DOMAIN", true, "", "", "", 0},
		{"key with pattern", "IP_ADDR", true, "^(?:\\d{1,3}\\.){3}\\d{1,3}$", "", "", 0},
		{"key with default", "OPTIONAL_KEY", false, "", "fallback", "", 0},
		{"const key", "COMPUTED", false, "", "", "app.{{.DOMAIN}}", 0},
		{"enum key", "COLOR", true, "", "", "", 3},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			k, ok := sf.Keys[tt.key]
			if !ok {
				t.Fatalf("key %s not found", tt.key)
			}
			if k.Required != tt.wantReq {
				t.Errorf("Required = %v, want %v", k.Required, tt.wantReq)
			}
			if k.Pattern != tt.wantPat {
				t.Errorf("Pattern = %q, want %q", k.Pattern, tt.wantPat)
			}
			if k.Default != tt.wantDef {
				t.Errorf("Default = %q, want %q", k.Default, tt.wantDef)
			}
			if k.Const != tt.wantConst {
				t.Errorf("Const = %q, want %q", k.Const, tt.wantConst)
			}
			if len(k.Enum) != tt.wantEnumN {
				t.Errorf("Enum len = %d, want %d", len(k.Enum), tt.wantEnumN)
			}
		})
	}
}

// --- Schema-loader fail-closed contract (MCAA-145) ---------------------------
//
// ADR-028 guarantees that a missing required key fails at resolve rather than
// rendering somebody else's topology. LoadSchemaDir used to skip any
// *.schema.yaml it could not load, which silently removed every key that file
// declared -- including every `required: true` in it -- while `config
// validate`, `eval` and `export` all still exited 0. A YAML slip three keys
// away could stop a long-standing, unrelated key from being required, and the
// only symptom was a negative test that passed too quietly.
//
// These fixtures are written to a temp dir rather than committed under
// testdata/ so that no unparseable *.schema.yaml exists anywhere in the tree
// for another directory-scanning test or lint job to trip over.

const validNetworkSchema = `keys:
  LAN_CIDR:
    description: the LAN subnet in CIDR notation
    required: true
`

// malformedInfrastructureSchema is the MCAA-145 trigger: a plain multi-line
// `description:` whose continuation line is not a legal plain scalar
// continuation. Note that a bare quoted phrase on the continuation line does
// parse -- it is the `:` that makes yaml.v3 report "mapping values are not
// allowed in this context". NFS_MAPALL_USER is the tell from the original
// report: a pre-existing required key several lines away from the typo.
const malformedInfrastructureSchema = `keys:
  PROXMOX_NODE:
    description: the Proxmox node this cluster runs on
      note: "pve" is the upstream default
    required: true
  NFS_MAPALL_USER:
    description: the user NFS exports map all access to
    required: true
`

func writeSchemaDir(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatalf("writing fixture %s: %v", name, err)
		}
	}
	return dir
}

// TestLoadSchemaDirFailsClosedOnUnloadableFile pins the core fix: a schema
// directory containing one file the loader cannot use must make LoadSchemaDir
// fail, not return a short key set.
func TestLoadSchemaDirFailsClosedOnUnloadableFile(t *testing.T) {
	tests := []struct {
		name   string
		broken string // contents of infrastructure.schema.yaml
	}{
		{"unparseable yaml", malformedInfrastructureSchema},
		{"parses but declares no keys", "not_keys:\n  SOMETHING: true\n"},
		{"empty file", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := writeSchemaDir(t, map[string]string{
				"network.schema.yaml":        validNetworkSchema,
				"infrastructure.schema.yaml": tt.broken,
			})

			schema, err := LoadSchemaDir(dir)
			if err == nil {
				keys := make([]string, 0, len(schema.Keys))
				for k := range schema.Keys {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				t.Fatalf("LoadSchemaDir succeeded over an unloadable schema file; got keys %v, want an error", keys)
			}
			if schema != nil {
				t.Errorf("LoadSchemaDir returned a non-nil schema alongside its error")
			}
			// The signal has to name the file, or an operator cannot find the slip.
			if !strings.Contains(err.Error(), "infrastructure.schema.yaml") {
				t.Errorf("error does not name the offending file: %v", err)
			}
		})
	}
}

// TestLoadSchemaDirDoesNotDowngradeRequiredKeys is the MCAA-145 evidence table
// as an assertion. With one file unloadable, the loader must never hand back a
// schema in which a `required: true` key -- from the broken file or from an
// unrelated one -- has quietly become absent or optional.
func TestLoadSchemaDirDoesNotDowngradeRequiredKeys(t *testing.T) {
	dir := writeSchemaDir(t, map[string]string{
		"network.schema.yaml":        validNetworkSchema,
		"infrastructure.schema.yaml": malformedInfrastructureSchema,
	})

	schema, err := LoadSchemaDir(dir)
	if err != nil {
		// Fail-closed: nothing resolved, so nothing was silently downgraded.
		return
	}

	for _, key := range []string{"PROXMOX_NODE", "NFS_MAPALL_USER", "LAN_CIDR"} {
		k, ok := schema.Keys[key]
		if !ok {
			t.Errorf("%s: present=false -- dropped from the resolved schema entirely", key)
			continue
		}
		if !k.Required {
			t.Errorf("%s: required=false -- declared `required: true` in its schema file", key)
		}
	}
}

// TestLoadSchemaDirIgnoresNonSchemaFiles keeps the fail-closed rule scoped to
// the files the loader actually claims: unrelated files sharing the directory
// must not turn a healthy schema dir into a hard error.
func TestLoadSchemaDirIgnoresNonSchemaFiles(t *testing.T) {
	dir := writeSchemaDir(t, map[string]string{
		"network.schema.yaml": validNetworkSchema,
		"README.md":           "# not a schema\n",
		"notes.yaml":          "this: is not a *.schema.yaml file\n",
	})

	schema, err := LoadSchemaDir(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := schema.Keys["LAN_CIDR"]; !ok {
		t.Error("LAN_CIDR not loaded")
	}
}
