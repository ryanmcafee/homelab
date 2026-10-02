package verify

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// adrRecord builds a decision record in a temp repo root and returns that root.
func adrRecord(t *testing.T, body string) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, filepath.FromSlash("docs/project_notes"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "decisions.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// adrResult wraps ADRRecord's checks so the package's checkByName helper reads them.
func adrResult(root string) *Result {
	res := NewResult(0)
	res.Add(ADRRecord(root)...)
	return res
}

func TestADRRecordPassesOnAUniqueWellFormedRecord(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"# Architectural Decision Records (ADRs)",
		"",
		"### ADR-001: GitOps with ArgoCD (Established)",
		"",
		"body",
		"",
		"### ADR-034: The deployment DAG is generated per environment (2026-09-25)",
		"",
		"body",
		"",
	}, "\n"))

	for _, c := range ADRRecord(root) {
		if c.Status != StatusPass {
			t.Errorf("%s: want pass, got %s: %v", c.Name, c.Status, c.Findings)
		}
	}
}

// The reason this check exists: two branches append the same number, the
// rebase merges both headings without a conflict, and nothing else notices.
func TestADRRecordFailsOnADuplicateNumber(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"### ADR-033: Fork-ability check 3 splits into 3a and 3b (2026-09-25)",
		"",
		"### ADR-034: The deployment DAG is generated per environment (2026-09-25)",
		"",
		"### ADR-034: An in-cluster alert triage agent as an Argo Workflows DAG (2026-09-25)",
		"",
	}, "\n"))

	c := checkByName(t, adrResult(root), "decisions/adr-numbers")
	if c.Status != StatusFail {
		t.Fatalf("want fail, got %s", c.Status)
	}
	if len(c.Findings) != 1 {
		t.Fatalf("want one finding, got %v", c.Findings)
	}
	// The finding must locate both headings; "ADR-034 is duplicated" without
	// line numbers leaves the author grepping a 900-line file.
	for _, want := range []string{"ADR-034", "line 3", "line 5"} {
		if !strings.Contains(c.Findings[0], want) {
			t.Errorf("finding %q does not mention %q", c.Findings[0], want)
		}
	}
	// The failure has to say which number to move to, or the author guesses.
	if !strings.Contains(c.Detail, "ADR-035") {
		t.Errorf("detail does not suggest the next free number: %q", c.Detail)
	}
	if f := checkByName(t, adrResult(root), "decisions/adr-format"); f.Status != StatusPass {
		t.Errorf("a duplicate number is not a format problem: %s %v", f.Status, f.Findings)
	}
}

func TestADRRecordReportsEveryDuplicateNumberOnce(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"### ADR-034: a (2026-09-25)",
		"### ADR-034: b (2026-09-25)",
		"### ADR-034: c (2026-09-25)",
		"### ADR-035: d (2026-09-25)",
		"### ADR-035: e (2026-09-25)",
		"",
	}, "\n"))

	c := checkByName(t, adrResult(root), "decisions/adr-numbers")
	if len(c.Findings) != 2 {
		t.Fatalf("want one finding per duplicated number, got %v", c.Findings)
	}
	if !strings.Contains(c.Findings[0], "ADR-034 is defined 3 times") {
		t.Errorf("first finding should count all three: %q", c.Findings[0])
	}
	if !strings.Contains(c.Findings[1], "ADR-035 is defined 2 times") {
		t.Errorf("second finding: %q", c.Findings[1])
	}
}

// A reserved-number placeholder is the dangerous form: it carries the heading
// shape, so a real ADR of that number merges on top of it silently.
func TestADRRecordFailsOnAReservedNumberPlaceholder(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"### ADR-032: No level-0 claim in PR descriptions (2026-09-24)",
		"",
		"### ADR-033 **Reserved — lands in #365**",
		"",
		"### ADR-034: Cluster topology is a data contract (2026-09-25)",
		"",
	}, "\n"))

	c := checkByName(t, adrResult(root), "decisions/adr-format")
	if c.Status != StatusFail {
		t.Fatalf("want fail, got %s", c.Status)
	}
	if len(c.Findings) != 1 || !strings.Contains(c.Findings[0], DecisionsPath+":3:") {
		t.Fatalf("want one finding at line 3, got %v", c.Findings)
	}
	if !strings.Contains(c.Detail, "blockquote") {
		t.Errorf("detail should say where a reservation goes instead: %q", c.Detail)
	}
}

