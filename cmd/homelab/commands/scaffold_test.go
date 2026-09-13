package commands

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/scaffold"
	"github.com/spf13/cobra"
)

// scaffoldFixture copies the scaffold package's fixture repository (a
// trimmed tree holding every file the scaffolder reads or edits, with its
// own Taskfile.yml) into a temp dir and makes it the working directory, so
// findProjectRoot resolves to it.
func scaffoldFixture(t *testing.T) string {
	t.Helper()
	src := filepath.Join("..", "..", "..", "internal", "scaffold", "testdata", "repo")
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, b, 0o644)
	})
	if err != nil {
		t.Fatalf("copying fixture: %v", err)
	}
	t.Chdir(dst)
	return dst
}

// runScaffold executes `homelab <args>` with the scaffold command tree built
// as main builds it (root flag error handler, global --dry-run).
func runScaffold(t *testing.T, args ...string) (err error, stdout, stderr string) {
	t.Helper()
	root := &cobra.Command{Use: "homelab", SilenceUsage: true, SilenceErrors: true}
	root.SetFlagErrorFunc(UsageErrorFunc)
	root.PersistentFlags().BoolVar(&DryRun, "dry-run", false, "")
	t.Cleanup(func() { DryRun = false })
	root.AddCommand(NewScaffoldCmd())

	var out, errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetArgs(args)
	err = root.ExecuteContext(context.Background())
	return err, out.String(), errOut.String()
}

var demoChart = []string{"--chart-repo", "https://charts.example.com/demo", "--chart-version", "1.0.0"}

func TestScaffoldExitCodes(t *testing.T) {
	with := func(args ...string) []string { return append(args, demoChart...) }
	tests := []struct {
		name     string
		args     []string
		wantCode int
		wantMsg  string
	}{
		{"group without subcommand", []string{"scaffold"}, ExitUsage, "requires a subcommand"},
		{"unknown subcommand", []string{"scaffold", "chart"}, ExitUsage, "unknown scaffold subcommand"},
		{"missing name", []string{"scaffold", "app"}, ExitUsage, "accepts 1 arg"},
		{"two names", []string{"scaffold", "app", "a", "b"}, ExitUsage, "accepts 1 arg"},
		{"unknown flag", with("scaffold", "app", "demo", "--pattern", "helm", "--bogus"), ExitUsage, "unknown flag: --bogus"},
		{"bad port value", with("scaffold", "app", "demo", "--pattern", "helm", "--port", "http"), ExitUsage, "invalid argument"},
		{"bad name", with("scaffold", "app", "Demo_App", "--pattern", "helm"), ExitUsage, "DNS label"},
		{"missing pattern", with("scaffold", "app", "demo"), ExitUsage, "--pattern must be one of"},
		{"unknown pattern", with("scaffold", "app", "demo", "--pattern", "kustomize"), ExitUsage, "--pattern must be one of"},
		{"unknown tier", with("scaffold", "app", "demo", "--pattern", "helm", "--tier", "core"), ExitUsage, "--tier must be one of"},
		{"missing chart repo", []string{"scaffold", "app", "demo", "--pattern", "helm", "--chart-version", "1"}, ExitUsage, "--chart-repo is required"},
		{"missing chart version", []string{"scaffold", "app", "demo", "--pattern", "helm", "--chart-repo", "https://c.example.com"}, ExitUsage, "--chart-version is required"},
		{"operator without crd group", with("scaffold", "app", "demo", "--pattern", "operator"), ExitUsage, "--crd-group"},
		{"port out of range", with("scaffold", "app", "demo", "--pattern", "helm", "--port", "70000"), ExitUsage, "out of range"},
		{"bad expect", with("scaffold", "app", "demo", "--pattern", "helm", "--expect", "200,ok"), ExitUsage, "--expect"},
		{"existing app", with("scaffold", "app", "sonarr", "--pattern", "helm"), ExitUsage, "already exists"},
		{"existing crd group", with("scaffold", "app", "demo", "--pattern", "operator", "--crd-group", "postgresql.cnpg.io", "--crd-kinds", "Cluster"), ExitUsage, "already provided"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := scaffoldFixture(t)
			before := treeDigest(t, root)
			err, _, _ := runScaffold(t, tc.args...)
			if err == nil {
				t.Fatalf("expected an error for %v", tc.args)
			}
			if got := ExitCode(err); got != tc.wantCode {
				t.Errorf("ExitCode = %d, want %d (err: %v)", got, tc.wantCode, err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("error %q does not mention %q", err.Error(), tc.wantMsg)
			}
			if after := treeDigest(t, root); after != before {
				t.Error("a rejected invocation must not write anything")
			}
		})
	}
}

