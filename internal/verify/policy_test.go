package verify

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakePolicyRunner is a minimal fake Runner for testing Policy without
// invoking a real conftest binary.
type fakePolicyRunner struct {
	lookPathErr error
	stdout      []byte
	stderr      []byte
	runErr      error
	lastArgs    []string
}

func (f *fakePolicyRunner) Run(ctx context.Context, dir string, name string, args ...string) ([]byte, []byte, error) {
	f.lastArgs = args
	return f.stdout, f.stderr, f.runErr
}

func (f *fakePolicyRunner) LookPath(name string) (string, error) {
	if f.lookPathErr != nil {
		return "", f.lookPathErr
	}
	return "/usr/bin/" + name, nil
}

func writeRenderedManifests(t *testing.T, root, env string) {
	t.Helper()
	dir := filepath.Join(root, env)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "addons.yaml"), []byte("kind: Application\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "_data.yaml"), []byte("domain: example.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPolicyToolMissing(t *testing.T) {
	root := t.TempDir()
	writeRenderedManifests(t, root, "homelab")
	r := &fakePolicyRunner{lookPathErr: os.ErrNotExist}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}})
	if len(checks) != 1 {
		t.Fatalf("want 1 check, got %d", len(checks))
	}
	if checks[0].Status != StatusFail {
		t.Fatalf("want fail, got %s", checks[0].Status)
	}
	if checks[0].Name != "policy/homelab" {
		t.Fatalf("want name policy/homelab, got %s", checks[0].Name)
	}
	if checks[0].Detail == "" {
		t.Fatal("want a tool-missing detail message")
	}
}

func TestPolicyNoRenderedManifests(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "homelab"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := &fakePolicyRunner{}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}})
	if checks[0].Status != StatusFail {
		t.Fatalf("want fail when no manifests are rendered, got %s", checks[0].Status)
	}
}

func TestPolicyPass(t *testing.T) {
	root := t.TempDir()
	writeRenderedManifests(t, root, "homelab")
	r := &fakePolicyRunner{
		stdout: []byte(`[{"filename":"addons.yaml","namespace":"homelab.application","successes":5}]`),
	}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}})
	if checks[0].Status != StatusPass {
		t.Fatalf("want pass, got %s: %v", checks[0].Status, checks[0].Findings)
	}

	// Sanity: conftest was invoked with --all-namespaces (required, or only
	// the "main" namespace is evaluated and every homelab.* rule is ignored)
	// and pointed at the per-env _data.yaml.
	found := false
	wantData := filepath.Join(root, "homelab", "_data.yaml")
	gotData := ""
	for i, a := range r.lastArgs {
		if a == "--all-namespaces" {
			found = true
		}
		if a == "--data" && i+1 < len(r.lastArgs) {
			gotData = r.lastArgs[i+1]
		}
	}
	if !found {
		t.Fatal("Policy must invoke conftest with --all-namespaces")
	}
	if gotData != wantData {
		t.Fatalf("want --data %q, got %q", wantData, gotData)
	}

	// _data.yaml itself must never be passed as a manifest to scan (it's
	// metadata, not a rendered object).
	for _, a := range r.lastArgs {
		if strings.HasSuffix(a, "_data.yaml") && a != wantData {
			t.Fatalf("_data.yaml must not appear as a manifest argument, got %q", a)
		}
	}
	if !strings.Contains(strings.Join(r.lastArgs, " "), "addons.yaml") {
		t.Fatalf("want addons.yaml among the manifest args, got %v", r.lastArgs)
	}
}

