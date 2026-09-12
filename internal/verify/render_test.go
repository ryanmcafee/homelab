package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeCmd is one recorded invocation.
type fakeCmd struct {
	Dir  string
	Name string
	Args []string
}

func (c fakeCmd) line() string { return c.Name + " " + strings.Join(c.Args, " ") }

// fakeRunner implements Runner without touching the filesystem or network.
type fakeRunner struct {
	mu   sync.Mutex
	cmds []fakeCmd

	// missing makes LookPath fail for the named binaries.
	missing map[string]bool
	// failRelease makes `helm template <failRelease> ...` exit non-zero.
	failRelease string
	// lintOutput overrides the canned `helm lint` stdout.
	lintOutput string
	// kubeconformOutput overrides the canned kubeconform stdout.
	kubeconformOutput string
	// plutoOutput overrides the canned pluto stdout.
	plutoOutput string
}

func (f *fakeRunner) LookPath(name string) (string, error) {
	if f.missing[name] {
		return "", fmt.Errorf("exec: %q: executable file not found in $PATH", name)
	}
	return "/fake/bin/" + name, nil
}

func (f *fakeRunner) Run(_ context.Context, dir, name string, args ...string) ([]byte, []byte, error) {
	f.mu.Lock()
	f.cmds = append(f.cmds, fakeCmd{Dir: dir, Name: name, Args: append([]string(nil), args...)})
	f.mu.Unlock()

	switch {
	case name == "helm" && len(args) > 1 && args[0] == "template":
		release := args[1]
		if release == f.failRelease {
			return nil, []byte("Error: template: " + release + "/templates/app.yaml:3:12: nil pointer evaluating interface {}.repoURL"), fmt.Errorf("exit status 1")
		}
		return []byte(cannedManifest(release)), nil, nil
	case name == "helm" && len(args) > 1 && args[0] == "lint":
		out := f.lintOutput
		if out == "" {
			out = "==> Linting " + args[1] + "\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed\n"
		}
		return []byte(out), nil, nil
	case name == "kubeconform":
		out := f.kubeconformOutput
		if out == "" {
			out = `{"resources":[],"summary":{"valid":2,"invalid":0,"errors":0,"skipped":0}}`
		}
		return []byte(out), nil, nil
	case name == "pluto":
		out := f.plutoOutput
		if out == "" {
			out = `{"items":[]}`
		}
		return []byte(out), nil, nil
	}
	return nil, nil, fmt.Errorf("fakeRunner: unexpected command %s %v", name, args)
}

// find returns the first recorded command whose rendered line contains every substring.
func (f *fakeRunner) find(name string, contains ...string) (fakeCmd, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
outer:
	for _, c := range f.cmds {
		if c.Name != name {
			continue
		}
		line := c.line()
		for _, want := range contains {
			if !strings.Contains(line, want) {
				continue outer
			}
		}
		return c, true
	}
	return fakeCmd{}, false
}

func cannedManifest(release string) string {
	return "---\n" +
		"apiVersion: v1\n" +
		"kind: ConfigMap\n" +
		"metadata:\n" +
		"  name: " + release + "\n" +
		"  namespace: default\n" +
		"data:\n" +
		"  release: " + release + "\n"
}

// testRepoRoot locates the worktree root from the package directory.
func testRepoRoot(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	root, err := FindRepoRoot(wd)
	if err != nil {
		t.Fatalf("FindRepoRoot: %v", err)
	}
	return root
}

// checkByName finds a check in a result.
func checkByName(t *testing.T, res *Result, name string) Check {
	t.Helper()
	for _, c := range res.Checks {
		if c.Name == name {
			return c
		}
	}
	var names []string
	for _, c := range res.Checks {
		names = append(names, c.Name)
	}
	t.Fatalf("check %q not found; have %v", name, names)
	return Check{}
}

