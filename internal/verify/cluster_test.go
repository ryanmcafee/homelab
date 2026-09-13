package verify

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// clusterCmd is one recorded kubectl or chainsaw invocation.
type clusterCmd struct {
	Dir  string
	Name string
	Args []string
}

func (c clusterCmd) line() string { return c.Name + " " + strings.Join(c.Args, " ") }

// fakeClusterRunner implements Runner for the level-1/2 cluster checks. It
// records every invocation and answers kubectl/chainsaw with canned output.
type fakeClusterRunner struct {
	cmds []clusterCmd

	// missing makes LookPath fail for the named binaries.
	missing map[string]bool
	// shimMissing makes every invocation of the named binaries exit non-zero
	// with a mise "No version is set for shim" stderr.
	shimMissing map[string]bool

	// applyStderr makes `kubectl apply ... -f <file>` fail with this stderr,
	// keyed by the file's base name.
	applyStderr map[string]string

	// getStdout/getStderr/getErr answer `kubectl get ...`.
	getStdout string
	getStderr string
	getErr    error

	// chainsawReport, when non-empty, is written to
	// <--report-path>/<--report-name>.json on every chainsaw invocation.
	chainsawReport string
	// chainsawStderr/chainsawErr make chainsaw exit non-zero.
	chainsawStderr string
	chainsawErr    error
}

func (f *fakeClusterRunner) LookPath(name string) (string, error) {
	if f.missing[name] {
		return "", fmt.Errorf("exec: %q: executable file not found in $PATH", name)
	}
	return "/fake/bin/" + name, nil
}

func (f *fakeClusterRunner) Run(_ context.Context, dir, name string, args ...string) ([]byte, []byte, error) {
	f.cmds = append(f.cmds, clusterCmd{Dir: dir, Name: name, Args: append([]string(nil), args...)})
	if f.shimMissing[name] {
		return nil, []byte("mise ERROR No version is set for shim: " + name + "\n"), fmt.Errorf("exit status 1")
	}
	switch name {
	case "kubectl":
		if len(args) > 2 && args[2] == "apply" {
			file := flagValue(args, "-f")
			if stderr, ok := f.applyStderr[filepath.Base(file)]; ok {
				return nil, []byte(stderr), fmt.Errorf("exit status 1")
			}
			return []byte("application.argoproj.io/cilium serverside-applied (server dry run)\napplication.argoproj.io/traefik serverside-applied (server dry run)\n"), nil, nil
		}
		return []byte(f.getStdout), []byte(f.getStderr), f.getErr
	case "chainsaw":
		if f.chainsawReport != "" {
			path := filepath.Join(flagValue(args, "--report-path"), flagValue(args, "--report-name")+".json")
			if err := os.WriteFile(path, []byte(f.chainsawReport), 0o644); err != nil {
				return nil, []byte(err.Error()), err
			}
		}
		return []byte("Running tests...\n"), []byte(f.chainsawStderr), f.chainsawErr
	}
	return nil, []byte("unexpected tool " + name), fmt.Errorf("exit status 127")
}

// flagValue returns the argument following flag, or "".
func flagValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func (f *fakeClusterRunner) invocations(tool string) []clusterCmd {
	var out []clusterCmd
	for _, c := range f.cmds {
		if c.Name == tool {
			out = append(out, c)
		}
	}
	return out
}

func clusterCheck(t *testing.T, checks []Check, name string) Check {
	t.Helper()
	for _, c := range checks {
		if c.Name == name {
			return c
		}
	}
	var names []string
	for _, c := range checks {
		names = append(names, c.Name)
	}
	t.Fatalf("no check named %q among %v", name, names)
	return Check{}
}

