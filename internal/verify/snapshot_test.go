package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeRender creates a rendered-file tree and returns the
// env -> chart -> path map that Snapshot consumes.
func writeRender(t *testing.T, dir string, contents map[string]map[string]string) map[string]map[string]string {
	t.Helper()
	files := map[string]map[string]string{}
	for env, charts := range contents {
		files[env] = map[string]string{}
		if err := os.MkdirAll(filepath.Join(dir, env), 0o755); err != nil {
			t.Fatal(err)
		}
		for chart, body := range charts {
			path := RenderedFile(dir, env, chart)
			if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
			files[env][chart] = path
		}
	}
	return files
}

func writeSnapshot(t *testing.T, snapshotDir, env, chart, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(snapshotDir, env), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(snapshotDir, env, chart+".yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func findCheck(t *testing.T, checks []Check, name string) Check {
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
	t.Fatalf("check %q not found; have %v", name, names)
	return Check{}
}

func TestSnapshotDetectsDrift(t *testing.T) {
	renderDir := t.TempDir()
	snapshotDir := t.TempDir()

	files := writeRender(t, renderDir, map[string]map[string]string{
		"homelab": {
			"addons":           "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: new\n",
			"tailscale-config": "apiVersion: v1\nkind: Secret\n",
		},
	})
	writeSnapshot(t, snapshotDir, "homelab", "addons", "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: old\n")
	writeSnapshot(t, snapshotDir, "homelab", "tailscale-config", "apiVersion: v1\nkind: Secret\n")

	checks, err := Snapshot(files, snapshotDir, false)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	drift := findCheck(t, checks, "snapshot/homelab/addons")
	if drift.Status != StatusFail {
		t.Fatalf("snapshot/homelab/addons: status %s, want fail", drift.Status)
	}
	joined := strings.Join(drift.Findings, "\n")
	if !strings.Contains(joined, "-  name: old") || !strings.Contains(joined, "+  name: new") {
		t.Errorf("findings do not contain a diff:\n%s", joined)
	}

	same := findCheck(t, checks, "snapshot/homelab/tailscale-config")
	if same.Status != StatusPass {
		t.Errorf("snapshot/homelab/tailscale-config: status %s, want pass", same.Status)
	}
}

func TestSnapshotUpdateWrites(t *testing.T) {
	renderDir := t.TempDir()
	snapshotDir := filepath.Join(t.TempDir(), "snapshots")

	body := "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: addons\n"
	files := writeRender(t, renderDir, map[string]map[string]string{
		"localdev": {"addons": body},
	})

	checks, err := Snapshot(files, snapshotDir, true)
	if err != nil {
		t.Fatalf("Snapshot update: %v", err)
	}
	c := findCheck(t, checks, "snapshot/localdev/addons")
	if c.Status != StatusPass {
		t.Fatalf("snapshot/localdev/addons: status %s (%s)", c.Status, c.Detail)
	}
	if !strings.Contains(c.Detail, "written") {
		t.Errorf("detail should report the write: %q", c.Detail)
	}

	got, err := os.ReadFile(filepath.Join(snapshotDir, "localdev", "addons.yaml"))
	if err != nil {
		t.Fatalf("reading written snapshot: %v", err)
	}
	if string(got) != body {
		t.Errorf("snapshot bytes = %q, want %q (snapshots are unnormalised)", string(got), body)
	}

	// A second update run is a no-op and reports it.
	checks, err = Snapshot(files, snapshotDir, true)
	if err != nil {
		t.Fatalf("Snapshot second update: %v", err)
	}
	if d := findCheck(t, checks, "snapshot/localdev/addons").Detail; !strings.Contains(d, "unchanged") {
		t.Errorf("second update detail = %q, want it to report unchanged", d)
	}
}

func TestSnapshotMissingIsFailureWithHint(t *testing.T) {
	renderDir := t.TempDir()
	snapshotDir := t.TempDir()
	files := writeRender(t, renderDir, map[string]map[string]string{
		"homelab": {"addons": "kind: ConfigMap\n"},
	})

	checks, err := Snapshot(files, snapshotDir, false)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	c := findCheck(t, checks, "snapshot/homelab/addons")
	if c.Status != StatusFail {
		t.Fatalf("status %s, want fail for a missing snapshot", c.Status)
	}
	if !strings.Contains(c.Detail, "run: task test:snapshot -- --update") {
		t.Errorf("detail must carry the update hint: %q", c.Detail)
	}
}

func TestSnapshotMissingRenderedFileIsFailure(t *testing.T) {
	snapshotDir := t.TempDir()
	writeSnapshot(t, snapshotDir, "homelab", "addons", "kind: ConfigMap\n")

	files := map[string]map[string]string{
		"homelab": {"addons": filepath.Join(t.TempDir(), "nope.yaml")},
	}
	checks, err := Snapshot(files, snapshotDir, false)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if c := findCheck(t, checks, "snapshot/homelab/addons"); c.Status != StatusFail {
		t.Errorf("status %s, want fail when the rendered file is absent", c.Status)
	}
}

func TestSnapshotChecksAreSortedAndComplete(t *testing.T) {
	renderDir := t.TempDir()
	snapshotDir := t.TempDir()
	files := writeRender(t, renderDir, map[string]map[string]string{
		"homelab":  {"zzz": "a\n", "aaa": "b\n"},
		"localdev": {"mmm": "c\n"},
	})
	checks, err := Snapshot(files, snapshotDir, true)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	want := []string{
		"snapshot/homelab/aaa",
		"snapshot/homelab/zzz",
		"snapshot/localdev/mmm",
	}
	if len(checks) != len(want) {
		t.Fatalf("got %d checks, want %d", len(checks), len(want))
	}
	for i, name := range want {
		if checks[i].Name != name {
			t.Errorf("checks[%d] = %q, want %q", i, checks[i].Name, name)
		}
	}
}

func TestUnifiedDiff(t *testing.T) {
	tests := []struct {
		name     string
		want     string
		got      string
		contains []string
		absent   []string
	}{
		{
			name:     "single line change",
			want:     "a\nb\nc\n",
			got:      "a\nB\nc\n",
			contains: []string{"--- snapshot", "+++ rendered", "-b", "+B", " a"},
		},
		{
			name:     "pure addition",
			want:     "a\n",
			got:      "a\nb\n",
			contains: []string{"+b"},
			absent:   []string{"-a"},
		},
		{
			name:     "pure deletion",
			want:     "a\nb\n",
			got:      "a\n",
			contains: []string{"-b"},
			absent:   []string{"+b"},
		},
		{
			name:     "identical is empty",
			want:     "a\nb\n",
			got:      "a\nb\n",
			contains: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out := UnifiedDiff("homelab/addons", []byte(tc.want), []byte(tc.got))
			if tc.contains == nil {
				if out != "" {
					t.Fatalf("want empty diff, got:\n%s", out)
				}
				return
			}
			for _, want := range tc.contains {
				if !strings.Contains(out, want) {
					t.Errorf("diff missing %q:\n%s", want, out)
				}
			}
			for _, absent := range tc.absent {
				if strings.Contains(out, absent) {
					t.Errorf("diff should not contain %q:\n%s", absent, out)
				}
			}
			if !strings.Contains(out, "homelab/addons") {
				t.Errorf("diff header should name the snapshot:\n%s", out)
			}
		})
	}
}