func TestADRRecordFailsOnANumberThatIsNotThreeDigits(t *testing.T) {
	root := adrRecord(t, "### ADR-34: not zero-padded (2026-09-25)\n")

	c := checkByName(t, adrResult(root), "decisions/adr-format")
	if c.Status != StatusFail {
		t.Fatalf("want fail, got %s: %q", c.Status, c.Detail)
	}
}

func TestADRRecordFailsOnAnADRHeadingAtTheWrongDepth(t *testing.T) {
	root := adrRecord(t, "## ADR-034: wrong heading level (2026-09-25)\n")

	c := checkByName(t, adrResult(root), "decisions/adr-format")
	if c.Status != StatusFail {
		t.Fatalf("want fail, got %s: %q", c.Status, c.Detail)
	}
}

// An ADR is allowed to show the heading shape it is describing.
func TestADRRecordIgnoresHeadingsInsideAFencedBlock(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"### ADR-034: Real decision (2026-09-25)",
		"",
		"Write the heading like this:",
		"",
		"```markdown",
		"### ADR-034: <title> (<date>)",
		"### ADR-33 **Reserved**",
		"```",
		"",
	}, "\n"))

	for _, c := range ADRRecord(root) {
		if c.Status != StatusPass {
			t.Errorf("%s: want pass, got %s: %v", c.Name, c.Status, c.Findings)
		}
	}
}

func TestADRRecordFailsWhenTheRecordIsMissing(t *testing.T) {
	checks := ADRRecord(t.TempDir())
	if len(checks) != 1 || checks[0].Status != StatusFail {
		t.Fatalf("a missing decision record must fail, got %v", checks)
	}
	if checks[0].Name != "decisions/adr-record" {
		t.Errorf("unexpected name %q", checks[0].Name)
	}
}

func TestNextFreeADRIsAboveEveryHeading(t *testing.T) {
	headings, malformed, err := ParseADRHeadings([]byte("### ADR-009: a (2026)\n### ADR-038: b (2026)\n### ADR-012: c (2026)\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := NextFreeADR(headings, malformed); got != "ADR-039" {
		t.Errorf("want ADR-039, got %s", got)
	}
	if got := NextFreeADR(nil, nil); got != "ADR-001" {
		t.Errorf("empty record should start at ADR-001, got %s", got)
	}
}

// A placeholder heading is rejected, but it still spends its number: advising
// the author onto it would send them at the one number the record is most
// likely to fight them for.
func TestNextFreeADRCountsAMalformedPlaceholder(t *testing.T) {
	headings, malformed, err := ParseADRHeadings([]byte(
		"### ADR-038: a (2026)\n### ADR-040 **Reserved — lands in #401**\n"))
	if err != nil {
		t.Fatal(err)
	}
	if len(malformed) != 1 || malformed[0].Claimed != 40 {
		t.Fatalf("want the placeholder parsed as claiming 40, got %+v", malformed)
	}
	if got := NextFreeADR(headings, malformed); got != "ADR-041" {
		t.Errorf("want ADR-041, got %s", got)
	}
}

// C2: CommonMark allows up to three leading spaces on an ATX heading, so an
// indented heading renders as a real one. A checker anchored at `^#` reports a
// confident green on a record that already carries the duplicate.
func TestADRRecordSeesHeadingsIndentedUpToThreeSpaces(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"### ADR-034: real (2026-09-25)",
		"",
		"   ### ADR-034: duplicate, renders the same (2026-09-25)",
		"",
		" ### ADR-033 **Reserved — one leading space**",
		"",
	}, "\n"))

	n := checkByName(t, adrResult(root), "decisions/adr-numbers")
	if n.Status != StatusFail {
		t.Fatalf("an indented duplicate must fail: %s %v", n.Status, n.Findings)
	}
	if !strings.Contains(n.Findings[0], "ADR-034 is defined 2 times") {
		t.Errorf("finding: %q", n.Findings[0])
	}
	f := checkByName(t, adrResult(root), "decisions/adr-format")
	if f.Status != StatusFail || len(f.Findings) != 1 {
		t.Fatalf("an indented placeholder must fail format: %s %v", f.Status, f.Findings)
	}
	// The finding quotes the line as written so the author can grep for it.
	if !strings.Contains(f.Findings[0], " ### ADR-033 **Reserved") {
		t.Errorf("finding should keep the indent: %q", f.Findings[0])
	}
}