// writeLocaldevRender lays out <root>/localdev with the given files.
func writeLocaldevRender(t *testing.T, root string, files map[string]string) string {
	t.Helper()
	dir := filepath.Join(root, "localdev")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

const renderedApp = `---
# Source: addons/templates/cilium.yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cilium
  namespace: argocd
`

func clusterOpts(r Runner, renderDir string) ClusterOptions {
	return ClusterOptions{Runner: r, RepoRoot: "/repo", RenderDir: renderDir, KubeContext: "kind-homelab-localdev", E2EDir: "/repo/tests/e2e"}
}

func TestDryRun(t *testing.T) {
	tests := []struct {
		name        string
		files       map[string]string
		runner      *fakeClusterRunner
		wantNames   []string
		wantStatus  map[string]Status
		wantDetail  map[string]string
		wantKubectl int
	}{
		{
			name:        "kubectl missing is one skip check",
			files:       map[string]string{"addons.yaml": renderedApp},
			runner:      &fakeClusterRunner{missing: map[string]bool{"kubectl": true}},
			wantNames:   []string{"dryrun/localdev"},
			wantStatus:  map[string]Status{"dryrun/localdev": StatusSkip},
			wantDetail:  map[string]string{"dryrun/localdev": ToolMissingDetail("kubectl")},
			wantKubectl: 0,
		},
		{
			name: "every non-empty chart file gets a passing check; empty, comment-only and metadata files are skipped",
			files: map[string]string{
				"addons.yaml":       renderedApp,
				"applications.yaml": renderedApp,
				"empty.yaml":        "",
				"newline.yaml":      "\n",
				"comments.yaml":     "# Source: nothing\n---\n# nothing rendered\n",
				"_data.yaml":        "env: localdev\n",
			},
			runner:      &fakeClusterRunner{},
			wantNames:   []string{"dryrun/localdev/addons", "dryrun/localdev/applications"},
			wantStatus:  map[string]Status{"dryrun/localdev/addons": StatusPass, "dryrun/localdev/applications": StatusPass},
			wantKubectl: 2,
		},
		{
			name:  "a rejected manifest fails its own check and the rest still run",
			files: map[string]string{"addons.yaml": renderedApp, "applications.yaml": renderedApp},
			runner: &fakeClusterRunner{applyStderr: map[string]string{
				"addons.yaml": "Error from server (BadRequest): error when creating \"addons.yaml\": Application in version \"v1alpha1\" cannot be handled\nerror: unknown field \"spec.bogus\"\n",
			}},
			wantNames:   []string{"dryrun/localdev/addons", "dryrun/localdev/applications"},
			wantStatus:  map[string]Status{"dryrun/localdev/addons": StatusFail, "dryrun/localdev/applications": StatusPass},
			wantKubectl: 2,
		},
		{
			name:  "an unreachable cluster is a single dryrun/cluster failure and stops early",
			files: map[string]string{"addons.yaml": renderedApp, "applications.yaml": renderedApp},
			runner: &fakeClusterRunner{applyStderr: map[string]string{
				"addons.yaml": "The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?\n",
			}},
			wantNames:   []string{"dryrun/cluster"},
			wantStatus:  map[string]Status{"dryrun/cluster": StatusFail},
			wantKubectl: 1,
		},
		{
			name:  "a missing kube context is an unreachable cluster",
			files: map[string]string{"addons.yaml": renderedApp},
			runner: &fakeClusterRunner{applyStderr: map[string]string{
				"addons.yaml": "error: context \"kind-homelab-localdev\" does not exist\n",
			}},
			wantNames:   []string{"dryrun/cluster"},
			wantStatus:  map[string]Status{"dryrun/cluster": StatusFail},
			wantKubectl: 1,
		},
		{
			name:        "a mise shim without an installed kubectl is a skip",
			files:       map[string]string{"addons.yaml": renderedApp},
			runner:      &fakeClusterRunner{shimMissing: map[string]bool{"kubectl": true}},
			wantNames:   []string{"dryrun/localdev"},
			wantStatus:  map[string]Status{"dryrun/localdev": StatusSkip},
			wantDetail:  map[string]string{"dryrun/localdev": ToolMissingDetail("kubectl")},
			wantKubectl: 1,
		},
		{
			name:        "no rendered manifests is a failure",
			files:       map[string]string{"_data.yaml": "env: localdev\n"},
			runner:      &fakeClusterRunner{},
			wantNames:   []string{"dryrun/localdev"},
			wantStatus:  map[string]Status{"dryrun/localdev": StatusFail},
			wantKubectl: 0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := writeLocaldevRender(t, t.TempDir(), tc.files)
			checks := DryRun(context.Background(), clusterOpts(tc.runner, root))

			var names []string
			for _, c := range checks {
				names = append(names, c.Name)
			}
			if strings.Join(names, ",") != strings.Join(tc.wantNames, ",") {
				t.Fatalf("check names = %v, want %v", names, tc.wantNames)
			}
			for name, want := range tc.wantStatus {
				if got := clusterCheck(t, checks, name).Status; got != want {
					t.Errorf("%s status = %s, want %s", name, got, want)
				}
			}
			for name, want := range tc.wantDetail {
				if got := clusterCheck(t, checks, name).Detail; got != want {
					t.Errorf("%s detail = %q, want %q", name, got, want)
				}
			}
			if got := len(tc.runner.invocations("kubectl")); got != tc.wantKubectl {
				t.Errorf("kubectl invoked %d time(s), want %d", got, tc.wantKubectl)
			}
		})
	}
}