func TestScaffoldDryRunPrintsAPatchAndWritesNothing(t *testing.T) {
	root := scaffoldFixture(t)
	before := treeDigest(t, root)

	err, stdout, stderr := runScaffold(t, append([]string{"--dry-run", "scaffold", "app", "demo", "--pattern", "helm",
		"--port", "8080", "--health-path", "/healthz"}, demoChart...)...)
	if err != nil {
		t.Fatalf("dry run failed: %v\n%s", err, stderr)
	}
	for _, want := range []string{
		"diff --git a/charts/applications/templates/demo.yaml b/charts/applications/templates/demo.yaml\nnew file mode 100644",
		"+++ b/configuration/versions.yaml",
		"+  demo: \"1.0.0\"",
		"+  DEMO_HOSTNAME:",
		"+++ b/tests/e2e/demo/chainsaw-test.yaml",
		"+++ b/docs/apps/demo.md",
		// The committed localdev values the regenerate step would write.
		"+++ b/charts/applications/values-localdev.yaml",
		"+    url: http://demo.demo.svc.cluster.local:8080/healthz",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("dry-run patch lacks %q", want)
		}
	}
	if !strings.Contains(stderr, "dry run: nothing written") || !strings.Contains(stderr, "tests/snapshots/<env>/{applications}.yaml") {
		t.Errorf("dry-run note missing or incomplete: %q", stderr)
	}
	if strings.Contains(stdout, "dry run") {
		t.Error("the note must go to stderr so stdout stays a clean patch")
	}
	if after := treeDigest(t, root); after != before {
		t.Error("--dry-run wrote to the repository")
	}
}

func TestScaffoldNoRegenerateWritesOnlySources(t *testing.T) {
	root := scaffoldFixture(t)
	err, stdout, stderr := runScaffold(t, append([]string{"scaffold", "app", "demo-stack", "--pattern", "deps-main-config",
		"--no-regenerate"}, demoChart...)...)
	if err != nil {
		t.Fatalf("scaffold failed: %v\n%s%s", err, stdout, stderr)
	}
	for _, p := range []string{
		"charts/addons/templates/demo-stack.yaml",
		"charts/demo-stack-config/Chart.yaml",
		"charts/demo-stack-dependencies/values-homelab.yaml",
		"tests/e2e/demo-stack/chainsaw-test.yaml",
		"docs/apps/demo-stack.md",
	} {
		if _, err := os.Stat(filepath.Join(root, p)); err != nil {
			t.Errorf("%s was not written: %v", p, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "charts/addons/values-localdev.yaml")); !os.IsNotExist(err) {
		t.Error("--no-regenerate must not write the committed localdev values")
	}
	for _, want := range []string{"created  charts/addons/templates/demo-stack.yaml", "modified configuration/versions.yaml",
		"Next steps:", "task config:export:localdev && task test:snapshot -- --update", "task verify:text"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("output lacks %q:\n%s", want, stdout)
		}
	}
}

// failingHelm makes every tool invocation fail, as a broken chart would.
type failingHelm struct{}

func (failingHelm) Run(context.Context, string, string, ...string) ([]byte, []byte, error) {
	return nil, []byte("Error: template: boom"), errors.New("exit status 1")
}
func (failingHelm) LookPath(name string) (string, error) { return "/usr/bin/" + name, nil }

func TestScaffoldRegenerateFailureExitsOneAndKeepsSources(t *testing.T) {
	root := scaffoldFixture(t)
	opts := scaffoldOptionsForTest(root)
	cmd := &cobra.Command{}
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetContext(context.Background())

	err := runScaffoldApp(cmd, opts, false, false, failingHelm{})
	if !errors.Is(err, ErrVerificationFailed) || ExitCode(err) != ExitFailure {
		t.Fatalf("err = %v (exit %d), want ErrVerificationFailed (exit 1)", err, ExitCode(err))
	}
	if !strings.Contains(out.String(), "the snapshots are not") {
		t.Errorf("output does not explain the failure:\n%s", out.String())
	}
	if _, err := os.Stat(filepath.Join(root, "charts/applications/templates/demo.yaml")); err != nil {
		t.Errorf("sources must stay written when the regenerate fails: %v", err)
	}
}

func TestScaffoldAppHelpDocumentsTheContract(t *testing.T) {
	err, stdout, _ := runScaffold(t, "scaffold", "app", "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"operator", "helm", "deps-main-config", "cloudnative-pg", "sonarr", "traefik-external",
		"--chart-repo", "--crd-group", "--huge-crds", "--no-regenerate", "--dry-run",
		"tests/gitops/crd-providers.yaml", "configuration/versions.yaml", "Exit status",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("scaffold app --help does not mention %q", want)
		}
	}
}

// treeDigest summarises every file under root (path + content).
func treeDigest(t *testing.T, root string) string {
	t.Helper()
	var b strings.Builder
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		b.WriteString(rel + "\x00" + string(data) + "\x00")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// scaffoldOptionsForTest is a valid helm-pattern invocation in the fixture.
func scaffoldOptionsForTest(root string) scaffold.Options {
	return scaffold.Options{
		RepoRoot: root, Name: "demo", Pattern: scaffold.PatternHelm,
		ChartRepo: "https://charts.example.com/demo", ChartVersion: "1.0.0",
	}
}
