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
var (
	adrHeadingLine = regexp.MustCompile(`^#{1,6}\s*ADR[-\s]`)
	adrHeading     = regexp.MustCompile(`^### ADR-(\d{3}): \S`)
)

// ADRHeading is one `### ADR-NNN: <title>` line of the decision record.
type ADRHeading struct {
	// Number is the zero-padded ADR number, e.g. "034".
	Number string
	// Line is the 1-based line number in DecisionsPath.
	Line int
	// Title is the heading text after the colon.
	Title string
}

// ParseADRHeadings splits a decision record into the headings that parse and
// the ones that do not. Lines inside a fenced code block are ignored, so an ADR
// that quotes a heading as an example does not register as a decision.
func ParseADRHeadings(data []byte) (headings []ADRHeading, malformed []string) {
	inFence := false
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for n := 1; scanner.Scan(); n++ {
		line := scanner.Text()
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inFence = !inFence
			continue
		}
		if inFence || !adrHeadingLine.MatchString(line) {
			continue
		}
		m := adrHeading.FindStringSubmatch(line)
		if m == nil {
			malformed = append(malformed, fmt.Sprintf("%s:%d: %q is not `### ADR-NNN: <title>`", DecisionsPath, n, line))
			continue
		}
		headings = append(headings, ADRHeading{
			Number: m[1],
			Line:   n,
			Title:  strings.TrimSpace(strings.TrimPrefix(line, "### ADR-"+m[1]+":")),
		})
	}
	return headings, malformed
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
	headings, malformed := ParseADRHeadings(data)

	format := PassCheck("decisions/adr-format", start,
		fmt.Sprintf("%d ADR headings, every one `### ADR-NNN: <title>`", len(headings)))
	if len(malformed) > 0 {
		format = FailCheck("decisions/adr-format", start,
			"every ADR heading is `### ADR-NNN: <title>` — three digits, a colon, a title. Record a number you intend to use as a blockquote above the next real ADR, never as a heading: a placeholder heading merges cleanly over the real ADR of that number and deletes it.",
			malformed...)
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
			"an ADR number names one decision, so two headings with the same number make every citation of it ambiguous. The number belongs to whichever ADR merged first: renumber the one this branch adds to "+NextFreeADR(headings)+" or later, keep its body byte-identical, and update the citations that name the old number.",
			duplicates...)
	}
	return []Check{format, unique}
}

// NextFreeADR is the lowest zero-padded number above every heading in the
// record, formatted for the failure message. It is advice, not an allocation:
// another branch may merge that number first, in which case this check is what
// says so.
func NextFreeADR(headings []ADRHeading) string {
	max := 0
	for _, h := range headings {
		n := 0
		if _, err := fmt.Sscanf(h.Number, "%d", &n); err == nil && n > max {
			max = n
		}
	}
	return fmt.Sprintf("ADR-%03d", max+1)
}