func TestDryRunArgv(t *testing.T) {
	root := writeLocaldevRender(t, t.TempDir(), map[string]string{"addons.yaml": renderedApp})
	r := &fakeClusterRunner{}
	DryRun(context.Background(), clusterOpts(r, root))

	cmds := r.invocations("kubectl")
	if len(cmds) != 1 {
		t.Fatalf("want 1 kubectl invocation, got %d", len(cmds))
	}
	want := "kubectl --context kind-homelab-localdev apply --server-side --dry-run=server --force-conflicts --field-manager homelab-verify -f " + filepath.Join(root, "localdev", "addons.yaml")
	if got := cmds[0].line(); got != want {
		t.Errorf("argv:\n got %s\nwant %s", got, want)
	}
}

func TestDryRunFindingsAreStderrLinesCappedAtTwenty(t *testing.T) {
	var lines []string
	for i := 0; i < 30; i++ {
		lines = append(lines, fmt.Sprintf("error %02d", i))
	}
	root := writeLocaldevRender(t, t.TempDir(), map[string]string{"addons.yaml": renderedApp})
	r := &fakeClusterRunner{applyStderr: map[string]string{"addons.yaml": strings.Join(lines, "\n") + "\n\n"}}

	checks := DryRun(context.Background(), clusterOpts(r, root))
	c := clusterCheck(t, checks, "dryrun/localdev/addons")
	if c.Status != StatusFail {
		t.Fatalf("want fail, got %s", c.Status)
	}
	if len(c.Findings) != 20 {
		t.Fatalf("want 20 findings, got %d: %v", len(c.Findings), c.Findings)
	}
	if c.Findings[0] != "error 00" || c.Findings[19] != "error 19" {
		t.Errorf("findings must be the first stderr lines in order, got %v", c.Findings)
	}
	if !strings.Contains(c.Detail, "30 line") {
		t.Errorf("detail should count the stderr lines, got %q", c.Detail)
	}
}

const argoAppsJSON = `{
  "apiVersion": "v1",
  "kind": "List",
  "items": [
    {
      "metadata": {"name": "cilium", "namespace": "argocd"},
      "status": {
        "sync": {"status": "Synced"},
        "health": {"status": "Healthy"},
        "operationState": {"phase": "Succeeded", "message": "successfully synced (all tasks run)"},
        "resources": [
          {"kind": "DaemonSet", "namespace": "kube-system", "name": "cilium", "health": {"status": "Healthy"}},
          {"kind": "ConfigMap", "namespace": "kube-system", "name": "cilium-config"}
        ]
      }
    },
    {
      "metadata": {"name": "plex", "namespace": "argocd"},
      "status": {
        "sync": {"status": "OutOfSync"},
        "health": {"status": "Degraded", "message": "one or more objects failed"},
        "operationState": {"phase": "Failed", "message": "one or more objects failed to apply"},
        "conditions": [
          {"type": "SyncError", "message": "Failed sync attempt: PersistentVolumeClaim \"plex-config\" is invalid"}
        ],
        "resources": [
          {"kind": "Deployment", "namespace": "media", "name": "plex", "health": {"status": "Progressing", "message": "Waiting for rollout"}},
          {"kind": "PersistentVolumeClaim", "namespace": "media", "name": "plex-config", "health": {"status": "Degraded", "message": "no storage class"}},
          {"kind": "Service", "namespace": "media", "name": "plex", "health": {"status": "Healthy"}}
        ]
      }
    },
    {
      "metadata": {"name": "sonarr", "namespace": "argocd"},
      "status": {
        "sync": {"status": "Synced"},
        "health": {"status": "Healthy"}
      }
    }
  ]
}`

