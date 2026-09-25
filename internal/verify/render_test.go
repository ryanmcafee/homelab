package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ryanmcafee/homelab/internal/config"
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
	// plutoStderr, when set, makes pluto exit non-zero with this stderr.
	plutoStderr string
	// lintErr, when set, makes `helm lint` exit non-zero with this stderr.
	lintErr string
	// templateStderr, when set, makes `helm template` exit non-zero with this stderr.
	templateStderr string
	// kubeconformStderr, when set, makes kubeconform exit non-zero with this stderr.
	kubeconformStderr string
	// manifests overrides the canned `helm template <release>` stdout per
	// release, so a parent can emit Applications for inheritance tests.
	manifests map[string]string

	// inFlight and maxInFlight record observed concurrency so tests can assert
	// that --parallel actually bounds the worker pool.
	inFlight    int
	maxInFlight int
}

// enter records the start of a concurrent invocation and blocks briefly so
// overlapping calls are actually observable.
func (f *fakeRunner) enter() {
	f.mu.Lock()
	f.inFlight++
	if f.inFlight > f.maxInFlight {
		f.maxInFlight = f.inFlight
	}
	f.mu.Unlock()
	time.Sleep(time.Millisecond)
	f.mu.Lock()
	f.inFlight--
	f.mu.Unlock()
}

// peakConcurrency reports the highest number of simultaneous invocations.
func (f *fakeRunner) peakConcurrency() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maxInFlight
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
	f.enter()

	switch {
	case name == "helm" && len(args) > 1 && args[0] == "template":
		release := args[1]
		if f.templateStderr != "" {
			return nil, []byte(f.templateStderr), fmt.Errorf("exit status 1")
		}
		if release == f.failRelease {
			return nil, []byte("Error: template: " + release + "/templates/app.yaml:3:12: nil pointer evaluating interface {}.repoURL"), fmt.Errorf("exit status 1")
		}
		if m, ok := f.manifests[release]; ok {
			return []byte(m), nil, nil
		}
		return []byte(cannedManifest(release)), nil, nil
	case name == "helm" && len(args) > 1 && args[0] == "lint":
		if f.lintErr != "" {
			return []byte(f.lintOutput), []byte(f.lintErr), fmt.Errorf("exit status 1")
		}
		out := f.lintOutput
		if out == "" {
			out = "==> Linting " + args[1] + "\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed\n"
		}
		return []byte(out), nil, nil
	case name == "kubeconform":
		if f.kubeconformStderr != "" {
			return nil, []byte(f.kubeconformStderr), fmt.Errorf("exit status 1")
		}
		out := f.kubeconformOutput
		if out == "" {
			out = `{"resources":[],"summary":{"valid":2,"invalid":0,"errors":0,"skipped":0}}`
		}
		return []byte(out), nil, nil
	case name == "pluto":
		if f.plutoStderr != "" {
			return nil, []byte(f.plutoStderr), fmt.Errorf("exit status 1")
		}
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

// applicationManifest fabricates an ArgoCD Application that deploys chartPath
// and hands it valuesObject (a YAML mapping body, already indented by 8).
// An empty valuesObject omits the helm block entirely.
func applicationManifest(appName, chartPath, valuesObject string) string {
	m := "---\n" +
		"apiVersion: argoproj.io/v1alpha1\n" +
		"kind: Application\n" +
		"metadata:\n" +
		"  name: " + appName + "\n" +
		"  namespace: argocd\n" +
		"spec:\n" +
		"  project: default\n" +
		"  source:\n" +
		"    repoURL: https://github.com/example/homelab.git\n" +
		"    path: " + chartPath + "\n"
	if valuesObject != "" {
		m += "    helm:\n" +
			"      valuesObject:\n" + valuesObject
	}
	return m
}

// tailscaleValuesObject is the valuesObject body the tests hand to
// tailscale-config, and tailscaleInherited its deterministic yaml.v3 form.
const (
	tailscaleValuesObject = "        tailscale:\n          hostname: ts.example.com\n"
	tailscaleInherited    = "tailscale:\n    hostname: ts.example.com\n"
)

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
	// The addons parent deploys tailscale-config and hands it values through
	// helm.valuesObject, exactly as charts/addons does after #262.
	fr := &fakeRunner{manifests: map[string]string{
		"addons": cannedManifest("addons") + applicationManifest("tailscale", "charts/tailscale-config", tailscaleValuesObject),
	}}

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
			name:    "child chart homelab uses values-homelab.yaml then the inherited values",
			release: "tailscale-config",
			env:     "homelab",
			wantArgs: "-f charts/tailscale-config/values.yaml -f charts/tailscale-config/values-homelab.yaml -f " +
				filepath.Join(outDir, "homelab", "_inherited", "tailscale-config.yaml"),
			wantDetail: "homelab/_inherited/tailscale-config.yaml (inherited from parent Application helm.valuesObject)",
		},
		{
			name:     "child chart localdev falls back to values.yaml then the inherited values",
			release:  "tailscale-config",
			env:      "localdev",
			wantArgs: "-f charts/tailscale-config/values.yaml -f " + filepath.Join(outDir, "localdev", "_inherited", "tailscale-config.yaml"),
			// The inherited file is a values source and sits before the
			// "missing" note, not after it.
			wantDetail: "values: charts/tailscale-config/values.yaml, localdev/_inherited/tailscale-config.yaml (inherited from parent Application helm.valuesObject); values-localdev.yaml missing",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
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

	// The inherited file holds exactly the valuesObject, marshalled
	// deterministically, and the per-env check accounts for it.
	for _, env := range Envs {
		// homelab-preview renders only charts/applications, so it never
		// inherits values for an addons child.
		if !env.Renders("tailscale-config") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(outDir, env.Name, "_inherited", "tailscale-config.yaml"))
		if err != nil {
			t.Fatalf("%s inherited file: %v", env.Name, err)
		}
		if string(raw) != tailscaleInherited {
			t.Errorf("%s inherited file = %q, want %q", env.Name, raw, tailscaleInherited)
		}
		c := checkByName(t, res, "render/"+env.Name+"/_inherit")
		if c.Status != StatusPass || c.Detail != "values inherited from parent Applications: 1" {
			t.Errorf("render/%s/_inherit: status %s detail %q", env.Name, c.Status, c.Detail)
		}
	}
	// addons itself is deployed by gitops, whose Applications carry no
	// valuesObject in the fake, so it inherits nothing.
	if cmd, ok := fr.find("helm", "template addons ", "_inherited"); ok {
		t.Errorf("addons must not receive an inherited values file: %s", cmd.line())
	}
}

