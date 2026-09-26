package verify

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// DecisionsPath is the repo-relative ADR record: the file every architectural
// decision lands in, and the one an ADR number points into (ADR-039).
const DecisionsPath = "docs/project_notes/decisions.md"

// adrHeadingLine matches any line trying to be an ADR heading; adrHeading
// matches the one canonical form. The pair is deliberate: a line the first
// matches and the second does not is a malformed heading, and the malformed
// forms are exactly the ones that break a rebase — `### ADR-033 **Reserved**`
// merges cleanly on top of a real ADR-033 and deletes it, and `### ADR-34:`
// sorts and greps differently from every citation of it.
//
// Both run against the line with its heading indent removed (stripIndent), not
// against the raw line: CommonMark renders `   ### ADR-034:` as the same
// heading, so a checker anchored at `^#` would read a real duplicate as prose
// and report a confident green. The trailing `\d` is what separates a heading
// that claims a number from prose about the numbering ("## ADR numbering
// conventions"), which claims none and must not fail the format check.
var (
	adrHeadingLine = regexp.MustCompile(`^#{1,6}\s*ADR[-\s]*\d`)
	adrHeading     = regexp.MustCompile(`^### ADR-(\d{3}): \S`)
	adrClaimed     = regexp.MustCompile(`ADR[-\s]*(\d+)`)
)

// stripIndent removes the up-to-three leading spaces CommonMark allows before
// an ATX heading or a fence and reports whether the line can be either. Four
// or more spaces is an indented code block, so a heading quoted that way is
// correctly invisible to this checker.
func stripIndent(line string) (string, bool) {
	indent := len(line) - len(strings.TrimLeft(line, " "))
	if indent > 3 {
		return "", false
	}
	return line[indent:], true
}

// ADRHeading is one `### ADR-NNN: <title>` line of the decision record.
type ADRHeading struct {
	// Number is the zero-padded ADR number, e.g. "034".
	Number string
	// Line is the 1-based line number in DecisionsPath.
	Line int
	// Title is the heading text after the colon.
	Title string
}

// MalformedHeading is a line that claims an ADR number without being the
// canonical `### ADR-NNN: <title>` form.
type MalformedHeading struct {
	// Line is the 1-based line number in DecisionsPath.
	Line int
	// Text is the line as written, indent included, so the author can find it.
	Text string
	// Claimed is the number the line names (33 for `### ADR-033 **Reserved**`),
	// or 0 when it names none. A malformed heading still spends its number in
	// practice, so NextFreeADR must not hand that number out as free.
	Claimed int
}

// Finding renders the heading as one line of a check's findings.
func (m MalformedHeading) Finding() string {
	return fmt.Sprintf("%s:%d: %q is not `### ADR-NNN: <title>`", DecisionsPath, m.Line, m.Text)
}