func TestUnifiedDiffTruncates(t *testing.T) {
	var want, got strings.Builder
	for i := 0; i < 500; i++ {
		want.WriteString("line-old\n")
		got.WriteString("line-new\n")
	}
	out := UnifiedDiff("big", []byte(want.String()), []byte(got.String()))
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) > maxDiffLines+1 {
		t.Errorf("diff has %d lines, want at most %d", len(lines), maxDiffLines+1)
	}
	if !strings.Contains(out, "... truncated") {
		t.Errorf("long diff must be marked truncated:\n%s", strings.Join(lines[:5], "\n"))
	}
}

func TestOrphanSnapshotsReported(t *testing.T) {
	snapshotDir := t.TempDir()
	writeSnapshot(t, snapshotDir, "homelab", "addons", "kind: ConfigMap\n")
	writeSnapshot(t, snapshotDir, "homelab", "deleted-chart", "kind: Secret\n")
	// An env the caller did not render must be left alone entirely.
	writeSnapshot(t, snapshotDir, "localdev", "addons", "kind: ConfigMap\n")

	expected := map[string][]string{"homelab": {"addons"}}

	checks, err := OrphanSnapshots(expected, snapshotDir, OrphanReport)
	if err != nil {
		t.Fatalf("OrphanSnapshots: %v", err)
	}
	if len(checks) != 1 {
		t.Fatalf("got %d check(s) %+v, want exactly the orphan", len(checks), checks)
	}
	c := checks[0]
	if c.Name != "snapshot/homelab/deleted-chart" {
		t.Errorf("name = %q, want snapshot/homelab/deleted-chart", c.Name)
	}
	if c.Status != StatusFail {
		t.Errorf("status = %s, want fail", c.Status)
	}
	if !strings.Contains(c.Detail, "orphan snapshot") || !strings.Contains(c.Detail, "--update") {
		t.Errorf("detail = %q, want it to name the orphan and the fix", c.Detail)
	}
	if _, err := os.Stat(filepath.Join(snapshotDir, "homelab", "deleted-chart.yaml")); err != nil {
		t.Errorf("the orphan must survive a read-only check: %v", err)
	}
}