// Four spaces is an indented code block, never a heading — so a quoted example
// is correctly invisible and needs no fence.
func TestADRRecordIgnoresHeadingsInAnIndentedCodeBlock(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"### ADR-034: real (2026-09-25)",
		"",
		"    ### ADR-034: <title> (<date>)",
		"    ### ADR-033 **Reserved**",
		"",
	}, "\n"))

	for _, c := range ADRRecord(root) {
		if c.Status != StatusPass {
			t.Errorf("%s: want pass, got %s: %v", c.Name, c.Status, c.Findings)
		}
	}
}

// C3: one stray opener hides every heading below it. decisions.md is the
// repository's hottest conflict file, and keeping one side of a fence pair is
// exactly how the count goes odd.
func TestADRRecordFailsOnAnUnterminatedFence(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"### ADR-001: real (2026-01-01)",
		"",
		"```yaml",
		"key: value",
		"",
		"### ADR-034: a (2026-09-25)",
		"### ADR-034: b (2026-09-25)",
		"",
	}, "\n"))

	checks := ADRRecord(root)
	if len(checks) != 1 || checks[0].Name != "decisions/adr-record" || checks[0].Status != StatusFail {
		t.Fatalf("an untrustworthy parse must fail as one check, got %v", checks)
	}
	if !strings.Contains(checks[0].Findings[0], DecisionsPath+":3 ") {
		t.Errorf("the finding should locate the opener: %q", checks[0].Findings[0])
	}
}

// C3, floor: "0 ADRs, no duplicate number" is not a green anyone should read.
func TestADRRecordFailsOnARecordWithNoADRs(t *testing.T) {
	root := adrRecord(t, "# Architectural Decision Records (ADRs)\n\nnothing here yet\n")

	c := checkByName(t, adrResult(root), "decisions/adr-record")
	if c.Status != StatusFail {
		t.Fatalf("want fail, got %s", c.Status)
	}
}

// C4: the format check must not fire on a heading that claims no number. This
// file already carries ADR-numbering guidance under `## Tips`, and promoting it
// to its own section is the natural next edit.
func TestADRRecordAllowsProseHeadingsAboutADRs(t *testing.T) {
	root := adrRecord(t, strings.Join([]string{
		"### ADR-034: real (2026-09-25)",
		"",
		"## ADR numbering conventions",
		"",
		"## ADR process",
		"",
	}, "\n"))

	for _, c := range ADRRecord(root) {
		if c.Status != StatusPass {
			t.Errorf("%s: want pass, got %s: %v", c.Name, c.Status, c.Findings)
		}
	}
}

// The other side of C4: a sub-heading that names a number stays a failure. It
// is byte-adjacent to the placeholder shape that deletes an ADR, so the two are
// not separable — verification.md says so where the author will read it.
func TestADRRecordStillFailsOnASubHeadingThatNamesANumber(t *testing.T) {
	root := adrRecord(t, "### ADR-034: real (2026-09-25)\n\n#### ADR-034 rollout notes\n")

	c := checkByName(t, adrResult(root), "decisions/adr-format")
	if c.Status != StatusFail {
		t.Fatalf("want fail, got %s: %q", c.Status, c.Detail)
	}
}

// The checker is only real if the record it guards passes it. Without this the
// gate can be committed green against fixtures while `main` already carries a
// duplicate (quality-gates.md §2 point 4).
func TestADRRecordPassesOnTheCommittedDecisionRecord(t *testing.T) {
	root, err := FindRepoRoot(mustGetwd(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range ADRRecord(root) {
		if c.Status != StatusPass {
			t.Errorf("%s on %s: %s — %s%v", c.Name, DecisionsPath, c.Status, c.Detail, c.Findings)
		}
	}
}
