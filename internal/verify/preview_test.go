package verify

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// previewEnv returns the homelab-preview env or fails the test.
func previewEnv(t *testing.T) Env {
	t.Helper()
	env, ok := EnvByName("homelab-preview")
	if !ok {
		t.Fatal("homelab-preview env is not registered in Envs")
	}
	return env
}

func TestEnvRenders(t *testing.T) {
	tests := []struct {
		name  string
		env   Env
		chart string
		want  bool
	}{
		{name: "unrestricted env renders every chart", env: Env{Name: "homelab"}, chart: "addons", want: true},
		{name: "restricted env renders its chart", env: Env{Charts: []string{"applications"}}, chart: "applications", want: true},
		{name: "restricted env skips other charts", env: Env{Charts: []string{"applications"}}, chart: "gitops", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.env.Renders(tt.chart); got != tt.want {
				t.Errorf("Renders(%q) = %v, want %v", tt.chart, got, tt.want)
			}
		})
	}
}

func TestHomelabPreviewEnvShape(t *testing.T) {
	env := previewEnv(t)
	if !env.TwoStage || !env.Preview || env.ConfigSet != "homelab" || env.valuesName() != "homelab" {
		t.Errorf("homelab-preview must be the two-stage homelab render in preview mode, got %+v", env)
	}
	if env.EnvFile != "configuration/environments/homelab.yaml.example" {
		t.Errorf("homelab-preview must read the PII-free example, got %q", env.EnvFile)
	}
	if strings.Join(env.Charts, ",") != "applications" {
		t.Errorf("homelab-preview must render only the applications chart, got %v", env.Charts)
	}
}

func TestParseEnvsPreview(t *testing.T) {
	tests := []struct {
		name    string
		list    string
		want    []string
		wantErr string
	}{
		{name: "all includes the preview env", list: "all", want: []string{"localdev", "homelab", "homelab-preview"}},
		{name: "preview alone", list: "homelab-preview", want: []string{"homelab-preview"}},
		{name: "unknown env lists every name", list: "staging", wantErr: "want one of localdev, homelab, homelab-preview"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			envs, err := ParseEnvs(tt.list)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("ParseEnvs(%q) error = %v, want it to contain %q", tt.list, err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseEnvs(%q): %v", tt.list, err)
			}
			var got []string
			for _, e := range envs {
				got = append(got, e.Name)
			}
			if strings.Join(got, ",") != strings.Join(tt.want, ",") {
				t.Errorf("ParseEnvs(%q) = %v, want %v", tt.list, got, tt.want)
			}
		})
	}
}

func TestPreviewAllowedApps(t *testing.T) {
	tests := []struct {
		name    string
		values  string // "" = no file
		want    string
		wantErr string
	}{
		{name: "reads the list", values: "global:\n  preview:\n    allowedApps: [sonarr, radarr]\n", want: "sonarr,radarr"},
		{name: "missing list", values: "global:\n  preview: {}\n", wantErr: "sets no global.preview.allowedApps"},
		{name: "invalid yaml", values: "global: [\n", wantErr: "parsing charts/applications/values.yaml"},
		{name: "missing file", wantErr: "reading charts/applications/values.yaml"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			if tt.values != "" {
				dir := filepath.Join(root, "charts", "applications")
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "values.yaml"), []byte(tt.values), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			got, err := previewAllowedApps(root)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("error = %v, want it to contain %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(got, ",") != tt.want {
				t.Errorf("got %v, want %s", got, tt.want)
			}
		})
	}
}