func TestOrphanSnapshotsPruned(t *testing.T) {
	snapshotDir := t.TempDir()
	writeSnapshot(t, snapshotDir, "homelab", "addons", "kind: ConfigMap\n")
	writeSnapshot(t, snapshotDir, "homelab", "deleted-chart", "kind: Secret\n")

	expected := map[string][]string{"homelab": {"addons"}}

	checks, err := OrphanSnapshots(expected, snapshotDir, OrphanPrune)
	if err != nil {
		t.Fatalf("OrphanSnapshots: %v", err)
	}
	if len(checks) != 1 || checks[0].Status != StatusPass {
		t.Fatalf("got %+v, want one passing check", checks)
	}
	if !strings.Contains(checks[0].Detail, "removed") {
		t.Errorf("detail = %q, want it to report the removal", checks[0].Detail)
	}
	if _, err := os.Stat(filepath.Join(snapshotDir, "homelab", "deleted-chart.yaml")); !os.IsNotExist(err) {
		t.Errorf("orphan should be deleted, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(snapshotDir, "homelab", "addons.yaml")); err != nil {
		t.Errorf("a live snapshot must not be deleted: %v", err)
	}
}

func TestOrphanSnapshotsKeepModeDeletesNothing(t *testing.T) {
	snapshotDir := t.TempDir()
	writeSnapshot(t, snapshotDir, "homelab", "addons", "kind: ConfigMap\n")
	writeSnapshot(t, snapshotDir, "homelab", "deleted-chart", "kind: Secret\n")

	expected := map[string][]string{"homelab": {"addons"}}

	checks, err := OrphanSnapshots(expected, snapshotDir, OrphanKeep)
	if err != nil {
		t.Fatalf("OrphanSnapshots: %v", err)
	}
	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("got %+v, want one failing check", checks)
	}
	if !strings.Contains(checks[0].Detail, "not pruned: render incomplete") {
		t.Errorf("detail = %q, want it to say why nothing was deleted", checks[0].Detail)
	}
	if _, err := os.Stat(filepath.Join(snapshotDir, "homelab", "deleted-chart.yaml")); err != nil {
		t.Errorf("keep mode must not delete anything: %v", err)
	}
}

func TestOrphanSnapshotsIgnoreChartsThatFailedToRender(t *testing.T) {
	snapshotDir := t.TempDir()
	writeSnapshot(t, snapshotDir, "homelab", "addons", "kind: ConfigMap\n")
	writeSnapshot(t, snapshotDir, "homelab", "broken", "kind: Secret\n")

	// "broken" is a discovered chart whose render failed, so it produced no
	// rendered file. It must not be mistaken for a deleted chart, or --update
	// would throw away a perfectly good snapshot.
	expected := map[string][]string{"homelab": {"addons", "broken"}}

	for _, mode := range []OrphanMode{OrphanReport, OrphanPrune, OrphanKeep} {
		checks, err := OrphanSnapshots(expected, snapshotDir, mode)
		if err != nil {
			t.Fatalf("OrphanSnapshots(mode %d): %v", mode, err)
		}
		if len(checks) != 0 {
			t.Errorf("mode %d: got %+v, want no checks", mode, checks)
		}
	}
	for _, chart := range []string{"addons", "broken"} {
		if _, err := os.Stat(filepath.Join(snapshotDir, "homelab", chart+".yaml")); err != nil {
			t.Errorf("snapshot for %s must survive: %v", chart, err)
		}
	}
}

func TestOrphanSnapshotsTolerateMissingDir(t *testing.T) {
	expected := map[string][]string{"homelab": {"addons"}}
	checks, err := OrphanSnapshots(expected, filepath.Join(t.TempDir(), "absent"), OrphanReport)
	if err != nil {
		t.Fatalf("a snapshot directory that does not exist yet is not an error: %v", err)
	}
	if len(checks) != 0 {
		t.Errorf("got %+v, want no checks", checks)
	}
}

func TestOrphanSnapshotsIgnoreNonYAML(t *testing.T) {
	snapshotDir := t.TempDir()
	writeSnapshot(t, snapshotDir, "homelab", "addons", "kind: ConfigMap\n")
	if err := os.WriteFile(filepath.Join(snapshotDir, "homelab", "README.md"), []byte("notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(snapshotDir, "homelab", "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	expected := map[string][]string{"homelab": {"addons"}}
	checks, err := OrphanSnapshots(expected, snapshotDir, OrphanReport)
	if err != nil {
		t.Fatalf("OrphanSnapshots: %v", err)
	}
	if len(checks) != 0 {
		t.Errorf("got %+v, want no checks: only .yaml files are snapshots", checks)
	}
}