func TestRenderValuesArgsPerEnv(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	fr := &fakeRunner{}

	out, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     outDir,
		Envs:       Envs,
		Charts:     []string{"addons", "tailscale-config"},
		Parallel:   2,
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if out == nil {
		t.Fatal("Render returned nil output")
	}
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}

	generated := filepath.Join(outDir, "homelab", "_values", "addons.yaml")

	tests := []struct {
		name        string
		release     string
		env         string
		wantArgs    string
		wantDetail  string
		notWantArgs string
	}{
		{
			name:     "addons homelab uses two-stage generated values",
			release:  "addons",
			env:      "homelab",
			wantArgs: "-f charts/addons/values.yaml -f " + generated,
		},
		{
			name:        "addons localdev uses committed env values",
			release:     "addons",
			env:         "localdev",
			wantArgs:    "-f charts/addons/values.yaml -f charts/addons/values-localdev.yaml",
			notWantArgs: "_values",
		},
		{
			name:     "child chart homelab uses values-homelab.yaml",
			release:  "tailscale-config",
			env:      "homelab",
			wantArgs: "-f charts/tailscale-config/values.yaml -f charts/tailscale-config/values-homelab.yaml",
		},
		{
			name:       "child chart localdev falls back to values.yaml only",
			release:    "tailscale-config",
			env:        "localdev",
			wantArgs:   "-f charts/tailscale-config/values.yaml",
			wantDetail: "values-localdev.yaml missing",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			marker := filepath.Join(outDir, tc.env)
			_ = marker
			check := checkByName(t, res, "render/"+tc.env+"/"+tc.release)
			if check.Status != StatusPass {
				t.Fatalf("check %s: status %s (%s)", check.Name, check.Status, check.Detail)
			}
			// Locate the helm template invocation for this (env, chart) pair by
			// matching the output file argument recorded in the check detail.
			cmd, ok := fr.find("helm", "template "+tc.release+" ", tc.wantArgs)
			if !ok {
				t.Fatalf("no helm template for %s/%s containing %q; recorded:\n%s",
					tc.env, tc.release, tc.wantArgs, fr.dump())
			}
			if !strings.Contains(cmd.line(), "--include-crds") {
				t.Errorf("helm template missing --include-crds: %s", cmd.line())
			}
			if tc.notWantArgs != "" && strings.Contains(cmd.line(), tc.notWantArgs) {
				t.Errorf("helm template should not contain %q: %s", tc.notWantArgs, cmd.line())
			}
			if tc.wantDetail != "" && !strings.Contains(check.Detail, tc.wantDetail) {
				t.Errorf("check %s detail %q does not mention %q", check.Name, check.Detail, tc.wantDetail)
			}
		})
	}

	// The localdev child chart must not receive a values-localdev.yaml flag.
	if cmd, ok := fr.find("helm", "template tailscale-config ", "values-localdev.yaml"); ok {
		t.Errorf("localdev child chart got a non-existent values file: %s", cmd.line())
	}
}

func (f *fakeRunner) dump() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var b strings.Builder
	for _, c := range f.cmds {
		b.WriteString("  " + c.line() + "\n")
	}
	return b.String()
}

func TestRenderWritesFilesAndData(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	fr := &fakeRunner{}

	out, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     outDir,
		Envs:       Envs,
		Charts:     []string{"addons"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}

	rendered := RenderedFile(out.Dir, "homelab", "addons")
	data, err := os.ReadFile(rendered)
	if err != nil {
		t.Fatalf("rendered file %s: %v", rendered, err)
	}
	if !strings.Contains(string(data), "kind: ConfigMap") {
		t.Errorf("rendered file does not contain the helm output: %q", string(data))
	}
	if got := out.Files["homelab"]["addons"]; got != rendered {
		t.Errorf("Files[homelab][addons] = %q, want %q", got, rendered)
	}

	dataFile := filepath.Join(out.Dir, "homelab", "_data.yaml")
	raw, err := os.ReadFile(dataFile)
	if err != nil {
		t.Fatalf("_data.yaml: %v", err)
	}
	for _, want := range []string{"env: homelab", "domain: your-domain.com", "kubernetes_version: "} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("_data.yaml missing %q; got:\n%s", want, string(raw))
		}
	}

	localRaw, err := os.ReadFile(filepath.Join(out.Dir, "localdev", "_data.yaml"))
	if err != nil {
		t.Fatalf("localdev _data.yaml: %v", err)
	}
	if !strings.Contains(string(localRaw), "domain: homelab.local") {
		t.Errorf("localdev _data.yaml missing localdev domain; got:\n%s", string(localRaw))
	}
}

