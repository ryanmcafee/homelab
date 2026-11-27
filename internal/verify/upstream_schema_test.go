package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type trueChartsSchemaRunner struct{ rendered []string }

func (*trueChartsSchemaRunner) LookPath(string) (string, error) { return "/fake/helm", nil }

func (r *trueChartsSchemaRunner) Run(_ context.Context, _ string, _ string, args ...string) ([]byte, []byte, error) {
	values, err := os.ReadFile(flagValue(args, "-f"))
	if err != nil {
		return nil, nil, err
	}
	for _, arg := range args {
		if strings.HasPrefix(arg, "oci://oci.trueforge.org/truecharts/") {
			r.rendered = append(r.rendered, strings.TrimPrefix(arg, "oci://oci.trueforge.org/truecharts/")+"@"+flagValue(args, "--version"))
		}
	}
	if strings.Contains(string(values), "kubernetes.io/arch: null") {
		return nil, []byte("got null, want string"), fmt.Errorf("schema validation failed")
	}
	if !strings.Contains(string(values), "kubernetes.io/arch: \"\"") {
		return nil, nil, fmt.Errorf("missing localdev override")
	}
	return []byte("kind: Deployment\n"), nil, nil
}

func trueChartsApplication(name, repoURL, version, arch string) string {
	return "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: " + name +
		"\nspec:\n  destination:\n    namespace: media\n  source:\n    repoURL: " + repoURL +
		"\n    chart: " + name + "\n    targetRevision: " + version +
		"\n    helm:\n      values: |\n        workload:\n          main:\n            podSpec:\n              nodeSelector:\n                kubernetes.io/arch: " + arch + "\n"
}

func TestLocaldevTrueChartsSchemaRendersEveryTrueChartsApplication(t *testing.T) {
	for _, tc := range []struct {
		name, sonarrArch string
		want             map[string]Status
	}{
		{"all valid", "\"\"", map[string]Status{"nzbget": StatusPass, "sonarr": StatusPass}},
		{"null fails only its own app", "null", map[string]Status{"nzbget": StatusPass, "sonarr": StatusFail}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "applications.yaml")
			manifest := trueChartsApplication("nzbget", "oci://oci.trueforge.org/truecharts", "32.0.0", "\"\"") +
				"---\n" + trueChartsApplication("sonarr", "oci.trueforge.org/truecharts", "29.0.1", tc.sonarrArch) +
				"---\n" + trueChartsApplication("plex", "https://raw.githubusercontent.com/plexinc/pms-docker/gh-pages", "1.9.0", "null")
			if err := os.WriteFile(path, []byte(manifest), 0o644); err != nil {
				t.Fatal(err)
			}
			runner := &trueChartsSchemaRunner{}
			checks := LocaldevTrueChartsSchema(context.Background(), runner, t.TempDir(), "1.34.0", map[string]string{"applications": path})
			got := map[string]Status{}
			for _, c := range checks {
				got[strings.TrimSuffix(strings.TrimPrefix(c.Name, "upstream/localdev/"), "-schema")] = c.Status
			}
			if len(got) != len(tc.want) {
				t.Fatalf("checks %v, want %v", got, tc.want)
			}
			for app, want := range tc.want {
				if got[app] != want {
					t.Errorf("%s: status %s, want %s", app, got[app], want)
				}
			}
			if strings.Join(runner.rendered, ",") != "nzbget@32.0.0,sonarr@29.0.1" {
				t.Errorf("rendered %v, want the two TrueCharts sources only", runner.rendered)
			}
		})
	}
}

func TestLocaldevTrueChartsSchemaFailsWithoutTrueChartsSources(t *testing.T) {
	path := filepath.Join(t.TempDir(), "applications.yaml")
	if err := os.WriteFile(path, []byte(trueChartsApplication("plex", "https://example.invalid/charts", "1.0.0", "null")), 0o644); err != nil {
		t.Fatal(err)
	}
	checks := LocaldevTrueChartsSchema(context.Background(), &trueChartsSchemaRunner{}, t.TempDir(), "1.34.0", map[string]string{"applications": path})
	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("checks %+v, want one failure", checks)
	}
}