func TestRenderInheritedValuesConflict(t *testing.T) {
	root := testRepoRoot(t)
	other := "        tailscale:\n          hostname: other.example.com\n"

	tests := []struct {
		name       string
		apps       string // applications parent output
		wantStatus Status
		wantDetail string
	}{
		{
			name:       "two Applications handing the same chart different values fail",
			apps:       cannedManifest("applications") + applicationManifest("tailscale-again", "charts/tailscale-config", other),
			wantStatus: StatusFail,
			wantDetail: "values inherited from parent Applications: 1; 1 problem(s)",
		},
		{
			name:       "two Applications handing the same chart identical values pass",
			apps:       cannedManifest("applications") + applicationManifest("tailscale-again", "charts/tailscale-config", tailscaleValuesObject),
			wantStatus: StatusPass,
			wantDetail: "values inherited from parent Applications: 1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fr := &fakeRunner{manifests: map[string]string{
				"addons":       cannedManifest("addons") + applicationManifest("tailscale", "charts/tailscale-config", tailscaleValuesObject),
				"applications": tc.apps,
			}}
			_, res := Render(context.Background(), RenderOptions{
				RepoRoot:   root,
				OutDir:     t.TempDir(),
				Envs:       []Env{Envs[1]},
				Charts:     []string{"addons", "applications", "tailscale-config"},
				SkipLint:   true,
				SkipSchema: true,
				Runner:     fr,
			})
			c := checkByName(t, res, "render/homelab/_inherit")
			if c.Status != tc.wantStatus {
				t.Fatalf("render/homelab/_inherit: status %s (%s), want %s", c.Status, c.Detail, tc.wantStatus)
			}
			if c.Detail != tc.wantDetail {
				t.Errorf("detail = %q, want %q", c.Detail, tc.wantDetail)
			}
			if tc.wantStatus == StatusPass {
				if res.Pass != true {
					t.Error("identical values from two Applications must not fail the result")
				}
				return
			}
			if res.Pass {
				t.Error("a valuesObject conflict must fail the result")
			}
			joined := strings.Join(c.Findings, "\n")
			// The finding names the chart and both producers so the ambiguity
			// can be resolved without re-rendering.
			for _, want := range []string{"tailscale-config", "Application tailscale (addons)", "Application tailscale-again (applications)", "differs from"} {
				if !strings.Contains(joined, want) {
					t.Errorf("findings missing %q: %v", want, c.Findings)
				}
			}
		})
	}
}

func TestRenderGitopsDomainMirrorsTerraform(t *testing.T) {
	root := testRepoRoot(t)
	fr := &fakeRunner{}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       Envs,
		Charts:     []string{"gitops"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}

	// homelab: the Terraform root Application sets global.domain as a helm
	// parameter, so the two-stage env injects the example domain the same way.
	const set = "--set global.domain=REPLACEME-domain.com"
	cmd, ok := fr.find("helm", "template gitops ", set)
	if !ok {
		t.Fatalf("no homelab helm template gitops with %q; recorded:\n%s", set, fr.dump())
	}
	if !strings.HasSuffix(cmd.line(), set) {
		t.Errorf("--set must come after the values files: %s", cmd.line())
	}
	c := checkByName(t, res, "render/homelab/gitops")
	wantDetail := "values: charts/gitops/values.yaml, charts/gitops/values-homelab.yaml; " + set + " (mirrors the Terraform root Application helm.parameters)"
	if c.Detail != wantDetail {
		t.Errorf("render/homelab/gitops detail = %q, want %q", c.Detail, wantDetail)
	}

	// localdev renders in plain-Helm mode and reads its domain from
	// values-localdev.yaml, so nothing is injected.
	if cmd, ok := fr.find("helm", "template gitops ", "values-localdev.yaml", "--set"); ok {
		t.Errorf("localdev gitops must not receive --set: %s", cmd.line())
	}
	if c := checkByName(t, res, "render/localdev/gitops"); strings.Contains(c.Detail, "--set") {
		t.Errorf("render/localdev/gitops detail must not mention --set: %q", c.Detail)
	}
	// No --chart-filter parent is needed on gitops' behalf.
	if cmd, ok := fr.find("helm", "template addons "); ok {
		t.Errorf("gitops alone must not trigger an inherit-only addons render: %s", cmd.line())
	}
}