func TestArgoCDApps(t *testing.T) {
	r := &fakeClusterRunner{getStdout: argoAppsJSON}
	checks := ArgoCDApps(context.Background(), clusterOpts(r, t.TempDir()))

	if len(checks) != 3 {
		t.Fatalf("want 3 checks (one per Application), got %d: %+v", len(checks), checks)
	}

	cilium := clusterCheck(t, checks, "argocd/cilium")
	if cilium.Status != StatusPass {
		t.Errorf("cilium: want pass, got %s (%v)", cilium.Status, cilium.Findings)
	}
	if cilium.Detail != "sync=Synced health=Healthy op=Succeeded" {
		t.Errorf("cilium detail = %q", cilium.Detail)
	}
	if len(cilium.Findings) != 0 {
		t.Errorf("a healthy app must have no findings, got %v", cilium.Findings)
	}

	plex := clusterCheck(t, checks, "argocd/plex")
	if plex.Status != StatusFail {
		t.Errorf("plex: want fail, got %s", plex.Status)
	}
	if plex.Detail != "sync=OutOfSync health=Degraded op=Failed" {
		t.Errorf("plex detail = %q", plex.Detail)
	}
	wantFindings := []string{
		`SyncError: Failed sync attempt: PersistentVolumeClaim "plex-config" is invalid`,
		"Deployment/media/plex: Progressing Waiting for rollout",
		"PersistentVolumeClaim/media/plex-config: Degraded no storage class",
		"operation Failed: one or more objects failed to apply",
	}
	if strings.Join(plex.Findings, "\n") != strings.Join(wantFindings, "\n") {
		t.Errorf("plex findings:\n got %q\nwant %q", plex.Findings, wantFindings)
	}

	// Healthy but never synced (no operationState at all) is not a pass:
	// the sync loop has not run for it.
	sonarr := clusterCheck(t, checks, "argocd/sonarr")
	if sonarr.Status != StatusFail {
		t.Errorf("sonarr: want fail without an operation, got %s", sonarr.Status)
	}
	if sonarr.Detail != "sync=Synced health=Healthy op=" {
		t.Errorf("sonarr detail = %q", sonarr.Detail)
	}

	cmds := r.invocations("kubectl")
	if len(cmds) != 1 {
		t.Fatalf("want 1 kubectl invocation, got %d", len(cmds))
	}
	want := "kubectl --context kind-homelab-localdev get applications.argoproj.io -n argocd -o json"
	if got := cmds[0].line(); got != want {
		t.Errorf("argv:\n got %s\nwant %s", got, want)
	}
}