func TestRenderReportsHelmFailure(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	fr := &fakeRunner{failRelease: "addons"}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     outDir,
		Envs:       Envs,
		Charts:     []string{"addons", "tailscale-config"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if res.Pass {
		t.Fatal("expected Result.Pass == false when a chart fails to render")
	}

	for _, env := range []string{"localdev", "homelab"} {
		failed := checkByName(t, res, "render/"+env+"/addons")
		if failed.Status != StatusFail {
			t.Errorf("render/%s/addons: status %s, want fail", env, failed.Status)
		}
		if len(failed.Findings) == 0 || !strings.Contains(strings.Join(failed.Findings, "\n"), "nil pointer evaluating") {
			t.Errorf("render/%s/addons findings do not carry helm stderr: %v", env, failed.Findings)
		}
		ok := checkByName(t, res, "render/"+env+"/tailscale-config")
		if ok.Status != StatusPass {
			t.Errorf("render/%s/tailscale-config: status %s, want pass", env, ok.Status)
		}
	}
}

func TestKubeconformArgsUseVersionsYaml(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	schemaDir := t.TempDir()
	cacheDir := filepath.Join(t.TempDir(), "kubeconform")
	fr := &fakeRunner{}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:  root,
		OutDir:    outDir,
		Envs:      []Env{Envs[0]},
		Charts:    []string{"addons"},
		SkipLint:  true,
		SchemaDir: schemaDir,
		CacheDir:  cacheDir,
		Runner:    fr,
	})

	cmd, ok := fr.find("kubeconform")
	if !ok {
		t.Fatalf("kubeconform was never invoked; recorded:\n%s", fr.dump())
	}
	line := cmd.line()
	wants := []string{
		"-kubernetes-version 1.36.1",
		"-strict",
		"-summary",
		"-output json",
		"-cache " + cacheDir,
		"-schema-location default",
		"-schema-location " + filepath.Join(schemaDir, "{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json"),
	}
	for _, want := range wants {
		if !strings.Contains(line, want) {
			t.Errorf("kubeconform args missing %q:\n%s", want, line)
		}
	}
	if strings.Contains(line, "-skip") {
		t.Errorf("kubeconform args must never contain -skip:\n%s", line)
	}
	if !strings.Contains(line, RenderedFile(outDir, "localdev", "addons")) {
		t.Errorf("kubeconform args missing the rendered file:\n%s", line)
	}
	if c := checkByName(t, res, "kubeconform/localdev"); c.Status != StatusPass {
		t.Errorf("kubeconform/localdev: status %s (%s)", c.Status, c.Detail)
	}

	plutoCmd, ok := fr.find("pluto")
	if !ok {
		t.Fatalf("pluto was never invoked; recorded:\n%s", fr.dump())
	}
	for _, want := range []string{"detect-files", "-d " + filepath.Join(outDir, "localdev"), "--target-versions k8s=v1.36.1", "-o json"} {
		if !strings.Contains(plutoCmd.line(), want) {
			t.Errorf("pluto args missing %q:\n%s", want, plutoCmd.line())
		}
	}
}

