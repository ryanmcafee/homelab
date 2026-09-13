package verify

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// maxDiffLines caps a single snapshot diff so a large drift does not bury the
// rest of the JSON result.
const maxDiffLines = 200

// snapshotUpdateHint is the exact remediation string every missing or drifted
// snapshot carries.
const snapshotUpdateHint = "run: task test:snapshot -- --update"

// Snapshot compares rendered manifests against golden snapshots at
// <snapshotDir>/<env>/<chart>.yaml. Snapshots are the exact rendered bytes:
// nothing is normalised, so any drift in helm output is visible.
//
// files maps env -> chart -> rendered file path (RenderOutput.Files), which
// makes Snapshot a pure function of paths. With update set, snapshots are
// written instead of compared. The returned error covers filesystem failures
// while writing snapshots; per-chart problems are reported as failing checks.
func Snapshot(files map[string]map[string]string, snapshotDir string, update bool) ([]Check, error) {
	if snapshotDir == "" {
		return nil, fmt.Errorf("snapshot directory is required")
	}

	var checks []Check
	for _, env := range sortedKeys(files) {
		charts := files[env]
		for _, chart := range sortedKeys(charts) {
			check, err := snapshotOne(env, chart, charts[chart], snapshotDir, update)
			if err != nil {
				return checks, err
			}
			checks = append(checks, check)
		}
	}
	return checks, nil
}

func snapshotOne(env, chart, renderedPath, snapshotDir string, update bool) (Check, error) {
	name := fmt.Sprintf("snapshot/%s/%s", env, chart)
	start := time.Now()
	snapPath := filepath.Join(snapshotDir, env, chart+".yaml")

	got, err := os.ReadFile(renderedPath)
	if err != nil {
		return FailCheck(name, start, fmt.Sprintf("reading rendered manifest: %v", err)), nil
	}

	want, readErr := os.ReadFile(snapPath)

	if update {
		if readErr == nil && bytes.Equal(want, got) {
			return PassCheck(name, start, "unchanged"), nil
		}
		if err := os.MkdirAll(filepath.Dir(snapPath), 0o755); err != nil {
			return Check{}, fmt.Errorf("creating %s: %w", filepath.Dir(snapPath), err)
		}
		if err := os.WriteFile(snapPath, got, 0o644); err != nil {
			return Check{}, fmt.Errorf("writing %s: %w", snapPath, err)
		}
		return PassCheck(name, start, fmt.Sprintf("written (%d bytes)", len(got))), nil
	}

	if readErr != nil {
		if os.IsNotExist(readErr) {
			return FailCheck(name, start,
				fmt.Sprintf("no snapshot at %s; %s", filepath.ToSlash(snapPath), snapshotUpdateHint)), nil
		}
		return FailCheck(name, start, fmt.Sprintf("reading snapshot: %v", readErr)), nil
	}

	if bytes.Equal(want, got) {
		return PassCheck(name, start, fmt.Sprintf("%d bytes match", len(got))), nil
	}

	diff := UnifiedDiff(env+"/"+chart, want, got)
	return FailCheck(name, start,
		fmt.Sprintf("rendered output differs from %s; %s", filepath.ToSlash(snapPath), snapshotUpdateHint),
		strings.Split(strings.TrimRight(diff, "\n"), "\n")...), nil
}

// ExpectedSnapshots maps each env to the charts it renders (Env.Renders), the
// set OrphanSnapshots judges a snapshot directory against. A chart-restricted
// env such as homelab-preview expects only its own charts, so a stray
// snapshot of any other chart under its directory is reported.
func ExpectedSnapshots(envs []Env, charts []Chart) map[string][]string {
	expected := map[string][]string{}
	for _, env := range envs {
		for _, c := range charts {
			if env.Renders(c.Name) {
				expected[env.Name] = append(expected[env.Name], c.Name)
			}
		}
	}
	return expected
}

// OrphanMode says what to do with a snapshot that has no chart.
type OrphanMode int

const (
	// OrphanReport fails the check and leaves the file alone.
	OrphanReport OrphanMode = iota
	// OrphanPrune deletes the file and passes the check.
	OrphanPrune
	// OrphanKeep fails the check and records that the file was deliberately
	// not deleted. An --update run whose render did not fully succeed must
	// never remove a snapshot: a chart that failed to render looks exactly
	// like a chart that was deleted.
	OrphanKeep
)