func TestRenderInheritOnlyParentsUnderChartFilter(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	fr := &fakeRunner{manifests: map[string]string{
		"addons": cannedManifest("addons") + applicationManifest("tailscale", "charts/tailscale-config", tailscaleValuesObject),
	}}

	out, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     outDir,
		Envs:       []Env{Envs[1]},
		Charts:     []string{"tailscale-config"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}

	// Both child-deploying parents render inherit-only, and so does gitops,
	// which may hand them values; bootstrap never deploys a chart from here.
	for _, parent := range []string{"gitops", "addons", "applications"} {
		if _, ok := fr.find("helm", "template "+parent+" "); !ok {
			t.Errorf("%s was not rendered for inheritance; recorded:\n%s", parent, fr.dump())
		}
		if _, err := os.Stat(filepath.Join(outDir, "homelab", "_parents", parent+".yaml")); err != nil {
			t.Errorf("inherit-only output for %s missing: %v", parent, err)
		}
		if _, err := os.Stat(RenderedFile(outDir, "homelab", parent)); err == nil {
			t.Errorf("inherit-only %s must not land next to the selected renders", parent)
		}
		if _, ok := out.Files["homelab"][parent]; ok {
			t.Errorf("inherit-only %s must not appear in RenderOutput.Files", parent)
		}
		for _, c := range res.Checks {
			if strings.HasSuffix(c.Name, "/"+parent) {
				t.Errorf("inherit-only %s must not produce a check, got %s", parent, c.Name)
			}
		}
	}
	if cmd, ok := fr.find("helm", "template bootstrap "); ok {
		t.Errorf("bootstrap is not needed for a child-only selection: %s", cmd.line())
	}
	if len(out.Charts) != 1 || out.Charts[0].Name != "tailscale-config" {
		t.Errorf("RenderOutput.Charts = %v, want only tailscale-config", out.Charts)
	}

	// The selected child still receives the values its parent hands down.
	inherited := filepath.Join(outDir, "homelab", "_inherited", "tailscale-config.yaml")
	if _, ok := fr.find("helm", "template tailscale-config ", "-f "+inherited); !ok {
		t.Errorf("tailscale-config did not receive the inherited values; recorded:\n%s", fr.dump())
	}
	if c := checkByName(t, res, "render/homelab/_inherit"); c.Detail != "values inherited from parent Applications: 1" {
		t.Errorf("render/homelab/_inherit detail = %q", c.Detail)
	}

	// Parents render before children: every parent invocation precedes the
	// child's, or the child could not have seen the extracted values.
	childIdx, parentIdx := -1, -1
	for i, c := range fr.cmds {
		line := c.line()
		switch {
		case strings.HasPrefix(line, "helm template tailscale-config "):
			childIdx = i
		case strings.HasPrefix(line, "helm template addons ") || strings.HasPrefix(line, "helm template applications "):
			if i > parentIdx {
				parentIdx = i
			}
		}
	}
	if childIdx < 0 || parentIdx < 0 || parentIdx > childIdx {
		t.Errorf("parents must render before children (last parent at %d, child at %d):\n%s", parentIdx, childIdx, fr.dump())
	}
}

func TestRenderInheritOnlyParentsChainThroughGitops(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	// gitops hands addons a value and addons hands tailscale-config one. With
	// only the child selected, addons must still render with what gitops gave
	// it, or the child inherits values computed from the wrong inputs.
	addonsValues := "        global:\n          domain: example.com\n"
	fr := &fakeRunner{manifests: map[string]string{
		"gitops": cannedManifest("gitops") + applicationManifest("addons", "charts/addons", addonsValues),
		"addons": cannedManifest("addons") + applicationManifest("tailscale", "charts/tailscale-config", tailscaleValuesObject),
	}}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     outDir,
		Envs:       []Env{Envs[1]},
		Charts:     []string{"tailscale-config"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}

	inheritedAddons := filepath.Join(outDir, "homelab", "_inherited", "addons.yaml")
	if _, ok := fr.find("helm", "template addons ", "-f "+inheritedAddons); !ok {
		t.Errorf("inherit-only addons did not receive the values gitops hands it; recorded:\n%s", fr.dump())
	}
	inheritedChild := filepath.Join(outDir, "homelab", "_inherited", "tailscale-config.yaml")
	if _, ok := fr.find("helm", "template tailscale-config ", "-f "+inheritedChild); !ok {
		t.Errorf("tailscale-config did not receive the inherited values; recorded:\n%s", fr.dump())
	}
	if c := checkByName(t, res, "render/homelab/_inherit"); c.Detail != "values inherited from parent Applications: 2" {
		t.Errorf("render/homelab/_inherit detail = %q", c.Detail)
	}

	// gitops renders before addons, or addons could not have seen its values.
	gitopsIdx, addonsIdx := -1, -1
	for i, c := range fr.cmds {
		switch line := c.line(); {
		case strings.HasPrefix(line, "helm template gitops "):
			gitopsIdx = i
		case strings.HasPrefix(line, "helm template addons "):
			addonsIdx = i
		}
	}
	if gitopsIdx < 0 || addonsIdx < 0 || gitopsIdx > addonsIdx {
		t.Errorf("gitops must render before addons (gitops at %d, addons at %d):\n%s", gitopsIdx, addonsIdx, fr.dump())
	}
}

