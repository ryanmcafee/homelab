package config

import (
	"path/filepath"
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