func TestKubeconformReportsInvalidResources(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	fr := &fakeRunner{kubeconformOutput: `{"resources":[
		{"filename":"/x/addons.yaml","kind":"Application","name":"cert-manager","version":"argoproj.io/v1alpha1","status":"statusError","msg":"could not find schema for Application"},
		{"filename":"/x/addons.yaml","kind":"ConfigMap","name":"ok","version":"v1","status":"statusValid","msg":""}
	],"summary":{"valid":1,"invalid":0,"errors":1,"skipped":0}}`}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot: root,
		OutDir:   outDir,
		Envs:     []Env{Envs[0]},
		Charts:   []string{"addons"},
		SkipLint: true,
		Runner:   fr,
	})
	if res.Pass {
		t.Fatal("expected failure when kubeconform reports statusError")
	}
	c := checkByName(t, res, "kubeconform/localdev")
	if c.Status != StatusFail {
		t.Fatalf("kubeconform/localdev: status %s, want fail", c.Status)
	}
	joined := strings.Join(c.Findings, "\n")
	if !strings.Contains(joined, "Application/cert-manager") || !strings.Contains(joined, "could not find schema") {
		t.Errorf("findings missing the invalid resource: %v", c.Findings)
	}
	if strings.Contains(joined, "ConfigMap/ok") {
		t.Errorf("valid resources must not appear in findings: %v", c.Findings)
	}
}

func TestPlutoReportsDeprecatedAPIs(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	fr := &fakeRunner{plutoOutput: `{"items":[
		{"name":"legacy","namespace":"default","filePath":"/x/addons.yaml","api":{"version":"extensions/v1beta1","kind":"Ingress","deprecated-in":"v1.14.0","removed-in":"v1.22.0","replacement-api":"networking.k8s.io/v1"},"deprecated":true,"removed":true}
	]}`}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot: root,
		OutDir:   outDir,
		Envs:     []Env{Envs[0]},
		Charts:   []string{"addons"},
		SkipLint: true,
		Runner:   fr,
	})
	if res.Pass {
		t.Fatal("expected failure when pluto reports a removed API")
	}
	c := checkByName(t, res, "pluto/localdev")
	if c.Status != StatusFail {
		t.Fatalf("pluto/localdev: status %s, want fail", c.Status)
	}
	joined := strings.Join(c.Findings, "\n")
	for _, want := range []string{"extensions/v1beta1", "Ingress", "networking.k8s.io/v1"} {
		if !strings.Contains(joined, want) {
			t.Errorf("pluto findings missing %q: %v", want, c.Findings)
		}
	}
}

func TestMissingToolIsFailure(t *testing.T) {
	root := testRepoRoot(t)

	tests := []struct {
		name      string
		missing   string
		wantCheck string
	}{
		{name: "kubeconform missing", missing: "kubeconform", wantCheck: "kubeconform/localdev"},
		{name: "pluto missing", missing: "pluto", wantCheck: "pluto/localdev"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fr := &fakeRunner{missing: map[string]bool{tc.missing: true}}
			_, res := Render(context.Background(), RenderOptions{
				RepoRoot: root,
				OutDir:   t.TempDir(),
				Envs:     []Env{Envs[0]},
				Charts:   []string{"addons"},
				SkipLint: true,
				Runner:   fr,
			})
			if res.Pass {
				t.Fatalf("expected failure when %s is missing", tc.missing)
			}
			c := checkByName(t, res, tc.wantCheck)
			if c.Status != StatusFail {
				t.Fatalf("%s: status %s, want fail", tc.wantCheck, c.Status)
			}
			if !strings.Contains(c.Detail, tc.missing) || !strings.Contains(c.Detail, "mise install") {
				t.Errorf("%s detail must name the tool and the install hint: %q", tc.wantCheck, c.Detail)
			}
		})
	}

	t.Run("helm missing fails fast", func(t *testing.T) {
		fr := &fakeRunner{missing: map[string]bool{"helm": true}}
		_, res := Render(context.Background(), RenderOptions{
			RepoRoot: root,
			OutDir:   t.TempDir(),
			Envs:     Envs,
			Charts:   []string{"addons"},
			Runner:   fr,
		})
		if res.Pass {
			t.Fatal("expected failure when helm is missing")
		}
		c := checkByName(t, res, "render/helm")
		if c.Status != StatusFail || !strings.Contains(c.Detail, "mise install") {
			t.Errorf("render/helm: status %s detail %q", c.Status, c.Detail)
		}
		if _, ok := fr.find("helm", "template"); ok {
			t.Error("helm template must not run when helm is missing")
		}
	})
}