func TestRenderInheritOnlyGitopsForParentSelection(t *testing.T) {
	root := testRepoRoot(t)
	bootstrapValues := "        argocd:\n          hostname: argocd.example.com\n"
	fr := &fakeRunner{manifests: map[string]string{
		"gitops": cannedManifest("gitops") + applicationManifest("bootstrap", "charts/bootstrap", bootstrapValues),
	}}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       []Env{Envs[1]},
		Charts:     []string{"bootstrap"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if !res.Pass {
		var buf strings.Builder
		res.WriteText(&buf)
		t.Fatalf("expected pass, got:\n%s", buf.String())
	}
	// gitops deploys bootstrap, so it renders inherit-only (with the
	// Terraform-mirroring --set); the child-deploying parents are not needed.
	if _, ok := fr.find("helm", "template gitops ", "--set global.domain=REPLACEME-domain.com"); !ok {
		t.Errorf("gitops was not rendered for inheritance; recorded:\n%s", fr.dump())
	}
	for _, parent := range []string{"addons", "applications"} {
		if cmd, ok := fr.find("helm", "template "+parent+" "); ok {
			t.Errorf("%s is not needed for a bootstrap selection: %s", parent, cmd.line())
		}
	}
	if _, ok := fr.find("helm", "template bootstrap ", "_inherited/bootstrap.yaml (inherited"); ok {
		t.Error("the detail text must not leak into argv")
	}
	if _, ok := fr.find("helm", "template bootstrap ", filepath.Join("_inherited", "bootstrap.yaml")); !ok {
		t.Errorf("bootstrap did not receive the values gitops hands it; recorded:\n%s", fr.dump())
	}
	c := checkByName(t, res, "render/homelab/bootstrap")
	if !strings.Contains(c.Detail, "homelab/_inherited/bootstrap.yaml (inherited from parent Application helm.valuesObject)") {
		t.Errorf("render/homelab/bootstrap detail = %q", c.Detail)
	}
}

func TestRenderInheritOnlyParentFailureIsReported(t *testing.T) {
	root := testRepoRoot(t)
	// addons is not selected, so its failure has no render check of its own;
	// it must surface through _inherit or the child silently renders without
	// its parent's values.
	fr := &fakeRunner{failRelease: "addons"}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       []Env{Envs[1]},
		Charts:     []string{"tailscale-config"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if res.Pass {
		t.Fatal("a failed inherit-only parent render must fail the result")
	}
	c := checkByName(t, res, "render/homelab/_inherit")
	if c.Status != StatusFail {
		t.Fatalf("render/homelab/_inherit: status %s (%s), want fail", c.Status, c.Detail)
	}
	if c.Detail != "values inherited from parent Applications: 0; 1 problem(s)" {
		t.Errorf("detail = %q", c.Detail)
	}
	joined := strings.Join(c.Findings, "\n")
	for _, want := range []string{"addons: inherit-only render failed: helm template failed", "nil pointer evaluating"} {
		if !strings.Contains(joined, want) {
			t.Errorf("findings missing %q: %v", want, c.Findings)
		}
	}
	// The selected chart itself still renders and passes.
	if c := checkByName(t, res, "render/homelab/tailscale-config"); c.Status != StatusPass {
		t.Errorf("render/homelab/tailscale-config: status %s (%s)", c.Status, c.Detail)
	}
	for _, c := range res.Checks {
		if c.Name == "render/homelab/addons" {
			t.Error("an inherit-only parent must not get a render check")
		}
	}
}

func TestRenderInheritSkippedWhenConfigFails(t *testing.T) {
	root := testRepoRoot(t)
	broken := Env{Name: "homelab", ConfigSet: "homelab", EnvFile: "configuration/environments/nope.yaml", TwoStage: true}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot: root,
		OutDir:   t.TempDir(),
		Envs:     []Env{broken},
		Charts:   []string{"addons"},
		Runner:   &fakeRunner{},
	})
	c := checkByName(t, res, "render/homelab/_inherit")
	if c.Status != StatusSkip || !strings.Contains(c.Detail, "config resolution failed") {
		t.Errorf("render/homelab/_inherit: status %s detail %q, want skip", c.Status, c.Detail)
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
	for _, want := range []string{"env: homelab", "domain: REPLACEME-domain.com", "kubernetes_version: ", "argocd_automated_sync: true\n"} {
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
	// localdev syncs Applications from the working tree with `argocd app sync
	// --local`, which needs automated sync off; the policy reads this key to
	// skip app-automated for that env (ARGOCD_AUTOMATED_SYNC=false).
	if !strings.Contains(string(localRaw), "argocd_automated_sync: false\n") {
		t.Errorf("localdev _data.yaml missing argocd_automated_sync: false; got:\n%s", string(localRaw))
	}
}

func TestAutomatedSyncFlagDefaultsToTrue(t *testing.T) {
	// A config set without the platform key (or an older schema) must keep
	// the strict policy: the flag only relaxes app-automated when it is
	// explicitly "false".
	cases := []struct {
		name string
		vals map[string]config.ConfigValue
		want bool
	}{
		{"missing", map[string]config.ConfigValue{}, true},
		{"true", map[string]config.ConfigValue{"ARGOCD_AUTOMATED_SYNC": {Value: "true"}}, true},
		{"false", map[string]config.ConfigValue{"ARGOCD_AUTOMATED_SYNC": {Value: "false"}}, false},
		{"other", map[string]config.ConfigValue{"ARGOCD_AUTOMATED_SYNC": {Value: "no"}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := automatedSync(&config.ResolvedConfig{Values: tc.vals}); got != tc.want {
				t.Errorf("automatedSync(%v) = %v, want %v", tc.vals, got, tc.want)
			}
		})
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

	// The target version is whatever configuration/versions.yaml says. Asserting
	// a literal here would let a version bump pass while the tool ran against
	// the wrong schemas.
	wantVersion, err := KubernetesVersion(root)
	if err != nil {
		t.Fatalf("KubernetesVersion: %v", err)
	}

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
		"-kubernetes-version " + SchemaVersion(wantVersion),
		"-strict",
		"-summary",
		"-output json",
		// Per-env cache subdirectory: the envs validate concurrently and
		// kubeconform writes its schema cache without locking.
		"-cache " + filepath.Join(cacheDir, "localdev"),
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
	plutoWants := []string{
		// An explicit file, not `detect-files -d <dir>`: the directory form
		// would also walk _data.yaml and _values/.
		"detect " + RenderedFile(outDir, "localdev", "addons"),
		"--target-versions k8s=v" + wantVersion,
		"-o json",
	}
	for _, want := range plutoWants {
		if !strings.Contains(plutoCmd.line(), want) {
			t.Errorf("pluto args missing %q:\n%s", want, plutoCmd.line())
		}
	}
	if strings.Contains(plutoCmd.line(), "detect-files") {
		t.Errorf("pluto must not scan a whole directory:\n%s", plutoCmd.line())
	}
}

func TestPerEnvKubeconformCacheDirs(t *testing.T) {
	root := testRepoRoot(t)
	cacheDir := filepath.Join(t.TempDir(), "kubeconform")
	fr := &fakeRunner{}

	Render(context.Background(), RenderOptions{
		RepoRoot: root,
		OutDir:   t.TempDir(),
		Envs:     Envs,
		Charts:   []string{"addons"},
		SkipLint: true,
		CacheDir: cacheDir,
		Runner:   fr,
	})

	for _, env := range Envs {
		// homelab-preview renders only charts/applications: no addons, no
		// kubeconform run for this chart filter.
		if !env.Renders("addons") {
			continue
		}
		want := "-cache " + filepath.Join(cacheDir, env.Name)
		if _, ok := fr.find("kubeconform", want); !ok {
			t.Errorf("no kubeconform invocation with %q; recorded:\n%s", want, fr.dump())
		}
		if _, err := os.Stat(filepath.Join(cacheDir, env.Name)); err != nil {
			t.Errorf("cache directory for %s was not created: %v", env.Name, err)
		}
	}
	// A shared cache dir would be a concurrent-write race between the envs.
	if _, ok := fr.find("kubeconform", "-cache "+cacheDir+" "); ok {
		t.Error("kubeconform must not be given the shared cache root")
	}
}

func TestSchemaToolsNeverSeeMetadataFiles(t *testing.T) {
	root := testRepoRoot(t)
	outDir := t.TempDir()
	fr := &fakeRunner{}

	// addons is two-stage for homelab, so this run generates both _data.yaml
	// and _values/addons.yaml alongside the rendered chart.
	_, res := Render(context.Background(), RenderOptions{
		RepoRoot: root,
		OutDir:   outDir,
		Envs:     []Env{Envs[1]},
		Charts:   []string{"addons"},
		SkipLint: true,
		Runner:   fr,
	})
	if c := checkByName(t, res, "render/homelab/_config"); c.Status != StatusPass {
		t.Fatalf("render/homelab/_config: status %s (%s)", c.Status, c.Detail)
	}
	// Both metadata files must exist, or the test proves nothing.
	for _, p := range []string{
		filepath.Join(outDir, "homelab", "_data.yaml"),
		filepath.Join(outDir, "homelab", "_values", "addons.yaml"),
	} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("expected %s to exist: %v", p, err)
		}
	}

	for _, tool := range []string{"kubeconform", "pluto"} {
		cmd, ok := fr.find(tool)
		if !ok {
			t.Fatalf("%s was never invoked; recorded:\n%s", tool, fr.dump())
		}
		line := cmd.line()
		for _, forbidden := range []string{"_data.yaml", "_values"} {
			if strings.Contains(line, forbidden) {
				t.Errorf("%s args must not reference %s:\n%s", tool, forbidden, line)
			}
		}
		// Neither tool may be handed the env directory, which contains them.
		if strings.Contains(line, filepath.Join(outDir, "homelab")+" ") ||
			strings.HasSuffix(line, filepath.Join(outDir, "homelab")) {
			t.Errorf("%s args must name files, not the env directory:\n%s", tool, line)
		}
		if !strings.Contains(line, RenderedFile(outDir, "homelab", "addons")) {
			t.Errorf("%s args missing the rendered chart file:\n%s", tool, line)
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

// shimMissStderr is what mise prints when a shim resolves but no version of
// the tool is installed.
func shimMissStderr(tool string) string {
	return "mise ERROR No version is set for shim: " + tool +
		"\nSet a global default version with one of the following:\nmise use -g " + tool + "@1.2.3\n"
}

func TestShimMissReportsMissingToolForEveryTool(t *testing.T) {
	root := testRepoRoot(t)

	tests := []struct {
		name     string
		runner   *fakeRunner
		check    string
		wantTool string
	}{
		{
			name:     "helm template",
			runner:   &fakeRunner{templateStderr: shimMissStderr("helm")},
			check:    "render/localdev/addons",
			wantTool: "helm",
		},
		{
			name:     "helm lint",
			runner:   &fakeRunner{lintErr: shimMissStderr("helm")},
			check:    "lint/localdev/addons",
			wantTool: "helm",
		},
		{
			name:     "kubeconform",
			runner:   &fakeRunner{kubeconformStderr: shimMissStderr("kubeconform")},
			check:    "kubeconform/localdev",
			wantTool: "kubeconform",
		},
		{
			name:     "pluto",
			runner:   &fakeRunner{plutoStderr: shimMissStderr("pluto")},
			check:    "pluto/localdev",
			wantTool: "pluto",
		},
		{
			name:     "asdf phrasing is recognised too",
			runner:   &fakeRunner{plutoStderr: "No version set for command pluto\n"},
			check:    "pluto/localdev",
			wantTool: "pluto",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, res := Render(context.Background(), RenderOptions{
				RepoRoot: root,
				OutDir:   t.TempDir(),
				Envs:     []Env{Envs[0]},
				Charts:   []string{"addons"},
				Runner:   tc.runner,
			})
			c := checkByName(t, res, tc.check)
			if c.Status != StatusFail {
				t.Fatalf("%s: status %s, want fail", tc.check, c.Status)
			}
			if c.Detail != ToolMissingDetail(tc.wantTool) {
				t.Errorf("detail = %q, want the standard missing-tool detail for %s", c.Detail, tc.wantTool)
			}
			if len(c.Findings) == 0 {
				t.Error("findings should carry the tool's stderr for diagnosis")
			}
		})
	}
}

func TestGenuineToolFailuresKeepTheirOwnDetail(t *testing.T) {
	root := testRepoRoot(t)

	tests := []struct {
		name       string
		runner     *fakeRunner
		check      string
		wantDetail string
	}{
		{
			name:       "helm template",
			runner:     &fakeRunner{templateStderr: "Error: template: addons/templates/app.yaml:3:12: nil pointer\n"},
			check:      "render/localdev/addons",
			wantDetail: "helm template failed",
		},
		{
			name:       "helm lint",
			runner:     &fakeRunner{lintErr: "Error: cannot load values file: permission denied\n"},
			check:      "lint/localdev/addons",
			wantDetail: "helm lint failed",
		},
		{
			name:       "kubeconform",
			runner:     &fakeRunner{kubeconformStderr: "failed opening cache folder /tmp/x: no such file or directory\n"},
			check:      "kubeconform/localdev",
			wantDetail: "kubeconform failed",
		},
		{
			name:       "pluto",
			runner:     &fakeRunner{plutoStderr: "Error: unable to read file: permission denied\n"},
			check:      "pluto/localdev",
			wantDetail: "pluto failed",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, res := Render(context.Background(), RenderOptions{
				RepoRoot: root,
				OutDir:   t.TempDir(),
				Envs:     []Env{Envs[0]},
				Charts:   []string{"addons"},
				Runner:   tc.runner,
			})
			c := checkByName(t, res, tc.check)
			if c.Status != StatusFail {
				t.Fatalf("%s: status %s, want fail", tc.check, c.Status)
			}
			if !strings.Contains(c.Detail, tc.wantDetail) {
				t.Errorf("detail = %q, want it to contain %q", c.Detail, tc.wantDetail)
			}
			if strings.Contains(c.Detail, "mise install") {
				t.Errorf("a real tool failure must not be reported as a missing tool: %q", c.Detail)
			}
		})
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

func TestRenderLintFailsOnNonZeroExitWithoutErrorLines(t *testing.T) {
	root := testRepoRoot(t)
	// helm can exit non-zero without printing an [ERROR] line, for example on
	// an unreadable values file. That must still fail, with stderr attached.
	fr := &fakeRunner{
		lintOutput: "==> Linting charts/addons\n",
		lintErr:    "Error: cannot load values file: open charts/addons/values.yaml: permission denied\n",
	}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       []Env{Envs[0]},
		Charts:     []string{"addons"},
		SkipSchema: true,
		Runner:     fr,
	})
	if res.Pass {
		t.Fatal("a non-zero helm lint exit must fail the result even with no [ERROR] line")
	}
	c := checkByName(t, res, "lint/localdev/addons")
	if c.Status != StatusFail {
		t.Fatalf("lint/localdev/addons: status %s, want fail", c.Status)
	}
	if !strings.Contains(c.Detail, "helm lint failed") {
		t.Errorf("detail = %q, want it to report the failed run", c.Detail)
	}
	joined := strings.Join(c.Findings, "\n")
	if !strings.Contains(joined, "permission denied") {
		t.Errorf("findings must carry helm stderr: %v", c.Findings)
	}
}

func TestRenderParallelBoundsConcurrency(t *testing.T) {
	root := testRepoRoot(t)

	tests := []struct {
		name     string
		parallel int
		schema   bool
	}{
		{name: "serialised", parallel: 1},
		{name: "two at a time", parallel: 2},
		// The schema phase runs both envs concurrently, and pluto spawns one
		// process per rendered file. All of it must share the render pool's
		// semaphore, or --parallel 1 still permits two processes at once.
		{name: "serialised including the schema phase", parallel: 1, schema: true},
		{name: "two at a time including the schema phase", parallel: 2, schema: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fr := &fakeRunner{}
			_, res := Render(context.Background(), RenderOptions{
				RepoRoot:   root,
				OutDir:     t.TempDir(),
				Envs:       Envs,
				Parallel:   tc.parallel,
				SkipLint:   true,
				SkipSchema: !tc.schema,
				Runner:     fr,
			})
			if !res.Pass {
				var buf strings.Builder
				res.WriteText(&buf)
				t.Fatalf("expected the render to pass, got:\n%s", buf.String())
			}
			if got := fr.peakConcurrency(); got > tc.parallel {
				t.Errorf("peak concurrency %d exceeds --parallel %d", got, tc.parallel)
			}
			// Guard against the pool silently never running anything.
			if len(fr.cmds) == 0 {
				t.Fatal("no commands were run")
			}
			if tc.schema {
				if _, ok := fr.find("kubeconform"); !ok {
					t.Error("the schema phase did not run")
				}
				if _, ok := fr.find("pluto"); !ok {
					t.Error("pluto did not run")
				}
			}
		})
	}
}

func TestRenderConfigFailureEmitsSkipChecks(t *testing.T) {
	root := testRepoRoot(t)
	fr := &fakeRunner{}

	// An env whose file does not exist cannot resolve, so nothing can render
	// for it. Agents match checks by name, so each name must still appear.
	broken := Env{Name: "homelab", ConfigSet: "homelab", EnvFile: "configuration/environments/nope.yaml", TwoStage: true}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot: root,
		OutDir:   t.TempDir(),
		Envs:     []Env{broken},
		Charts:   []string{"addons", "tailscale-config"},
		Runner:   fr,
	})
	if res.Pass {
		t.Fatal("expected failure when config resolution fails")
	}
	if c := checkByName(t, res, "render/homelab/_config"); c.Status != StatusFail {
		t.Errorf("render/homelab/_config: status %s, want fail", c.Status)
	}

	wantSkipped := []string{
		"render/homelab/addons",
		"render/homelab/tailscale-config",
		"lint/homelab/addons",
		"lint/homelab/tailscale-config",
		"kubeconform/homelab",
		"pluto/homelab",
	}
	for _, name := range wantSkipped {
		c := checkByName(t, res, name)
		if c.Status != StatusSkip {
			t.Errorf("%s: status %s, want skip", name, c.Status)
		}
		if !strings.Contains(c.Detail, "config resolution failed") {
			t.Errorf("%s detail = %q, want it to explain the skip", name, c.Detail)
		}
	}
	if len(fr.cmds) != 0 {
		t.Errorf("no tool should run for an env that failed to resolve, ran:\n%s", fr.dump())
	}
}

