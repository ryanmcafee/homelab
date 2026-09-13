package scaffold

import (
	"fmt"
	"strings"
)

// diffContext is the number of unchanged lines around each hunk.
const diffContext = 3

// Diff renders every change as one git-style patch, applicable with
// `git apply` (or `patch -p1`) from the repository root.
func (p *Plan) Diff() string {
	return DiffChanges(p.Changes)
}

// DiffChanges renders changes as a git-style patch, in the given order.
func DiffChanges(changes []Change) string {
	var b strings.Builder
	for _, c := range changes {
		b.WriteString(fileDiff(c))
	}
	return b.String()
}

// fileDiff renders one change. An unchanged file renders nothing.
func fileDiff(c Change) string {
	a := splitKeep(c.Old)
	bl := splitKeep(c.New)
	if !c.Created() && string(c.Old) == string(c.New) {
		return ""
	}
	var out strings.Builder
	fmt.Fprintf(&out, "diff --git a/%s b/%s\n", c.Path, c.Path)
	if c.Created() {
		out.WriteString("new file mode 100644\n")
		fmt.Fprintf(&out, "--- /dev/null\n+++ b/%s\n", c.Path)
	} else {
		fmt.Fprintf(&out, "--- a/%s\n+++ b/%s\n", c.Path, c.Path)
	}
	for _, h := range hunks(diffOps(a, bl), diffContext) {
		out.WriteString(h)
	}
	return out.String()
}

// op is one diff line: ' ' (kept), '-' (removed) or '+' (added). Lines keep
// their terminator, so a missing final newline is a real difference.
type op struct {
	kind byte
	line string
}

// diffOps diffs two line slices: common prefix and suffix are kept verbatim
// and the changed middle goes through an LCS table, which is small because
// the scaffold only inserts blocks.
func diffOps(a, b []string) []op {
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix && a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	var ops []op
	for _, l := range a[:prefix] {
		ops = append(ops, op{' ', l})
	}
	ops = append(ops, lcsOps(a[prefix:len(a)-suffix], b[prefix:len(b)-suffix])...)
	for _, l := range a[len(a)-suffix:] {
		ops = append(ops, op{' ', l})
	}
	return ops
}

func lcsOps(a, b []string) []op {
	n, m := len(a), len(b)
	const maxCells = 4_000_000
	if n*m > maxCells {
		var ops []op
		for _, l := range a {
			ops = append(ops, op{'-', l})
		}
		for _, l := range b {
			ops = append(ops, op{'+', l})
		}
		return ops
	}
	t := make([][]int32, n+1)
	for i := range t {
		t[i] = make([]int32, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			switch {
			case a[i] == b[j]:
				t[i][j] = t[i+1][j+1] + 1
			case t[i+1][j] >= t[i][j+1]:
				t[i][j] = t[i+1][j]
			default:
				t[i][j] = t[i][j+1]
			}
		}
	}
	var ops []op
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			ops = append(ops, op{' ', a[i]})
			i++
			j++
		case t[i+1][j] >= t[i][j+1]:
			ops = append(ops, op{'-', a[i]})
			i++
		default:
			ops = append(ops, op{'+', b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		ops = append(ops, op{'-', a[i]})
	}
	for ; j < m; j++ {
		ops = append(ops, op{'+', b[j]})
	}
	return ops
}

// hunks groups ops into unified-diff hunks with ctx lines of context.
func hunks(ops []op, ctx int) []string {
	var changed []int
	for i, o := range ops {
		if o.kind != ' ' {
			changed = append(changed, i)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	// oldPos[i]/newPos[i] = lines of each side consumed before ops[i].
	oldPos := make([]int, len(ops)+1)
	newPos := make([]int, len(ops)+1)
	for i, o := range ops {
		oldPos[i+1], newPos[i+1] = oldPos[i], newPos[i]
		if o.kind != '+' {
			oldPos[i+1]++
		}
		if o.kind != '-' {
			newPos[i+1]++
		}
	}
	type span struct{ from, to int }
	var spans []span
	cur := span{max(0, changed[0]-ctx), min(len(ops), changed[0]+1+ctx)}
	for _, c := range changed[1:] {
		if c-ctx <= cur.to {
			cur.to = min(len(ops), c+1+ctx)
			continue
		}
		spans = append(spans, cur)
		cur = span{max(0, c-ctx), min(len(ops), c+1+ctx)}
	}
	spans = append(spans, cur)

	var out []string
	for _, s := range spans {
		oldN := oldPos[s.to] - oldPos[s.from]
		newN := newPos[s.to] - newPos[s.from]
		oldStart, newStart := oldPos[s.from]+1, newPos[s.from]+1
		if oldN == 0 {
			oldStart--
		}
		if newN == 0 {
			newStart--
		}
		var b strings.Builder
		fmt.Fprintf(&b, "@@ -%d,%d +%d,%d @@\n", oldStart, oldN, newStart, newN)
		for _, o := range ops[s.from:s.to] {
			b.WriteByte(o.kind)
			if strings.HasSuffix(o.line, "\n") {
				b.WriteString(o.line)
			} else {
				b.WriteString(o.line + "\n\\ No newline at end of file\n")
			}
		}
		out = append(out, b.String())
	}
	return out
}
