package scaffold

import (
	"bytes"
	"fmt"
	"strings"
)

// The registries the scaffold extends are hand-written YAML/JSON5 with
// comments that document every entry, so they are edited as text: a YAML
// round trip would drop the comments. Every helper inserts lines and never
// rewrites existing ones.

// appendBlock appends block after content, separated by exactly one blank line
// whatever blank lines either side carried.
func appendBlock(content []byte, block string) []byte {
	out := append([]byte{}, bytes.TrimRight(content, "\n")...)
	out = append(out, "\n\n"...)
	return append(out, ensureNL(strings.TrimLeft(block, "\n"))...)
}

// insertAtEndOfBlock inserts block at the end of the top-level mapping key
// `key:`: before the comment and blank lines that precede the next top-level
// key, or at the end of the file. block holds whole lines; blankBefore
// separates it from the previous entry with one blank line.
func insertAtEndOfBlock(content []byte, key, block string, blankBefore bool) ([]byte, error) {
	lines := splitKeep(content)
	start := -1
	for i, l := range lines {
		if strings.TrimRight(l, "\r\n") == key+":" {
			start = i
			break
		}
	}
	if start < 0 {
		return nil, fmt.Errorf("no top-level %q key", key+":")
	}
	next := len(lines)
	for i := start + 1; i < len(lines); i++ {
		if isTopLevelKey(lines[i]) {
			next = i
			break
		}
	}
	// Back up over the trailing run of blank lines and column-0 comments that
	// introduce the next key (or trail the file).
	at := next
	for at > start+1 && isTrailer(lines[at-1]) {
		at--
	}
	// The last kept line must end in a newline before anything follows it.
	if at > 0 && !strings.HasSuffix(lines[at-1], "\n") {
		lines[at-1] += "\n"
	}
	ins := splitKeep([]byte(ensureNL(strings.TrimLeft(block, "\n"))))
	if blankBefore {
		ins = append([]string{"\n"}, ins...)
	}
	out := append(append(append([]string{}, lines[:at]...), ins...), lines[at:]...)
	return []byte(strings.Join(out, "")), nil
}

// insertSortedListItem inserts "  - item" into the top-level list `key:`,
// keeping an alphabetical list alphabetical.
func insertSortedListItem(content []byte, key, item string) ([]byte, error) {
	lines := splitKeep(content)
	start := -1
	for i, l := range lines {
		if strings.TrimRight(l, "\r\n") == key+":" {
			start = i
			break
		}
	}
	if start < 0 {
		return nil, fmt.Errorf("no top-level %q key", key+":")
	}
	at := -1
	last := start
	for i := start + 1; i < len(lines); i++ {
		if isTopLevelKey(lines[i]) {
			break
		}
		t := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(t, "- ") {
			continue
		}
		last = i
		if at < 0 && strings.TrimSpace(strings.TrimPrefix(t, "- ")) > item {
			at = i
		}
	}
	if at < 0 {
		at = last + 1
	}
	if at > 0 && !strings.HasSuffix(lines[at-1], "\n") {
		lines[at-1] += "\n"
	}
	out := append(append(append([]string{}, lines[:at]...), "  - "+item+"\n"), lines[at:]...)
	return []byte(strings.Join(out, "")), nil
}

// insertRenovatePackage adds pkg (a quoted JSON5 string with its trailing
// comma, e.g. 'oci.trueforge.org/truecharts/x',) to the matchPackageNames list
// of the packageRule named group. It returns ok=false, content unchanged, when
// the list cannot be found, and ok=true unchanged when pkg is already there.
func insertRenovatePackage(content []byte, group, pkg string) ([]byte, bool) {
	lines := splitKeep(content)
	g := -1
	for i, l := range lines {
		if strings.Contains(l, "groupName:") && strings.Contains(l, "'"+group+"'") {
			g = i
			break
		}
	}
	if g < 0 {
		return content, false
	}
	open := -1
	for i := g; i < len(lines); i++ {
		if strings.Contains(lines[i], "matchPackageNames:") && strings.HasSuffix(strings.TrimRight(lines[i], "\r\n"), "[") {
			open = i
			break
		}
		if i > g && strings.Contains(lines[i], "groupName:") {
			break
		}
	}
	if open < 0 {
		return content, false
	}
	want := strings.TrimSuffix(strings.TrimSpace(pkg), ",")
	for i := open + 1; i < len(lines); i++ {
		t := strings.TrimSpace(lines[i])
		if strings.HasPrefix(t, "]") {
			indent := "        "
			if i-1 > open {
				prev := lines[i-1]
				indent = prev[:len(prev)-len(strings.TrimLeft(prev, " "))]
			}
			out := append(append(append([]string{}, lines[:i]...), indent+want+",\n"), lines[i:]...)
			return []byte(strings.Join(out, "")), true
		}
		if strings.TrimSuffix(t, ",") == want {
			return content, true
		}
	}
	return content, false
}

// splitKeep splits content into lines that keep their "\n" terminators; a
// final line without one is kept as is.
func splitKeep(content []byte) []string {
	if len(content) == 0 {
		return nil
	}
	return strings.SplitAfter(string(content), "\n")[:strings.Count(string(content), "\n")+boolInt(!bytes.HasSuffix(content, []byte("\n")))]
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// isTopLevelKey reports whether a line starts a top-level YAML mapping key.
func isTopLevelKey(line string) bool {
	if line == "" || line[0] == ' ' || line[0] == '\t' || line[0] == '#' || line[0] == '-' || line[0] == '\n' || line[0] == '\r' {
		return false
	}
	return strings.Contains(line, ":") && !strings.HasPrefix(line, "---") && !strings.HasPrefix(line, "...")
}

// isTrailer reports whether a line is blank or a column-0 comment.
func isTrailer(line string) bool {
	t := strings.TrimRight(line, "\r\n")
	return strings.TrimSpace(t) == "" || strings.HasPrefix(t, "#")
}

func ensureNL(s string) string {
	if strings.HasSuffix(s, "\n") {
		return s
	}
	return s + "\n"
}