func TestArgoCDAppsFailureModes(t *testing.T) {
	tests := []struct {
		name       string
		runner     *fakeClusterRunner
		wantStatus Status
		wantDetail string
	}{
		{
			name:       "kubectl missing is a skip",
			runner:     &fakeClusterRunner{missing: map[string]bool{"kubectl": true}},
			wantStatus: StatusSkip,
			wantDetail: ToolMissingDetail("kubectl"),
		},
		{
			name:       "mise shim without kubectl is a skip",
			runner:     &fakeClusterRunner{shimMissing: map[string]bool{"kubectl": true}},
			wantStatus: StatusSkip,
			wantDetail: ToolMissingDetail("kubectl"),
		},
		{
			name:       "zero Applications is a failure pointing at task localdev:up",
			runner:     &fakeClusterRunner{getStdout: `{"items":[]}`},
			wantStatus: StatusFail,
			wantDetail: "no Applications in namespace argocd (run task localdev:up)",
		},
		{
			name: "an unreachable cluster is a failure",
			runner: &fakeClusterRunner{
				getStderr: "Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused\n",
				getErr:    fmt.Errorf("exit status 1"),
			},
			wantStatus: StatusFail,
			wantDetail: "cluster unreachable via kube context kind-homelab-localdev",
		},
		{
			name:       "unparseable output is a failure",
			runner:     &fakeClusterRunner{getStdout: "not json"},
			wantStatus: StatusFail,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			checks := ArgoCDApps(context.Background(), clusterOpts(tc.runner, t.TempDir()))
			if len(checks) != 1 {
				t.Fatalf("want exactly 1 check, got %d: %+v", len(checks), checks)
			}
			c := checks[0]
			if c.Name != "argocd/apps" {
				t.Errorf("name = %q, want argocd/apps", c.Name)
			}
			if c.Status != tc.wantStatus {
				t.Errorf("status = %s, want %s (detail %q)", c.Status, tc.wantStatus, c.Detail)
			}
			if tc.wantDetail != "" && c.Detail != tc.wantDetail {
				t.Errorf("detail = %q, want %q", c.Detail, tc.wantDetail)
			}
			if tc.wantDetail == "" && c.Detail == "" {
				t.Error("want a non-empty detail")
			}
		})
	}
}

// chainsawReportJSON is the shape `chainsaw test --report-format JSON`
// (v0.2.15) writes: tests[] -> steps[] -> operations[], each carrying
// status "passed"/"failed" and, on failure, failure.error.
const chainsawReportJSON = `{
  "name": "chainsaw-report",
  "startTime": "2026-09-12T23:09:04.398482-05:00",
  "endTime": "2026-09-12T23:09:04.417892-05:00",
  "tests": [
    {
      "basePath": "/repo/tests/e2e/grafana",
      "name": "grafana",
      "status": "passed",
      "startTime": "2026-09-12T23:09:04.399892-05:00",
      "endTime": "2026-09-12T23:09:04.411690-05:00",
      "steps": [
        {
          "name": "application-healthy",
          "status": "passed",
          "startTime": "2026-09-12T23:09:04.399905-05:00",
          "endTime": "2026-09-12T23:09:04.411689-05:00",
          "operations": [
            {"name": "operation 1", "type": "assert", "status": "passed",
             "startTime": "2026-09-12T23:09:04.400581-05:00", "endTime": "2026-09-12T23:09:04.411678-05:00"}
          ]
        }
      ]
    },
    {
      "basePath": "/repo/tests/e2e/plex",
      "name": "plex",
      "status": "failed",
      "startTime": "2026-09-12T23:09:04.399877-05:00",
      "endTime": "2026-09-12T23:09:05.917803-05:00",
      "steps": [
        {
          "name": "application-healthy",
          "status": "passed",
          "startTime": "2026-09-12T23:09:04.399887-05:00",
          "endTime": "2026-09-12T23:09:04.411727-05:00",
          "operations": [
            {"name": "operation 1", "type": "assert", "status": "passed",
             "startTime": "2026-09-12T23:09:04.400585-05:00", "endTime": "2026-09-12T23:09:04.411711-05:00"}
          ]
        },
        {
          "name": "curl-identity",
          "status": "failed",
          "startTime": "2026-09-12T23:09:04.411729-05:00",
          "endTime": "2026-09-12T23:09:05.917800-05:00",
          "operations": [
            {"name": "operation 1", "type": "apply", "status": "passed",
             "startTime": "2026-09-12T23:09:04.411767-05:00", "endTime": "2026-09-12T23:09:04.517772-05:00"},
            {"name": "operation 2", "type": "assert", "status": "failed",
             "startTime": "2026-09-12T23:09:04.517772-05:00", "endTime": "2026-09-12T23:09:05.917772-05:00",
             "failure": {"error": "batch/v1/Job @ chainsaw-abc/curl-plex: status.succeeded: Invalid value: 0: Expected value: 1"}}
          ]
        }
      ]
    }
  ]
}`

