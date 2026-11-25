package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type nzbgetSchemaRunner struct{}

func (nzbgetSchemaRunner) LookPath(string) (string, error) { return "/fake/helm", nil }

func (nzbgetSchemaRunner) Run(_ context.Context, _ string, _ string, args ...string) ([]byte, []byte, error) {
	if !containsArg(args, "oci://oci.trueforge.org/truecharts/nzbget") || flagValue(args, "--version") != "32.0.0" {
		return nil, nil, fmt.Errorf("wrong chart or version: %v", args)
	}
	values, err := os.ReadFile(flagValue(args, "-f"))
	if err != nil {
		return nil, nil, err
	}
	if strings.Contains(string(values), "kubernetes.io/arch: null") {
		return nil, []byte("got null, want string"), fmt.Errorf("schema validation failed")
	}
	if !strings.Contains(string(values), "kubernetes.io/arch: \"\"") {
		return nil, nil, fmt.Errorf("missing localdev override")
	}
	return []byte("kind: Deployment\n"), nil, nil
}

func containsArg(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func TestLocaldevNZBGetSchemaUsesRenderedApplicationValues(t *testing.T) {
	for _, tc := range []struct {
		name, arch string
		want       Status
	}{
		{"valid", "\"\"", StatusPass},
		{"invalid", "null", StatusFail},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "applications.yaml")
			manifest := "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: nzbget\nspec:\n  destination:\n    namespace: media\n  source:\n    repoURL: oci://oci.trueforge.org/truecharts\n    chart: nzbget\n    targetRevision: 32.0.0\n    helm:\n      values: |\n        workload:\n          main:\n            podSpec:\n              nodeSelector:\n                kubernetes.io/arch: " + tc.arch + "\n"
			if err := os.WriteFile(path, []byte(manifest), 0o644); err != nil {
				t.Fatal(err)
			}
			check := LocaldevNZBGetSchema(context.Background(), nzbgetSchemaRunner{}, t.TempDir(), "1.34.0", map[string]string{"applications": path})
			if check.Status != tc.want {
				t.Fatalf("status %s, want %s: %s %v", check.Status, tc.want, check.Detail, check.Findings)
			}
		})
	}
}
