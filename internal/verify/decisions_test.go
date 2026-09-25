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
	headings, _ := ParseADRHeadings([]byte("### ADR-009: a (2026)\n### ADR-038: b (2026)\n### ADR-012: c (2026)\n"))
	if got := NextFreeADR(headings); got != "ADR-039" {
		t.Errorf("want ADR-039, got %s", got)
	}
	if got := NextFreeADR(nil); got != "ADR-001" {
		t.Errorf("empty record should start at ADR-001, got %s", got)
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