func writeChainsawConfig(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "tests", "e2e")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".chainsaw.yaml"), []byte("apiVersion: chainsaw.kyverno.io/v1alpha2\nkind: Configuration\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestChainsawReportBecomesOneCheckPerTest(t *testing.T) {
	e2e := writeChainsawConfig(t)
	r := &fakeClusterRunner{chainsawReport: chainsawReportJSON, chainsawStderr: "Error: some tests failed\n", chainsawErr: fmt.Errorf("exit status 1")}
	opts := clusterOpts(r, t.TempDir())
	opts.E2EDir = e2e
	checks := Chainsaw(context.Background(), opts)

	if len(checks) != 2 {
		t.Fatalf("want 2 checks, got %d: %+v", len(checks), checks)
	}
	grafana := clusterCheck(t, checks, "e2e/grafana")
	if grafana.Status != StatusPass {
		t.Errorf("grafana: want pass, got %s", grafana.Status)
	}
	if grafana.Detail != "1 step(s) passed" {
		t.Errorf("grafana detail = %q", grafana.Detail)
	}
	plex := clusterCheck(t, checks, "e2e/plex")
	if plex.Status != StatusFail {
		t.Errorf("plex: want fail, got %s", plex.Status)
	}
	if plex.Detail != "1 of 2 step(s) failed" {
		t.Errorf("plex detail = %q", plex.Detail)
	}
	wantFindings := []string{
		"curl-identity: assert (operation 2): batch/v1/Job @ chainsaw-abc/curl-plex: status.succeeded: Invalid value: 0: Expected value: 1",
	}
	if strings.Join(plex.Findings, "\n") != strings.Join(wantFindings, "\n") {
		t.Errorf("plex findings:\n got %q\nwant %q", plex.Findings, wantFindings)
	}
	if plex.DurationMS < 1500 || plex.DurationMS > 1600 {
		t.Errorf("plex duration should come from the report timestamps (~1518ms), got %d", plex.DurationMS)
	}

	cmds := r.invocations("chainsaw")
	if len(cmds) != 1 {
		t.Fatalf("want 1 chainsaw invocation, got %d", len(cmds))
	}
	if cmds[0].Dir != "/repo" {
		t.Errorf("chainsaw must run from the repo root, ran in %q", cmds[0].Dir)
	}
	line := cmds[0].line()
	for _, want := range []string{
		"chainsaw test --config " + filepath.Join(e2e, ".chainsaw.yaml") + " " + e2e + " ",
		"--report-format JSON",
		"--report-name report",
		"--report-path ",
		"--no-color",
		"--kube-context kind-homelab-localdev",
	} {
		if !strings.Contains(line, want) {
			t.Errorf("argv %q does not contain %q", line, want)
		}
	}
	// The report directory is temporary and must be removed afterwards.
	if dir := flagValue(cmds[0].Args, "--report-path"); dir != "" {
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("report dir %s should be removed after parsing (stat err: %v)", dir, err)
		}
	}
}