func TestPolicyMissingDomainFailsWithoutRunningConftest(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "homelab")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "addons.yaml"), []byte("kind: Application\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// _data.yaml exists but has no domain key at all.
	if err := os.WriteFile(filepath.Join(dir, "_data.yaml"), []byte("kubernetes_version: \"1.36.1\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := &fakePolicyRunner{stdout: []byte(`[]`)}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}})
	if checks[0].Status != StatusFail {
		t.Fatalf("want fail when domain is missing, got %s", checks[0].Status)
	}
	if checks[0].Detail != "policy data missing domain" {
		t.Fatalf("want detail %q, got %q", "policy data missing domain", checks[0].Detail)
	}
	if r.lastArgs != nil {
		t.Fatal("Policy must not invoke conftest at all when domain is missing")
	}
}

func TestPolicyEmptyDomainFailsWithoutRunningConftest(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "homelab")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "addons.yaml"), []byte("kind: Application\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "_data.yaml"), []byte("domain: \"\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := &fakePolicyRunner{stdout: []byte(`[]`)}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}})
	if checks[0].Status != StatusFail {
		t.Fatalf("want fail when domain is empty, got %s", checks[0].Status)
	}
	if r.lastArgs != nil {
		t.Fatal("Policy must not invoke conftest at all when domain is empty")
	}
}

func TestPolicyWarningsAreSurfacedWithoutFailing(t *testing.T) {
	root := t.TempDir()
	writeRenderedManifests(t, root, "homelab")
	r := &fakePolicyRunner{
		stdout: []byte(`[{"filename":"addons.yaml","namespace":"homelab.application","successes":4,
			"warnings":[{"msg":"[image-latest] Application/argocd/plex: exempt but no follow-up ticket referenced"}]}]`),
	}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}})
	if checks[0].Status != StatusPass {
		t.Fatalf("want pass (warnings must not fail the check), got %s", checks[0].Status)
	}
	if len(checks[0].Findings) != 1 || !strings.HasPrefix(checks[0].Findings[0], "warn: ") {
		t.Fatalf("want one warn:-prefixed finding, got %v", checks[0].Findings)
	}
}

func TestPolicyFailuresBecomeFindings(t *testing.T) {
	root := t.TempDir()
	writeRenderedManifests(t, root, "homelab")
	r := &fakePolicyRunner{
		stdout: []byte(`[
			{"filename":"` + filepath.Join(root, "homelab", "addons.yaml") + `","namespace":"homelab.application","successes":3,
			 "failures":[{"msg":"[app-finalizer] Application/argocd/cilium: missing finalizer"}]}
		]`),
		runErr: errExitOne,
	}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}})
	if checks[0].Status != StatusFail {
		t.Fatalf("want fail, got %s", checks[0].Status)
	}
	if len(checks[0].Findings) != 1 {
		t.Fatalf("want 1 finding, got %d: %v", len(checks[0].Findings), checks[0].Findings)
	}
	want := "addons.yaml: [app-finalizer] Application/argocd/cilium: missing finalizer"
	if checks[0].Findings[0] != want {
		t.Fatalf("want finding %q, got %q", want, checks[0].Findings[0])
	}
}

func TestPolicyRealRunFailureIsDistinguishedFromPolicyFailures(t *testing.T) {
	root := t.TempDir()
	writeRenderedManifests(t, root, "homelab")
	r := &fakePolicyRunner{
		stdout: []byte(""),
		stderr: []byte("rego_parse_error: bad policy"),
		runErr: errExitOne,
	}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}})
	if checks[0].Status != StatusFail {
		t.Fatalf("want fail, got %s", checks[0].Status)
	}
	if checks[0].Detail == "" {
		t.Fatal("want a detail describing the conftest run failure")
	}
}

func TestPolicyMultipleEnvs(t *testing.T) {
	root := t.TempDir()
	writeRenderedManifests(t, root, "homelab")
	writeRenderedManifests(t, root, "localdev")
	r := &fakePolicyRunner{stdout: []byte(`[]`)}

	checks := Policy(context.Background(), r, root, "tests/policy", []Env{{Name: "homelab"}, {Name: "localdev"}})
	if len(checks) != 2 {
		t.Fatalf("want 2 checks, got %d", len(checks))
	}
	if checks[0].Name != "policy/homelab" || checks[1].Name != "policy/localdev" {
		t.Fatalf("unexpected check names: %s, %s", checks[0].Name, checks[1].Name)
	}
}

// errExitOne stands in for the *exec.ExitError conftest test returns when it
// reports policy failures (exit 1); Policy must still parse stdout in that case.
var errExitOne = errFixed("exit status 1")

type errFixed string

func (e errFixed) Error() string { return string(e) }
