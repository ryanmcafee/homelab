package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRequiredContexts(t *testing.T) {
	cases := []struct {
		name, workflow, wantFinding string
	}{
		{"reachable", "on:\n  pull_request:\njobs:\n  gate:\n    name: Required gate\n", ""},
		{"job condition", "on:\n  pull_request:\njobs:\n  gate:\n    name: Required gate\n    if: github.ref == 'refs/heads/main'\n", "job-level if"},
		{"filtered trigger", "on:\n  pull_request:\n    paths: [charts/**]\njobs:\n  gate:\n    name: Required gate\n", "paths filter"},
		{"filtered trigger inverse", "on:\n  pull_request:\n    paths-ignore: [docs/**]\njobs:\n  gate:\n    name: Required gate\n", "paths-ignore filter"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeGateFixture(t, root, requiredContextsPath, "required:\n  - name: Required gate\n    workflow: gate.yml\n    job: gate\n")
			writeGateFixture(t, root, ".github/workflows/gate.yml", tc.workflow)
			got := RequiredContexts(root)
			if tc.wantFinding == "" {
				if got.Status != StatusPass {
					t.Fatalf("good workflow failed: %+v", got)
				}
				return
			}
			if got.Status != StatusFail || !strings.Contains(strings.Join(got.Findings, "\n"), tc.wantFinding) {
				t.Fatalf("bad workflow did not report %q: %+v", tc.wantFinding, got)
			}
		})
	}
}

func TestCommittedRequiredContexts(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root, err := FindRepoRoot(cwd)
	if err != nil {
		t.Fatal(err)
	}
	if got := RequiredContexts(root); got.Status != StatusPass {
		t.Fatalf("documented required contexts are unreachable: %+v", got)
	}
}

func writeGateFixture(t *testing.T, root, relative, data string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}