// ParseADRHeadings splits a decision record into the headings that parse and
// the ones that do not. Lines inside a fenced code block are ignored, so an ADR
// that quotes a heading as an example does not register as a decision.
//
// An unterminated fence is an error rather than a silent skip: one stray opener
// hides every heading below it, and this file is the repository's hottest
// conflict file, where keeping one side of a fence pair is exactly how the
// count goes odd. A parse that may have skipped the record must not produce a
// green.
func ParseADRHeadings(data []byte) (headings []ADRHeading, malformed []MalformedHeading, err error) {
	fenceOpenedAt := 0
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for n := 1; scanner.Scan(); n++ {
		line, canBeHeading := stripIndent(scanner.Text())
		if !canBeHeading {
			continue
		}
		if strings.HasPrefix(line, "```") {
			if fenceOpenedAt == 0 {
				fenceOpenedAt = n
			} else {
				fenceOpenedAt = 0
			}
			continue
		}
		if fenceOpenedAt != 0 || !adrHeadingLine.MatchString(line) {
			continue
		}
		m := adrHeading.FindStringSubmatch(line)
		if m == nil {
			bad := MalformedHeading{Line: n, Text: scanner.Text()}
			if c := adrClaimed.FindStringSubmatch(line); c != nil {
				fmt.Sscanf(c[1], "%d", &bad.Claimed)
			}
			malformed = append(malformed, bad)
			continue
		}
		headings = append(headings, ADRHeading{
			Number: m[1],
			Line:   n,
			Title:  strings.TrimSpace(strings.TrimPrefix(line, "### ADR-"+m[1]+":")),
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, nil, err
	}
	if fenceOpenedAt != 0 {
		return nil, nil, fmt.Errorf(
			"the fenced code block opened at %s:%d is never closed, so every heading below it was skipped — this parse cannot be trusted to have seen the record",
			DecisionsPath, fenceOpenedAt)
	}
	return headings, malformed, nil
}

// ADRRecord is the level-0 gate on the ADR record (ADR-039). It reads the
// repository, needs no cluster, and answers the one question no other check
// asks: does every ADR number identify exactly one decision?
//
// It exists because the failure it catches is silent. Several pull requests
// append "the next ADR number" in parallel and pick the same one; whichever
// merges first takes the number, and the second one's rebase appends a second
// heading with that number at a different offset — git merges it without a
// conflict, and `main` carries two ADR-034s that every future citation of
// ADR-034 inherits. There is no allocator to consult and no reviewer who can
// reliably see it, so the number is allocated by this check instead: it is
// yours when it merges, and the second author renumbers because the gate is
// red.
func ADRRecord(repoRoot string) []Check {
	start := time.Now()
	data, err := os.ReadFile(filepath.Join(repoRoot, filepath.FromSlash(DecisionsPath)))
	if err != nil {
		return []Check{FailCheck("decisions/adr-record", start, "reading "+DecisionsPath, err.Error())}
	}
	headings, malformed, err := ParseADRHeadings(data)
	if err != nil {
		return []Check{FailCheck("decisions/adr-record", start,
			"the ADR record did not parse, so neither `decisions/adr-format` nor `decisions/adr-numbers` can be answered. Close the fence (or delete the stray one) and run `task verify` again.",
			err.Error())}
	}

	var checks []Check
	// A record that yields no ADR at all is not a passing record, it is a
	// parse that saw nothing: without this floor the two checks below report
	// "0 ADRs, no duplicate number" on an empty or unreadable file and the
	// gate's green means nothing.
	if len(headings) == 0 {
		checks = append(checks, FailCheck("decisions/adr-record", start,
			"the ADR record contains no `### ADR-NNN: <title>` heading. Either this is not the decision record or every heading in it is malformed; a green from a record with no ADRs proves nothing.",
			DecisionsPath+": 0 well-formed ADR headings"))
	}

	format := PassCheck("decisions/adr-format", start,
		fmt.Sprintf("%d ADR headings, every one `### ADR-NNN: <title>`", len(headings)))
	if len(malformed) > 0 {
		findings := make([]string, 0, len(malformed))
		for _, m := range malformed {
			findings = append(findings, m.Finding())
		}
		format = FailCheck("decisions/adr-format", start,
			"every ADR heading is `### ADR-NNN: <title>` — three digits, a colon, a title, at heading depth three and unindented. Record a number you intend to use as a blockquote above the next real ADR, never as a heading: a placeholder heading merges cleanly over the real ADR of that number and deletes it.",
			findings...)
	}

	lines := map[string][]int{}
	var numbers []string
	for _, h := range headings {
		if _, seen := lines[h.Number]; !seen {
			numbers = append(numbers, h.Number)
		}
		lines[h.Number] = append(lines[h.Number], h.Line)
	}
	sort.Strings(numbers)

	var duplicates []string
	for _, n := range numbers {
		at := lines[n]
		if len(at) < 2 {
			continue
		}
		where := make([]string, 0, len(at))
		for _, l := range at {
			where = append(where, fmt.Sprintf("line %d", l))
		}
		duplicates = append(duplicates, fmt.Sprintf(
			"ADR-%s is defined %d times (%s)", n, len(at), strings.Join(where, ", ")))
	}
	unique := PassCheck("decisions/adr-numbers", start,
		fmt.Sprintf("%d ADRs, no duplicate number", len(headings)))
	if len(duplicates) > 0 {
		unique = FailCheck("decisions/adr-numbers", start,
			"an ADR number names one decision, so two headings with the same number make every citation of it ambiguous. The number belongs to whichever ADR merged first: renumber the one this branch adds to "+NextFreeADR(headings, malformed)+" or later, keep its body byte-identical, and update the citations that name the old number.",
			duplicates...)
	}
	return append(checks, format, unique)
}

// NextFreeADR is the lowest zero-padded number above every number the record
// already spends, formatted for the failure message. Malformed headings count:
// a `### ADR-040 **Reserved**` placeholder is rejected by decisions/adr-format,
// but advising the author to move onto 040 while that line sits in the file
// sends them at the one number the record is most likely to fight them for.
//
// It is advice, not an allocation: another branch may merge that number first,
// in which case this check is what says so.
func NextFreeADR(headings []ADRHeading, malformed []MalformedHeading) string {
	max := 0
	for _, h := range headings {
		n := 0
		if _, err := fmt.Sscanf(h.Number, "%d", &n); err == nil && n > max {
			max = n
		}
	}
	for _, m := range malformed {
		if m.Claimed > max {
			max = m.Claimed
		}
	}
	return fmt.Sprintf("ADR-%03d", max+1)
}
