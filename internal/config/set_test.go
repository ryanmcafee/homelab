package config

import (
	"testing"
)

func TestLoadEnvironment(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
		wantN   int
	}{
		{
			name:    "valid environment loads",
			path:    testdataPath("environments", "defaults.yaml"),
			wantErr: false,
			wantN:   5,
		},
		{
			name:    "missing file returns error",
			path:    testdataPath("environments", "nonexistent.yaml"),
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env, err := LoadEnvironment(tt.path)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(env) != tt.wantN {
				t.Errorf("got %d values, want %d", len(env), tt.wantN)
			}
		})
	}
}

func TestResolveHierarchy(t *testing.T) {
	defaults, err := LoadEnvironment(testdataPath("environments", "defaults.yaml"))
	if err != nil {
		t.Fatalf("loading defaults: %v", err)
	}

	env, err := LoadEnvironment(testdataPath("environments", "test.yaml"))
	if err != nil {
		t.Fatalf("loading test env: %v", err)
	}

	merged := ResolveHierarchy(defaults, env)

	tests := []struct {
		key  string
		want string
		desc string
	}{
		{"DOMAIN", "test.local", "env overrides defaults"},
		{"BGP_K8S_ASN", "64512", "defaults preserved when not overridden"},
		{"IP_ADDR", "192.168.1.100", "env-only key present"},
		{"OPTIONAL_KEY", "from-defaults", "default preserved"},
	}

	for _, tt := range tests {
		t.Run(tt.desc, func(t *testing.T) {
			got, ok := merged[tt.key]
			if !ok {
				t.Fatalf("key %s not found in merged config", tt.key)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestLoadVersions(t *testing.T) {
	v, err := LoadVersions(testdataPath("versions.yaml"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v.Charts["argocd"] != "7.7.15" {
		t.Errorf("argocd version = %q, want %q", v.Charts["argocd"], "7.7.15")
	}
	if v.Tools["talos"] != "v1.12.2" {
		t.Errorf("talos version = %q, want %q", v.Tools["talos"], "v1.12.2")
	}
}
