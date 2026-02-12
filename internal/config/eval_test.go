package config

import (
	"testing"
)

func TestValidateValues(t *testing.T) {
	schema := &Schema{
		Keys: map[string]SchemaKey{
			"DOMAIN":   {Required: true},
			"IP_ADDR":  {Required: true, Pattern: `^(?:\d{1,3}\.){3}\d{1,3}$`},
			"OPTIONAL": {Required: false, Default: "fallback"},
			"COLOR":    {Required: true, Enum: []string{"red", "green", "blue"}},
		},
	}

	tests := []struct {
		name    string
		values  map[string]string
		wantErr bool
	}{
		{
			name:    "all required present and valid",
			values:  map[string]string{"DOMAIN": "test.local", "IP_ADDR": "192.168.1.1", "COLOR": "red"},
			wantErr: false,
		},
		{
			name:    "missing required key",
			values:  map[string]string{"IP_ADDR": "192.168.1.1", "COLOR": "red"},
			wantErr: true,
		},
		{
			name:    "pattern mismatch",
			values:  map[string]string{"DOMAIN": "test.local", "IP_ADDR": "not-an-ip", "COLOR": "red"},
			wantErr: true,
		},
		{
			name:    "enum violation",
			values:  map[string]string{"DOMAIN": "test.local", "IP_ADDR": "192.168.1.1", "COLOR": "purple"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateValues(schema, tt.values)
			if tt.wantErr && err == nil {
				t.Fatal("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestApplyDefaults(t *testing.T) {
	schema := &Schema{
		Keys: map[string]SchemaKey{
			"DOMAIN":   {Required: true},
			"OPTIONAL": {Required: false, Default: "fallback"},
			"ANOTHER":  {Required: false, Default: "default-val"},
		},
	}

	values := map[string]string{
		"DOMAIN":  "test.local",
		"ANOTHER": "custom",
	}

	result := ApplyDefaults(schema, values)

	if result["OPTIONAL"] != "fallback" {
		t.Errorf("OPTIONAL = %q, want %q", result["OPTIONAL"], "fallback")
	}
	if result["ANOTHER"] != "custom" {
		t.Errorf("ANOTHER = %q, want %q (should not be overridden)", result["ANOTHER"], "custom")
	}
	if result["DOMAIN"] != "test.local" {
		t.Errorf("DOMAIN = %q, want %q", result["DOMAIN"], "test.local")
	}
}

func TestResolveExpressions(t *testing.T) {
	schema := &Schema{
		Keys: map[string]SchemaKey{
			"DOMAIN":    {},
			"HOSTNAME":  {Const: "app.{{.DOMAIN}}"},
			"FULL_URL":  {Const: "https://{{.HOSTNAME}}"},
			"BASE_PATH": {},
			"SUB_PATH":  {Const: "{{.BASE_PATH}}/data"},
		},
	}

	values := map[string]string{
		"DOMAIN":    "example.com",
		"BASE_PATH": "/mnt/storage",
	}

	result, err := ResolveExpressions(schema, values)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tests := []struct {
		key  string
		want string
	}{
		{"HOSTNAME", "app.example.com"},
		{"FULL_URL", "https://app.example.com"},
		{"SUB_PATH", "/mnt/storage/data"},
		{"DOMAIN", "example.com"},
	}

	for _, tt := range tests {
		t.Run(tt.key, func(t *testing.T) {
			if result[tt.key] != tt.want {
				t.Errorf("got %q, want %q", result[tt.key], tt.want)
			}
		})
	}
}

func TestEval(t *testing.T) {
	// Full pipeline test using testdata files
	schema, err := LoadSchemaDir(testdataPath("schemas"))
	if err != nil {
		t.Fatalf("loading schemas: %v", err)
	}

	defaults, err := LoadEnvironment(testdataPath("environments", "defaults.yaml"))
	if err != nil {
		t.Fatalf("loading defaults: %v", err)
	}

	env, err := LoadEnvironment(testdataPath("environments", "test.yaml"))
	if err != nil {
		t.Fatalf("loading env: %v", err)
	}

	versions, err := LoadVersions(testdataPath("versions.yaml"))
	if err != nil {
		t.Fatalf("loading versions: %v", err)
	}

	rc, err := Eval(schema, versions, "test", defaults, env)
	if err != nil {
		t.Fatalf("eval error: %v", err)
	}

	if rc.Set != "test" {
		t.Errorf("Set = %q, want %q", rc.Set, "test")
	}

	// COMPUTED key = "app.{{.DOMAIN}}" where DOMAIN = "test.local"
	cv, ok := rc.Values["COMPUTED"]
	if !ok {
		t.Fatal("COMPUTED key not found")
	}
	if cv.Value != "app.test.local" {
		t.Errorf("COMPUTED = %q, want %q", cv.Value, "app.test.local")
	}
	if cv.Source != "const" {
		t.Errorf("COMPUTED source = %q, want %q", cv.Source, "const")
	}
}
