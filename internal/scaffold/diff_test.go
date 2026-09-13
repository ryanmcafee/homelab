package scaffold

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileDiff(t *testing.T) {
	tests := []struct {
		name string
		c    Change
		want string
	}{
		{
			name: "new file",
			c:    Change{Path: "a/b.yaml", New: []byte("x: 1\ny: 2\n")},
			want: "diff --git a/a/b.yaml b/a/b.yaml\nnew file mode 100644\n--- /dev/null\n+++ b/a/b.yaml\n@@ -0,0 +1,2 @@\n+x: 1\n+y: 2\n",
		},
		{
			name: "insertion in the middle keeps three lines of context",
			c: Change{Path: "v.yaml",
				Old: []byte("1\n2\n3\n4\n5\n6\n7\n8\n"),
				New: []byte("1\n2\n3\n4\nNEW\n5\n6\n7\n8\n")},
			want: "diff --git a/v.yaml b/v.yaml\n--- a/v.yaml\n+++ b/v.yaml\n@@ -2,6 +2,7 @@\n 2\n 3\n 4\n+NEW\n 5\n 6\n 7\n",
		},
		{
			name: "append to a file without a final newline",
			c:    Change{Path: "t", Old: []byte("a\nb"), New: []byte("a\nb\nc\n")},
			want: "diff --git a/t b/t\n--- a/t\n+++ b/t\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n",
		},
		{
			name: "two distant insertions make two hunks",
			c: Change{Path: "h",
				Old: []byte("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n"),
				New: []byte("A\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\nB\n")},
			want: "diff --git a/h b/h\n--- a/h\n+++ b/h\n@@ -1,3 +1,4 @@\n+A\n 1\n 2\n 3\n@@ -10,3 +11,4 @@\n 10\n 11\n 12\n+B\n",
		},
		{
			name: "unchanged file renders nothing",
			c:    Change{Path: "same", Old: []byte("a\n"), New: []byte("a\n")},
			want: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := fileDiff(tc.c); got != tc.want {
				t.Errorf("got:\n%s\nwant:\n%s", got, tc.want)
			}
		})
	}
}

// TestDiffAppliesWithGitApply proves the --dry-run patch is exactly the
// change Apply writes: applying it with git apply to a copy of the original
// files yields the same bytes.
func TestDiffAppliesWithGitApply(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	changes := []Change{
		{Path: "new/dir/file.yaml", New: []byte("a: 1\n")},
		{Path: "edit.yaml", Old: []byte("x\ny\nz\n"), New: []byte("x\ny\nINS\nz\n")},
		{Path: "tail.txt", Old: []byte("no newline"), New: []byte("no newline\nmore\n")},
	}
	dir := t.TempDir()
	for _, c := range changes {
		if c.Old != nil {
			if err := os.WriteFile(filepath.Join(dir, c.Path), c.Old, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	patch := filepath.Join(t.TempDir(), "p.diff")
	if err := os.WriteFile(patch, []byte(DiffChanges(changes)), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "apply", "--unsafe-paths", patch)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git apply: %v\n%s\npatch:\n%s", err, out, DiffChanges(changes))
	}
	for _, c := range changes {
		got, err := os.ReadFile(filepath.Join(dir, c.Path))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(c.New) {
			t.Errorf("%s after git apply = %q, want %q", c.Path, got, c.New)
		}
	}
	if !strings.Contains(DiffChanges(changes), "new file mode 100644") {
		t.Error("a created file must carry the git new-file header")
	}
}