// OrphanSnapshots reports snapshot files with no corresponding chart, which is
// what a deleted or renamed chart leaves behind.
//
// expected maps env to the chart names the pass covered. It comes from chart
// discovery, not from the rendered-file map: a chart that fails to render
// produces no file, and treating that as an orphan would delete a perfectly
// good snapshot. Only envs present in expected are examined, so an env the
// caller did not render is untouched.
func OrphanSnapshots(expected map[string][]string, snapshotDir string, mode OrphanMode) ([]Check, error) {
	if snapshotDir == "" {
		return nil, fmt.Errorf("snapshot directory is required")
	}

	var checks []Check
	for _, env := range sortedKeys(expected) {
		entries, err := os.ReadDir(filepath.Join(snapshotDir, env))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return checks, fmt.Errorf("reading snapshot directory for %s: %w", env, err)
		}

		known := make(map[string]bool, len(expected[env]))
		for _, chart := range expected[env] {
			known[chart] = true
		}

		var orphans []string
		for _, e := range entries {
			fname := e.Name()
			if e.IsDir() || !strings.HasSuffix(fname, ".yaml") {
				continue
			}
			chart := strings.TrimSuffix(fname, ".yaml")
			if !known[chart] {
				orphans = append(orphans, chart)
			}
		}
		sort.Strings(orphans)

		for _, chart := range orphans {
			start := time.Now()
			name := fmt.Sprintf("snapshot/%s/%s", env, chart)
			path := filepath.Join(snapshotDir, env, chart+".yaml")

			switch mode {
			case OrphanPrune:
				if err := os.Remove(path); err != nil {
					return checks, fmt.Errorf("removing orphan snapshot %s: %w", path, err)
				}
				checks = append(checks, PassCheck(name, start, "orphan snapshot removed"))
			case OrphanKeep:
				checks = append(checks, FailCheck(name, start,
					fmt.Sprintf("orphan snapshot: no chart %q is known for %s; not pruned: render incomplete",
						chart, env)))
			default:
				checks = append(checks, FailCheck(name, start,
					fmt.Sprintf("orphan snapshot: no chart %q is known for %s; %s",
						chart, env, snapshotUpdateHint)))
			}
		}
	}
	return checks, nil
}

// UnifiedDiff renders a line diff of want (the snapshot) against got (the
// fresh render) in unified style. It returns "" when the inputs are identical
// and truncates the body at maxDiffLines.
func UnifiedDiff(name string, want, got []byte) string {
	return labelledDiff(name, "snapshot", "rendered", want, got)
}

// labelledDiff is UnifiedDiff with caller-chosen ---/+++ labels, for diffs
// whose sides are not a snapshot and a render.
func labelledDiff(name, wantLabel, gotLabel string, want, got []byte) string {
	if bytes.Equal(want, got) {
		return ""
	}

	a := splitLines(want)
	b := splitLines(got)

	var body []string
	truncated := false
	for _, line := range diffLines(a, b) {
		if len(body) >= maxDiffLines-2 {
			truncated = true
			break
		}
		body = append(body, line)
	}

	var out strings.Builder
	fmt.Fprintf(&out, "--- %s %s\n", wantLabel, name)
	fmt.Fprintf(&out, "+++ %s %s\n", gotLabel, name)
	for _, line := range body {
		out.WriteString(line + "\n")
	}
	if truncated {
		out.WriteString("... truncated\n")
	}
	return out.String()
}

// splitLines splits data on newlines, dropping the trailing empty element that
// a final newline produces.
func splitLines(data []byte) []string {
	if len(data) == 0 {
		return nil
	}
	s := string(data)
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// diffLines returns unified-style body lines (" ctx", "-old", "+new") with
// long runs of unchanged lines collapsed into an @@ hunk header.
func diffLines(a, b []string) []string {
	// Trim the common prefix and suffix so the LCS runs on the changed region
	// only. This keeps large manifests cheap.
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix &&
		a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}

	midA := a[prefix : len(a)-suffix]
	midB := b[prefix : len(b)-suffix]

	var ops []string
	// Guard the quadratic LCS: beyond this size fall back to a block replace,
	// which is still an accurate (if coarse) diff.
	const maxLCSCells = 4_000_000
	if len(midA)*len(midB) > maxLCSCells {
		for _, l := range midA {
			ops = append(ops, "-"+l)
		}
		for _, l := range midB {
			ops = append(ops, "+"+l)
		}
	} else {
		ops = lcsDiff(midA, midB)
	}

	const context = 3
	var out []string
	if prefix > 0 {
		if prefix > context {
			out = append(out, fmt.Sprintf("@@ -%d,%d +%d,%d @@", prefix-context+1, len(a)-prefix+context, prefix-context+1, len(b)-prefix+context))
		}
		from := prefix - context
		if from < 0 {
			from = 0
		}
		for _, l := range a[from:prefix] {
			out = append(out, " "+l)
		}
	}
	out = append(out, ops...)
	if suffix > 0 {
		end := suffix
		if end > context {
			end = context
		}
		for _, l := range a[len(a)-suffix : len(a)-suffix+end] {
			out = append(out, " "+l)
		}
	}
	return out
}

// lcsDiff produces "-"/"+"/" " prefixed lines via a longest-common-subsequence
// table. Inputs are the already-trimmed changed regions.
func lcsDiff(a, b []string) []string {
	n, m := len(a), len(b)
	if n == 0 {
		out := make([]string, 0, m)
		for _, l := range b {
			out = append(out, "+"+l)
		}
		return out
	}
	if m == 0 {
		out := make([]string, 0, n)
		for _, l := range a {
			out = append(out, "-"+l)
		}
		return out
	}

	// table[i][j] = LCS length of a[i:] and b[j:]
	table := make([][]int32, n+1)
	for i := range table {
		table[i] = make([]int32, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				table[i][j] = table[i+1][j+1] + 1
			} else if table[i+1][j] >= table[i][j+1] {
				table[i][j] = table[i+1][j]
			} else {
				table[i][j] = table[i][j+1]
			}
		}
	}

	var out []string
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			out = append(out, " "+a[i])
			i++
			j++
		case table[i+1][j] >= table[i][j+1]:
			out = append(out, "-"+a[i])
			i++
		default:
			out = append(out, "+"+b[j])
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, "-"+a[i])
	}
	for ; j < m; j++ {
		out = append(out, "+"+b[j])
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