func TestRenderSkipSchemaEmitsSkipChecks(t *testing.T) {
	root := testRepoRoot(t)
	fr := &fakeRunner{}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       []Env{Envs[0]},
		Charts:     []string{"addons"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if !res.Pass {
		t.Fatal("skipping schema checks must not fail the result")
	}
	for _, name := range []string{"kubeconform/localdev", "pluto/localdev"} {
		if c := checkByName(t, res, name); c.Status != StatusSkip {
			t.Errorf("%s: status %s, want skip", name, c.Status)
		}
	}
	if _, ok := fr.find("kubeconform"); ok {
		t.Error("kubeconform must not run with SkipSchema")
	}
}

func TestRenderLintFailsOnErrorLines(t *testing.T) {
	root := testRepoRoot(t)
	fr := &fakeRunner{lintOutput: "==> Linting charts/addons\n[WARNING] templates/: directory not found\n[ERROR] templates/app.yaml: unable to parse YAML\n\nError: 1 chart(s) linted, 1 chart(s) failed\n"}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       []Env{Envs[0]},
		Charts:     []string{"addons"},
		SkipSchema: true,
		Runner:     fr,
	})
	if res.Pass {
		t.Fatal("expected failure when helm lint reports [ERROR]")
	}
	c := checkByName(t, res, "lint/localdev/addons")
	if c.Status != StatusFail {
		t.Fatalf("lint/localdev/addons: status %s, want fail", c.Status)
	}
	joined := strings.Join(c.Findings, "\n")
	if !strings.Contains(joined, "unable to parse YAML") {
		t.Errorf("lint findings missing the error line: %v", c.Findings)
	}
	if strings.Contains(joined, "[WARNING]") {
		t.Errorf("warnings must not be reported as findings: %v", c.Findings)
	}
}

func TestRenderLintPassesOnWarnings(t *testing.T) {
	root := testRepoRoot(t)
	fr := &fakeRunner{lintOutput: "==> Linting charts/addons\n[WARNING] templates/: directory not found\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed\n"}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       []Env{Envs[0]},
		Charts:     []string{"addons"},
		SkipSchema: true,
		Runner:     fr,
	})
	if c := checkByName(t, res, "lint/localdev/addons"); c.Status != StatusPass {
		t.Errorf("lint/localdev/addons: status %s (%s), want pass", c.Status, c.Detail)
	}
	if !res.Pass {
		t.Error("helm lint warnings must not fail the result")
	}
}

func TestRenderUnknownChartFilterIsUsageError(t *testing.T) {
	root := testRepoRoot(t)
	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       []Env{Envs[0]},
		Charts:     []string{"does-not-exist"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     &fakeRunner{},
	})
	if res.Pass {
		t.Fatal("expected failure for an unknown --chart filter")
	}
	c := checkByName(t, res, "render/setup")
	if !strings.Contains(c.Detail, "does-not-exist") {
		t.Errorf("render/setup detail should name the unknown chart: %q", c.Detail)
	}
}

func TestRenderAllChartsForBothEnvs(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	fr := &fakeRunner{}

	out, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     outDir,
		Envs:       Envs,
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}
	if len(out.Charts) < 20 {
		t.Fatalf("expected the repo's chart set, got %d", len(out.Charts))
	}
	for _, env := range Envs {
		if len(out.Files[env.Name]) != len(out.Charts) {
			t.Errorf("env %s: rendered %d files, want %d", env.Name, len(out.Files[env.Name]), len(out.Charts))
		}
	}
	for _, c := range out.Charts {
		for _, env := range Envs {
			got := checkByName(t, res, "render/"+env.Name+"/"+c.Name)
			if got.Status != StatusPass {
				t.Errorf("render/%s/%s: status %s", env.Name, c.Name, got.Status)
			}
		}
	}
}
