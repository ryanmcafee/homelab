package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// gateWorkflow writes body to .github/workflows/verify.yml in a temp repo root
// and returns that root.
func gateWorkflow(t *testing.T, body string) string {
	t.Helper()
	root := t.TempDir()
	path := filepath.Join(root, filepath.FromSlash(VerifyWorkflowPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// gateResult wraps MergeResultGate's checks so checkByName reads them.
func gateResult(root string) *Result {
	res := NewResult(0)
	res.Add(MergeResultGate(root)...)
	return res
}

// goodGate is the shape the guard is meant to accept: a bare checkout under a
// `pull_request` trigger with no paths filter. Every negative fixture below is
// this file with exactly one thing changed.
const goodGate = `name: Verify (level 0)

on:
  pull_request:
  push:
    branches: [main]
    paths:
      - 'charts/**'

jobs:
  level-0:
    name: Level 0 (render, schema, gitops, snapshot, policy)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
      - name: task verify (level 0)
        run: task verify
`

func TestMergeResultGateAcceptsABareCheckout(t *testing.T) {
	for _, c := range MergeResultGate(gateWorkflow(t, goodGate)) {
		if c.Status != StatusPass {
			t.Errorf("%s: %s — %s%v", c.Name, c.Status, c.Detail, c.Findings)
		}
	}
}

// The regression this whole file exists for: the ref pin that leaves every check
// green. The rule id is asserted, not just a non-zero verdict — a mutation that
// dies somewhere else (the YAML loader, the floor rule) would otherwise read as
// this rule firing.
func TestMergeResultGateRejectsAPinnedRef(t *testing.T) {
	body := strings.Replace(goodGate,
		"      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n",
		"      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n"+
			"        with:\n"+
			"          ref: ${{ github.event.pull_request.head.sha }}\n", 1)
	res := gateResult(gateWorkflow(t, body))

	c := checkByName(t, res, gateRefCheck)
	if c.Status != StatusFail {
		t.Fatalf("%s: want fail, got %s: %q", gateRefCheck, c.Status, c.Detail)
	}
	if len(c.Findings) != 1 || !strings.Contains(c.Findings[0], "pins `ref:") {
		t.Fatalf("%s findings do not name the pin: %v", gateRefCheck, c.Findings)
	}
	// The floor must still pass: the job WAS found, which is what makes the
	// failure above a real verdict on a real step rather than a parse accident.
	if f := checkByName(t, res, gateFloorCheck); f.Status != StatusPass {
		t.Errorf("%s: want pass, got %s: %q", gateFloorCheck, f.Status, f.Detail)
	}
}

// A `with:` block the step legitimately needs is not a ref pin.
func TestMergeResultGateAllowsWithWithoutRef(t *testing.T) {
	body := strings.Replace(goodGate,
		"      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n",
		"      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n"+
			"        with:\n"+
			"          fetch-depth: 0\n", 1)
	if c := checkByName(t, gateResult(gateWorkflow(t, body)), gateRefCheck); c.Status != StatusPass {
		t.Fatalf("%s: want pass, got %s: %q%v", gateRefCheck, c.Status, c.Detail, c.Findings)
	}
}

// A second checkout added later is checked too; only the first being bare is not
// enough, because the last checkout is the one the working tree ends up at.
func TestMergeResultGateRejectsAPinOnASecondCheckout(t *testing.T) {
	body := strings.Replace(goodGate,
		"      - name: task verify (level 0)\n",
		"      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n"+
			"        with:\n"+
			"          ref: ${{ github.event.pull_request.head.sha }}\n"+
			"      - name: task verify (level 0)\n", 1)
	res := gateResult(gateWorkflow(t, body))
	c := checkByName(t, res, gateRefCheck)
	if c.Status != StatusFail {
		t.Fatalf("%s: want fail, got %s: %q", gateRefCheck, c.Status, c.Detail)
	}
	if len(c.Findings) != 1 || !strings.Contains(c.Findings[0], "step 2") {
		t.Fatalf("%s should name the second step: %v", gateRefCheck, c.Findings)
	}
}

func TestMergeResultGateRejectsAPathsFilterOnPullRequest(t *testing.T) {
	body := strings.Replace(goodGate, "  pull_request:\n",
		"  pull_request:\n    paths:\n      - 'charts/**'\n", 1)
	res := gateResult(gateWorkflow(t, body))
	c := checkByName(t, res, gatePathsCheck)
	if c.Status != StatusFail {
		t.Fatalf("%s: want fail, got %s: %q", gatePathsCheck, c.Status, c.Detail)
	}
	if len(c.Findings) != 1 || !strings.Contains(c.Findings[0], "on.pull_request.paths") {
		t.Fatalf("%s findings do not name the filter: %v", gatePathsCheck, c.Findings)
	}
	// The push trigger keeps its own paths filter; only pull_request is checked.
	if r := checkByName(t, res, gateRefCheck); r.Status != StatusPass {
		t.Errorf("%s: want pass, got %s", gateRefCheck, r.Status)
	}
}

func TestMergeResultGateRejectsPathsIgnoreOnPullRequest(t *testing.T) {
	body := strings.Replace(goodGate, "  pull_request:\n",
		"  pull_request:\n    paths-ignore:\n      - 'docs/**'\n", 1)
	c := checkByName(t, gateResult(gateWorkflow(t, body)), gatePathsCheck)
	if c.Status != StatusFail || !strings.Contains(strings.Join(c.Findings, " "), "paths-ignore") {
		t.Fatalf("%s: want a paths-ignore failure, got %s %v", gatePathsCheck, c.Status, c.Findings)
	}
}

// A `pull_request:` with a body that carries no path filter (types, branches) is
// the correct state and must not fail.
func TestMergeResultGateAllowsPullRequestTypes(t *testing.T) {
	body := strings.Replace(goodGate, "  pull_request:\n",
		"  pull_request:\n    types: [opened, synchronize, reopened]\n", 1)
	if c := checkByName(t, gateResult(gateWorkflow(t, body)), gatePathsCheck); c.Status != StatusPass {
		t.Fatalf("%s: want pass, got %s: %q%v", gatePathsCheck, c.Status, c.Detail, c.Findings)
	}
}

// Everything below is the vacuous-green family: the guard stopped being pointed
// at the job it guards. Each one must emit the floor rule as a failure and must
// NOT emit the two rules, so a green can never be produced by a parse that found
// nothing.
func TestMergeResultGateFailsClosedWhenTheJobIsNotFound(t *testing.T) {
	for name, body := range map[string]string{
		"job key renamed":  strings.Replace(goodGate, "  level-0:\n", "  level-zero:\n", 1),
		"job name changed": strings.Replace(goodGate, Level0ContextName, "Level 0", 1),
		"no checkout step": strings.Replace(goodGate,
			"      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n", "", 1),
		"checkout replaced": strings.Replace(goodGate,
			"uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7",
			"uses: some-fork/checkout@v7", 1),
		"no jobs":         "name: Verify (level 0)\non:\n  pull_request:\n",
		"no pull_request": strings.Replace(goodGate, "  pull_request:\n", "", 1),
		"no on":           strings.Replace(goodGate, "on:\n  pull_request:\n", "", 1),
		"unparseable":     goodGate + "\t- this is a tab, which YAML rejects\n",
		"empty":           "",
	} {
		t.Run(name, func(t *testing.T) {
			checks := MergeResultGate(gateWorkflow(t, body))
			if len(checks) != 1 {
				t.Fatalf("want only the floor check, got %d: %v", len(checks), checks)
			}
			if checks[0].Name != gateFloorCheck || checks[0].Status != StatusFail {
				t.Fatalf("want %s to fail, got %s %s", gateFloorCheck, checks[0].Name, checks[0].Status)
			}
		})
	}
}

func TestMergeResultGateFailsWhenTheWorkflowIsMissing(t *testing.T) {
	checks := MergeResultGate(t.TempDir())
	if len(checks) != 1 || checks[0].Name != gateFloorCheck || checks[0].Status != StatusFail {
		t.Fatalf("want a single failing %s, got %v", gateFloorCheck, checks)
	}
}

// The guard is only real if the file it guards passes it. Without this the rules
// above can be committed green against fixtures while verify.yml on main already
// carries the pin.
func TestMergeResultGatePassesOnTheCommittedVerifyWorkflow(t *testing.T) {
	root, err := FindRepoRoot(mustGetwd(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range MergeResultGate(root) {
		if c.Status != StatusPass {
			t.Errorf("%s on %s: %s — %s%v", c.Name, VerifyWorkflowPath, c.Status, c.Detail, c.Findings)
		}
	}
}

// The pre-commit `verify-level-0` hook and CI must agree on when level 0 runs.
// CI's pull_request trigger has no paths filter (gatePathsCheck above asserts
// that), so it runs on every file; the hook has a `files:` regex and would
// silently not run on a commit that touches only verify.yml — which is exactly
// the commit this guard exists to catch. ADR-037's standing condition is that
// the two scopes move together, so the coupling is asserted rather than
// remembered.
func TestPreCommitLevel0HookScopeCoversTheGuardedWorkflow(t *testing.T) {
	root, err := FindRepoRoot(mustGetwd(t))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".pre-commit-config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	// The hook's `files:` regex is matched by pre-commit against repo-relative
	// paths; assert the literal path fragment is present rather than compiling
	// the regex, because the regex is written for Python's re and this only needs
	// to know that verify.yml was not forgotten.
	if !strings.Contains(string(data), `\.github/workflows/verify\.yml$`) {
		t.Errorf(".pre-commit-config.yaml `verify-level-0` hook does not admit %s, so a commit that only pins the ref would skip the hook that catches it", VerifyWorkflowPath)
	}
}