func TestRenderOmitSchemaChecksEmitsNothing(t *testing.T) {
	root := testRepoRoot(t)
	fr := &fakeRunner{}

	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:         root,
		OutDir:           t.TempDir(),
		Envs:             Envs,
		Charts:           []string{"addons"},
		SkipLint:         true,
		OmitSchemaChecks: true,
		Runner:           fr,
	})
	if !res.Pass {
		t.Fatal("omitting schema checks must not fail the result")
	}
	for _, c := range res.Checks {
		if strings.HasPrefix(c.Name, "kubeconform/") || strings.HasPrefix(c.Name, "pluto/") {
			t.Errorf("unexpected check %q: schema checks must be absent, not skipped", c.Name)
		}
	}
	for _, tool := range []string{"kubeconform", "pluto"} {
		if _, ok := fr.find(tool); ok {
			t.Errorf("%s must not run when schema checks are omitted", tool)
		}
	}
}

func TestRenderCancelledContextStopsDispatch(t *testing.T) {
	root := testRepoRoot(t)
	fr := &fakeRunner{}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, res := Render(ctx, RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       Envs,
		SkipLint:   true,
		SkipSchema: true,
		Runner:     fr,
	})
	if res.Pass {
		t.Fatal("a cancelled run must not report success")
	}
	c := checkByName(t, res, "render/cancelled")
	if c.Status != StatusFail || !strings.Contains(c.Detail, "cancelled") {
		t.Errorf("render/cancelled: status %s detail %q", c.Status, c.Detail)
	}
	if len(fr.cmds) != 0 {
		t.Errorf("no helm invocation should be dispatched after cancellation, ran %d", len(fr.cmds))
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
	expected := ExpectedSnapshots(Envs, out.Charts)
	for _, env := range Envs {
		if len(out.Files[env.Name]) != len(expected[env.Name]) {
			t.Errorf("env %s: rendered %d files, want %d", env.Name, len(out.Files[env.Name]), len(expected[env.Name]))
		}
	}
	for _, c := range out.Charts {
		for _, env := range Envs {
			if !env.Renders(c.Name) {
				continue
			}
			got := checkByName(t, res, "render/"+env.Name+"/"+c.Name)
			if got.Status != StatusPass {
				t.Errorf("render/%s/%s: status %s", env.Name, c.Name, got.Status)
			}
		}
	}
}