func TestChainsawFailureModes(t *testing.T) {
	tests := []struct {
		name         string
		runner       *fakeClusterRunner
		wantStatus   Status
		wantDetail   string
		wantFindings []string
	}{
		{
			name:       "chainsaw missing is a skip",
			runner:     &fakeClusterRunner{missing: map[string]bool{"chainsaw": true}},
			wantStatus: StatusSkip,
			wantDetail: ToolMissingDetail("chainsaw"),
		},
		{
			name:       "mise shim without chainsaw is a skip",
			runner:     &fakeClusterRunner{shimMissing: map[string]bool{"chainsaw": true}},
			wantStatus: StatusSkip,
			wantDetail: ToolMissingDetail("chainsaw"),
		},
		{
			name: "non-zero exit without a report fails with the stderr tail",
			runner: &fakeClusterRunner{
				chainsawStderr: "line 1\nline 2\nError: failed to load kube config: context \"kind-homelab-localdev\" does not exist\n",
				chainsawErr:    fmt.Errorf("exit status 1"),
			},
			wantStatus:   StatusFail,
			wantDetail:   "chainsaw exited with exit status 1 and wrote no report",
			wantFindings: []string{"line 1", "line 2", `Error: failed to load kube config: context "kind-homelab-localdev" does not exist`},
		},
		{
			name:       "a report with no tests is a failure",
			runner:     &fakeClusterRunner{chainsawReport: `{"name":"chainsaw-report","tests":[]}`},
			wantStatus: StatusFail,
		},
		{
			name:       "an unparseable report is a failure",
			runner:     &fakeClusterRunner{chainsawReport: `{"tests": [`},
			wantStatus: StatusFail,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			opts := clusterOpts(tc.runner, t.TempDir())
			opts.E2EDir = writeChainsawConfig(t)
			checks := Chainsaw(context.Background(), opts)
			if len(checks) != 1 {
				t.Fatalf("want exactly 1 check, got %d: %+v", len(checks), checks)
			}
			c := checks[0]
			if c.Name != "e2e/chainsaw" {
				t.Errorf("name = %q, want e2e/chainsaw", c.Name)
			}
			if c.Status != tc.wantStatus {
				t.Errorf("status = %s, want %s (detail %q)", c.Status, tc.wantStatus, c.Detail)
			}
			if tc.wantDetail != "" && c.Detail != tc.wantDetail {
				t.Errorf("detail = %q, want %q", c.Detail, tc.wantDetail)
			}
			if tc.wantDetail == "" && c.Detail == "" {
				t.Error("want a non-empty detail")
			}
			if tc.wantFindings != nil && strings.Join(c.Findings, "\n") != strings.Join(tc.wantFindings, "\n") {
				t.Errorf("findings:\n got %q\nwant %q", c.Findings, tc.wantFindings)
			}
		})
	}
}

func TestChainsawResolvesRelativeE2EDirAgainstRepoRoot(t *testing.T) {
	repo := t.TempDir()
	e2e := filepath.Join(repo, "tests", "e2e")
	if err := os.MkdirAll(e2e, 0o755); err != nil {
		t.Fatal(err)
	}
	// No .chainsaw.yaml here: --config must then be omitted so chainsaw
	// falls back to its defaults instead of failing on a missing file.
	r := &fakeClusterRunner{chainsawReport: chainsawReportJSON}
	opts := ClusterOptions{Runner: r, RepoRoot: repo, RenderDir: t.TempDir(), KubeContext: "kind-homelab-localdev", E2EDir: "tests/e2e"}
	Chainsaw(context.Background(), opts)

	cmds := r.invocations("chainsaw")
	if len(cmds) != 1 {
		t.Fatalf("want 1 chainsaw invocation, got %d", len(cmds))
	}
	line := cmds[0].line()
	if !strings.HasPrefix(line, "chainsaw test "+e2e+" ") {
		t.Errorf("argv %q should start with the absolute test dir and no --config", line)
	}
	if strings.Contains(line, "--config") {
		t.Errorf("argv %q must not pass --config when .chainsaw.yaml is absent", line)
	}
}

func TestIsClusterUnreachable(t *testing.T) {
	tests := []struct {
		stderr string
		want   bool
	}{
		{"The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?", true},
		{"Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused", true},
		{"Unable to connect to the server: dial tcp: lookup kind-control-plane: no such host", true},
		{`error: context "kind-homelab-localdev" does not exist`, true},
		{"Error from server (NotFound): namespaces \"argocd\" not found", false},
		{"error: unknown field \"spec.bogus\"", false},
		{"", false},
	}
	for _, tc := range tests {
		if got := isClusterUnreachable([]byte(tc.stderr)); got != tc.want {
			t.Errorf("isClusterUnreachable(%q) = %v, want %v", tc.stderr, got, tc.want)
		}
	}
}

func TestHasYAMLDocument(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"empty", "", false},
		{"single newline", "\n", false},
		{"only separators", "---\n---\n", false},
		{"only comments", "# Source: x\n# nothing\n", false},
		{"comments and separators", "---\n# Source: addons/templates/x.yaml\n", false},
		{"one object", renderedApp, true},
		{"object without leading separator", "kind: ConfigMap\n", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasYAMLDocument([]byte(tc.in)); got != tc.want {
				t.Errorf("hasYAMLDocument(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
