package config

import (
	"errors"
	"os"
	"path/filepath"
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
			path:    testdataPath("schemas", "invalid_no_keys.schema.yaml"),
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

// A *.schema.yml file is a naming slip, not a bystander. Skipping it would
// drop every key it declares, including required ones, with exit 0.
func TestLoadSchemaDirRejectsYmlExtension(t *testing.T) {
	dir := t.TempDir()
	writeSchemaDirFile(t, dir, "network.schema.yaml", "keys:\n  LAN_CIDR:\n    required: true\n    description: lan\n")
	writeSchemaDirFile(t, dir, "infrastructure.schema.yml", "keys:\n  PROXMOX_NODE:\n    required: true\n    description: node\n")

	schema, err := LoadSchemaDir(dir)
	if err == nil {
		_, present := schema.Keys["PROXMOX_NODE"]
		t.Fatalf("no error returned; PROXMOX_NODE present=%v", present)
	}
	if !errors.Is(err, ErrSchemaExtension) {
		t.Errorf("error does not wrap ErrSchemaExtension: %v", err)
	}
	for _, want := range []string{"infrastructure.schema.yml", "infrastructure.schema.yaml"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

// The rejection must stay narrow: files that are genuinely not schema files
// are still ignored, so the directory can hold a README or scratch YAML.
func TestLoadSchemaDirIgnoresUnrelatedFiles(t *testing.T) {
	dir := t.TempDir()
	writeSchemaDirFile(t, dir, "network.schema.yaml", "keys:\n  LAN_CIDR:\n    required: true\n    description: lan\n")
	writeSchemaDirFile(t, dir, "README.md", "# schemas\n")
	writeSchemaDirFile(t, dir, "notes.yaml", "scratch: true\n")
	writeSchemaDirFile(t, dir, "values.yml", "scratch: true\n")

	schema, err := LoadSchemaDir(dir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(schema.Keys) != 1 {
		t.Errorf("got %d keys, want 1", len(schema.Keys))
	}
}

func writeSchemaDirFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
}