// TestRenderInheritFindingsAreDeterministic renders with every inherit-only
// parent failing and requires the render/<env>/_inherit findings to read
// identically on every run: within a wave they arrive in goroutine completion
// order and must be re-ordered by chart before they are reported, so the
// sequence is wave order (gitops first) and chart order inside a wave.
func TestRenderInheritFindingsAreDeterministic(t *testing.T) {
	root := testRepoRoot(t)
	var first []string
	for i := 0; i < 15; i++ {
		fr := &fakeRunner{templateStderr: "boom"}
		_, res := Render(context.Background(), RenderOptions{
			RepoRoot:   root,
			OutDir:     t.TempDir(),
			Envs:       []Env{Envs[1]},
			Charts:     []string{"tailscale-config"},
			Parallel:   4,
			SkipLint:   true,
			SkipSchema: true,
			Runner:     fr,
		})
		c := checkByName(t, res, "render/homelab/_inherit")
		if c.Status != StatusFail || len(c.Findings) < 3 {
			t.Fatalf("expected a failing _inherit check with findings for every parent, got %s %q", c.Status, c.Findings)
		}
		if i == 0 {
			first = c.Findings
			var order []string
			for _, f := range first {
				if chart, _, ok := strings.Cut(f, ": inherit-only render failed"); ok {
					order = append(order, chart)
				}
			}
			if want := "gitops addons applications"; strings.Join(order, " ") != want {
				t.Fatalf("findings must be ordered by wave then chart: got %q, want %q", order, want)
			}
			continue
		}
		if strings.Join(first, "\n") != strings.Join(c.Findings, "\n") {
			t.Fatalf("run %d findings differ from run 0:\n%s\n---\n%s", i, strings.Join(first, "\n"), strings.Join(c.Findings, "\n"))
		}
	}
}

