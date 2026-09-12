package verify

import (
	"context"
	"os"
	"path/filepath"
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
	for _, a := range r.lastArgs {
		if a == "--all-namespaces" {
			found = true
		}
	}
	if !found {
		t.Fatal("Policy must invoke conftest with --all-namespaces")
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