// TestRenderPreviewEnv: homelab-preview renders only charts/applications,
// two-stage from homelab.yaml.example, with exactly the --set-string pair
// cmp/plugin.yaml passes, and the gitops parent inherit-only.
func TestRenderPreviewEnv(t *testing.T) {
	root := testRepoRoot(t)
	fr := &fakeRunner{}
	out, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       []Env{previewEnv(t)},
		Parallel:   2,
		SkipSchema: true,
		Runner:     fr,
	})
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}
	if got := strings.Join(sortedKeys(out.Files["homelab-preview"]), ","); got != "applications" {
		t.Errorf("rendered files = %q, want only applications", got)
	}
	for _, name := range []string{"render/homelab-preview/applications", "lint/homelab-preview/applications", "render/homelab-preview/_config", "render/homelab-preview/_inherit"} {
		if c := checkByName(t, res, name); c.Status != StatusPass {
			t.Errorf("%s: status %s (%s)", name, c.Status, c.Detail)
		}
	}
	for _, c := range res.Checks {
		if strings.HasPrefix(c.Name, "render/homelab-preview/") && !strings.HasPrefix(c.Name, "render/homelab-preview/_") && c.Name != "render/homelab-preview/applications" {
			t.Errorf("unexpected chart check %s: homelab-preview renders only applications", c.Name)
		}
		if c.Name == "render/homelab-preview/_committed-values" {
			t.Errorf("a two-stage env commits no values, so it must not get %s", c.Name)
		}
	}

	apps, err := previewAllowedApps(root)
	if err != nil {
		t.Fatal(err)
	}
	wantApps := "global.preview.apps=" + strings.Join(apps, `\,`)
	for _, verb := range []string{"template applications", "lint charts/applications"} {
		cmd, ok := fr.find("helm", verb, "--set-string global.preview.pr="+PreviewPR, "--set-string "+wantApps)
		if !ok {
			t.Fatalf("no `helm %s` with the preview --set-string pair (%s); recorded: %v", verb, wantApps, fr.cmds)
		}
		if !strings.Contains(cmd.line(), "_values/applications.yaml") {
			t.Errorf("helm %s must use the config-export values (two-stage): %s", verb, cmd.line())
		}
	}
	if c := checkByName(t, res, "render/homelab-preview/applications"); !strings.Contains(c.Detail, "--set-string global.preview.pr="+PreviewPR) {
		t.Errorf("render detail must disclose the preview arguments: %q", c.Detail)
	}

	gitops, ok := fr.find("helm", "template gitops")
	if !ok {
		t.Fatal("the gitops parent must render inherit-only for homelab-preview")
	}
	if strings.Contains(gitops.line(), "global.preview") {
		t.Errorf("preview arguments must not reach the inherit-only gitops parent: %s", gitops.line())
	}
	if !strings.Contains(gitops.line(), "charts/gitops/values-homelab.yaml") {
		t.Errorf("the inherit-only gitops parent must use values-homelab.yaml (ValuesEnv): %s", gitops.line())
	}
}

// TestRenderPreviewEnvOutsideChartFilter: a --chart selection without
// applications leaves homelab-preview with nothing to render, so it reports
// nothing instead of failing on an empty render.
func TestRenderPreviewEnvOutsideChartFilter(t *testing.T) {
	root := testRepoRoot(t)
	out, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       Envs,
		Charts:     []string{"tailscale-config"},
		Parallel:   2,
		SkipLint:   true,
		SkipSchema: true,
		Runner:     &fakeRunner{},
	})
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}
	if _, ok := out.Files["homelab-preview"]; ok {
		t.Error("homelab-preview must not render when the chart filter excludes applications")
	}
	for _, c := range res.Checks {
		if strings.Contains(c.Name, "homelab-preview") {
			t.Errorf("unexpected check %s", c.Name)
		}
	}
}

func TestLintGitOpsPreviewSkipsRepoSecrets(t *testing.T) {
	root := testRepoRoot(t)
	tests := []struct {
		env      string
		wantSkip bool
	}{
		{env: "homelab-preview", wantSkip: true},
		{env: "homelab", wantSkip: false},
	}
	for _, tt := range tests {
		t.Run(tt.env, func(t *testing.T) {
			checks := LintGitOps(tt.env, map[string][]Doc{}, nil, root)
			if len(checks) != len(GitOpsRules) {
				t.Fatalf("got %d checks, want one per rule (%d)", len(checks), len(GitOpsRules))
			}
			for _, c := range checks {
				isRepoSecrets := c.Name == "gitops/"+tt.env+"/repo-secrets"
				switch {
				case isRepoSecrets && tt.wantSkip:
					if c.Status != StatusSkip || !strings.HasPrefix(c.Detail, "provided by the homelab env") {
						t.Errorf("%s: got %s %q, want skip \"provided by the homelab env...\"", c.Name, c.Status, c.Detail)
					}
				case isRepoSecrets:
					if c.Status == StatusSkip {
						t.Errorf("%s must run for %s", c.Name, tt.env)
					}
				case c.Status == StatusSkip && strings.HasPrefix(c.Detail, "provided by"):
					t.Errorf("%s: only repo-secrets is skipped for %s", c.Name, tt.env)
				}
			}
		})
	}
}

func TestExpectedSnapshots(t *testing.T) {
	charts := []Chart{{Name: "addons"}, {Name: "applications"}, {Name: "gitops"}}
	got := ExpectedSnapshots(Envs, charts)
	want := map[string]string{
		"localdev":        "addons,applications,gitops",
		"homelab":         "addons,applications,gitops",
		"homelab-preview": "applications",
	}
	for env, charts := range want {
		if strings.Join(got[env], ",") != charts {
			t.Errorf("%s: got %v, want %s", env, got[env], charts)
		}
	}
}