// TestCommittedValuesCheck covers render/<env>/_committed-values: the
// values-localdev.yaml files committed for the two-stage parents must be
// exactly what `config export --set localdev` renders (issue #263). The
// templates and config come from the real worktree; the committed files are
// staged in a scratch root so a stale or missing copy can be simulated.
func TestCommittedValuesCheck(t *testing.T) {
	root := testRepoRoot(t)
	env := Envs[0]
	if env.Name != "localdev" || env.TwoStage {
		t.Fatalf("Envs[0] = %+v, want the plain-Helm localdev env", env)
	}
	rc, err := resolveEnvConfig(root, env)
	if err != nil {
		t.Fatalf("resolving %s config: %v", env.Name, err)
	}

	stage := func(t *testing.T, mutate func(dir string)) string {
		t.Helper()
		dir := t.TempDir()
		for _, rel := range []string{
			"configuration/templates/helm-addons.tmpl",
			"configuration/templates/helm-apps.tmpl",
			"charts/addons/values-localdev.yaml",
			"charts/applications/values-localdev.yaml",
		} {
			data, err := os.ReadFile(filepath.Join(root, rel))
			if err != nil {
				t.Fatalf("reading %s: %v", rel, err)
			}
			dest := filepath.Join(dir, rel)
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(dest, data, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if mutate != nil {
			mutate(dir)
		}
		return dir
	}
	addons := filepath.Join("charts", "addons", "values-localdev.yaml")

	tests := []struct {
		name         string
		mutate       func(dir string)
		wantStatus   Status
		wantDetail   []string
		wantFindings []string
	}{
		{
			name:       "committed files identical to the export pass",
			wantStatus: StatusPass,
			wantDetail: []string{"charts/addons/values-localdev.yaml", "charts/applications/values-localdev.yaml", "match `homelab config export --set localdev`"},
		},
		{
			name: "a hand-edited file fails with a diff and the regenerate command",
			mutate: func(dir string) {
				p := filepath.Join(dir, addons)
				data, _ := os.ReadFile(p)
				edited := strings.Replace(string(data), "domain: homelab.local", "domain: hand-edited.test", 1)
				if edited == string(data) {
					t.Fatal("fixture no longer contains the localdev domain line")
				}
				if err := os.WriteFile(p, []byte(edited), 0o644); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus:   StatusFail,
			wantDetail:   []string{"1 of 2 committed values file(s) differ", "task config:export:localdev", "never hand-edit"},
			wantFindings: []string{"--- committed charts/addons/values-localdev.yaml", "+++ config export charts/addons/values-localdev.yaml", "-  domain: hand-edited.test", "+  domain: homelab.local"},
		},
		{
			name: "a missing file fails and names it",
			mutate: func(dir string) {
				if err := os.Remove(filepath.Join(dir, addons)); err != nil {
					t.Fatal(err)
				}
			},
			wantStatus:   StatusFail,
			wantDetail:   []string{"1 of 2 committed values file(s) differ"},
			wantFindings: []string{"charts/addons/values-localdev.yaml: open "},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := stage(t, tc.mutate)
			c := committedValuesCheck(RenderOptions{RepoRoot: dir}, &envRender{env: env, rc: rc})
			if c.Name != "render/localdev/_committed-values" {
				t.Errorf("check name = %q", c.Name)
			}
			if c.Status != tc.wantStatus {
				t.Fatalf("status = %s (%s), want %s; findings: %v", c.Status, c.Detail, tc.wantStatus, c.Findings)
			}
			for _, want := range tc.wantDetail {
				if !strings.Contains(c.Detail, want) {
					t.Errorf("detail %q missing %q", c.Detail, want)
				}
			}
			joined := strings.Join(c.Findings, "\n")
			for _, want := range tc.wantFindings {
				if !strings.Contains(joined, want) {
					t.Errorf("findings missing %q:\n%s", want, joined)
				}
			}
		})
	}
}

// TestRenderEmitsCommittedValuesCheckForPlainHelmEnvsOnly: the check exists
// for localdev (plain Helm, committed values) and not for homelab, whose
// parent values are generated at render time and never committed.
func TestRenderEmitsCommittedValuesCheckForPlainHelmEnvsOnly(t *testing.T) {
	root := testRepoRoot(t)
	_, res := Render(context.Background(), RenderOptions{
		RepoRoot:   root,
		OutDir:     t.TempDir(),
		Envs:       Envs,
		Charts:     []string{"addons"},
		SkipLint:   true,
		SkipSchema: true,
		Runner:     &fakeRunner{},
	})
	c := checkByName(t, res, "render/localdev/_committed-values")
	if c.Status != StatusPass {
		t.Errorf("render/localdev/_committed-values: %s (%s)\n%s", c.Status, c.Detail, strings.Join(c.Findings, "\n"))
	}
	for _, other := range res.Checks {
		if other.Name == "render/homelab/_committed-values" {
			t.Errorf("homelab must not get a committed-values check; it generates its parent values at render time")
		}
	}
}
