package topology

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ryanmcafee/homelab/contracts"
)

// contractPath walks up to the repository root and returns the contract file.
func contractPath(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		p := filepath.Join(dir, "contracts", "cluster", "topology.v1.yaml")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("could not find contracts/cluster/topology.v1.yaml above the working directory")
		}
		dir = parent
	}
}

// TestEmbeddedContractMatchesTheFile pins the embed to the file on disk. Every
// other test in this package reads the embedded copy; without this one they
// would all pass against a stale build artefact while the normative file said
// something else.
func TestEmbeddedContractMatchesTheFile(t *testing.T) {
	onDisk, err := os.ReadFile(contractPath(t))
	if err != nil {
		t.Fatalf("reading the contract: %v", err)
	}
	if string(onDisk) != string(contracts.ClusterTopologyV1) {
		t.Fatal("the embedded contract and contracts/cluster/topology.v1.yaml differ")
	}
	if _, err := Parse(onDisk); err != nil {
		t.Fatalf("the contract on disk does not load: %v", err)
	}
}

// TestQuorumMatchesEveryTableRow is the conformance test ADR-035 requires: the
// implementation computes every worked row in quorum.table from the formula,
// and the rows are read out of the file rather than copied into the test.
//
// A fixture copied out of the contract would pass forever after the contract
// changed, which is the drift the contract exists to prevent.
func TestQuorumMatchesEveryTableRow(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatalf("loading the contract: %v", err)
	}

	rows := c.QuorumTable()
	if len(rows) == 0 {
		t.Fatal("quorum.table is empty; this test would assert nothing")
	}
	for _, row := range rows {
		if got := c.Quorum(row.Count); got != row.Quorum {
			t.Errorf("Quorum(%d) = %d, contract table says %d", row.Count, got, row.Quorum)
		}
		if got := c.MaxUnavailable(row.Count); got != row.MaxUnavailable {
			t.Errorf("MaxUnavailable(%d) = %d, contract table says %d", row.Count, got, row.MaxUnavailable)
		}
	}

	// Every permitted count must have a worked row. A count the contract
	// permits but never works through is a size nothing has checked.
	for _, n := range c.PermittedCounts {
		found := false
		for _, row := range rows {
			if row.Count == n {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("permittedCounts includes %d but quorum.table has no row for it", n)
		}
	}
}

// TestEvaluationPointsComeFromTheContract asserts the gate-to-predicate map is
// data. The mapping is the most dangerous line in the guard — `whole` at
// before-destructive-step aborts every procedure and `survivable` at preflight
// consents to starting on a degraded cluster — so it is read, never inlined.
func TestEvaluationPointsComeFromTheContract(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatalf("loading the contract: %v", err)
	}

	// Every point this consumer evaluates must be mapped.
	for _, point := range []PointID{Preflight, BeforeDestructiveStep, Resume, Completion} {
		p, err := c.PredicateAt(point)
		if err != nil {
			t.Errorf("no predicate at %q: %v", point, err)
			continue
		}
		if len(p.Conditions) == 0 {
			t.Errorf("predicate %q at %q composes no conditions", p.ID, point)
		}
	}

	if _, err := c.PredicateAt(PointID("no-such-point")); err == nil {
		t.Error("PredicateAt accepted an undeclared evaluation point; an unmapped gate must be an error, not a default")
	}
}

// TestMappingIsReadNotInlined is the mutation check on the previous test. A
// lookup that ignored the file would pass it; this one swaps the mapping in a
// modified copy of the contract and requires the implementation to follow.
func TestMappingIsReadNotInlined(t *testing.T) {
	data, err := os.ReadFile(contractPath(t))
	if err != nil {
		t.Fatalf("reading the contract: %v", err)
	}

	mutated := strings.Replace(string(data),
		"    - id: preflight\n      predicate: whole\n",
		"    - id: preflight\n      predicate: survivable\n", 1)
	if mutated == string(data) {
		t.Fatal("could not find the preflight mapping to mutate; update this test alongside the contract")
	}

	c, err := Parse([]byte(mutated))
	if err != nil {
		t.Fatalf("parsing the mutated contract: %v", err)
	}
	p, err := c.PredicateAt(Preflight)
	if err != nil {
		t.Fatalf("PredicateAt(preflight): %v", err)
	}
	if p.ID != Survivable {
		t.Errorf("mutated contract maps preflight to %q but the implementation returned %q — "+
			"the mapping is inlined somewhere instead of read", Survivable, p.ID)
	}
}

// TestRaftToleranceIsReadNotInlined does the same for the tolerance, which
// used to be a Go constant. If any caller still reaches for a baked-in 10 this
// fails.
func TestRaftToleranceIsReadNotInlined(t *testing.T) {
	data, err := os.ReadFile(contractPath(t))
	if err != nil {
		t.Fatalf("reading the contract: %v", err)
	}
	mutated := strings.Replace(string(data), "raftIndexTolerance: 10", "raftIndexTolerance: 4242", 1)
	if mutated == string(data) {
		t.Fatal("could not find raftIndexTolerance to mutate; update this test alongside the contract")
	}
	c, err := Parse([]byte(mutated))
	if err != nil {
		t.Fatalf("parsing the mutated contract: %v", err)
	}
	if c.RaftIndexTolerance != 4242 {
		t.Errorf("RaftIndexTolerance = %d, want the mutated 4242", c.RaftIndexTolerance)
	}
}

// TestSurvivableRelaxesWholeInExactlyOneWay is the assertion standing between
// a considered relaxation and a quietly laxer gate at the most dangerous
// moment. `survivable` may drop `member-count` and add the two conditions that
// bound the relaxation; it may not drop any of the four convergence checks.
func TestSurvivableRelaxesWholeInExactlyOneWay(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatalf("loading the contract: %v", err)
	}
	whole, err := c.PredicateByID(Whole)
	if err != nil {
		t.Fatalf("predicate whole: %v", err)
	}
	survivable, err := c.PredicateByID(Survivable)
	if err != nil {
		t.Fatalf("predicate survivable: %v", err)
	}

	for _, cond := range []ConditionID{NoErrors, NoLearners, SingleLeader, RaftIndexConverged} {
		if !whole.Requires(cond) {
			t.Errorf("whole no longer requires %q", cond)
		}
		if !survivable.Requires(cond) {
			t.Errorf("survivable no longer requires %q — it has become laxer than whole in more than one way", cond)
		}
	}
	if survivable.Requires(MemberCount) {
		t.Error("survivable requires member-count, which is unsatisfiable at the points it guards")
	}
	if !survivable.Requires(QuorumPresent) {
		t.Error("survivable does not require quorum-present; the quorum table would be data no predicate reads")
	}
	if !survivable.Requires(AbsencesAreDeclared) {
		t.Error("survivable does not require absences-are-declared; nothing would tell a procedure in flight " +
			"apart from a degraded cluster")
	}
}

// TestLoaderFailsClosed covers the loader's own refusals. A contract naming a
// condition Go cannot evaluate must not load: a guard silently skipping the
// condition it did not recognise is worse than one that will not start.
func TestLoaderFailsClosed(t *testing.T) {
	data, err := os.ReadFile(contractPath(t))
	if err != nil {
		t.Fatalf("reading the contract: %v", err)
	}
	base := string(data)

	tests := []struct {
		name string
		from string
		to   string
		want string
	}{
		{
			name: "a condition this consumer does not implement",
			from: "    - id: no-learners",
			to:   "    - id: no-split-brain",
			want: "does not implement",
		},
		{
			name: "a predicate naming an undeclared condition",
			from: "        - quorum-present\n        - absences-are-declared",
			to:   "        - quorum-present\n        - invented-condition",
			want: "health.conditions does not declare",
		},
		{
			name: "an observation deadline longer than the staleness bound",
			from: "observationDeadlineSeconds: 10",
			to:   "observationDeadlineSeconds: 600",
			want: "exceeds maxObservationAgeSeconds",
		},
		{
			name: "an unsupported contract version",
			from: "\nversion: 1\n",
			to:   "\nversion: 2\n",
			want: "is not 1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			mutated := strings.Replace(base, tc.from, tc.to, 1)
			if mutated == base {
				t.Fatalf("could not find %q to mutate", tc.from)
			}
			_, err := Parse([]byte(mutated))
			if err == nil {
				t.Fatal("the loader accepted a contract it should have refused")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

// TestUnreachedConditionIsRejected is the generalised form of the defect that
// produced `survivable`: a rule published in the contract and composed by no
// predicate is a rule nobody applies.
func TestUnreachedConditionIsRejected(t *testing.T) {
	data, err := os.ReadFile(contractPath(t))
	if err != nil {
		t.Fatalf("reading the contract: %v", err)
	}
	// Drop quorum-present from the only predicate that composes it.
	mutated := strings.Replace(string(data), "        - quorum-present\n        - absences-are-declared",
		"        - absences-are-declared", 1)
	if mutated == string(data) {
		t.Fatal("could not find quorum-present in survivable to remove")
	}
	if _, err := Parse([]byte(mutated)); err == nil {
		t.Error("the loader accepted a contract declaring quorum-present with no predicate composing it")
	}
}

// TestCheckCount covers permittedCounts and degradedCounts, including the
// one-node control plane: permitted, and never reported as simply healthy.
func TestCheckCount(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatalf("loading the contract: %v", err)
	}

	if _, err := c.CheckCount(2); err == nil {
		t.Error("a 2-member control plane was accepted; even counts are not permitted")
	}
	degraded, err := c.CheckCount(1)
	if err != nil {
		t.Errorf("a 1-member control plane must be permitted: %v", err)
	}
	if !degraded {
		t.Error("a 1-member control plane must be reported degraded, not healthy")
	}
	degraded, err = c.CheckCount(3)
	if err != nil {
		t.Errorf("a 3-member control plane must be permitted: %v", err)
	}
	if degraded {
		t.Error("a 3-member control plane must not be reported degraded")
	}
}

// TestObservationBoundsArePresent pins the two windows the revalidation
// requirement is meaningless without.
func TestObservationBoundsArePresent(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatalf("loading the contract: %v", err)
	}
	if c.MaxObservationAge <= 0 || c.MaxObservationAge > time.Minute {
		t.Errorf("maxObservationAge is %s; a revalidation bound outside (0, 1m] is not 'immediately before'", c.MaxObservationAge)
	}
	if c.ObservationDeadline <= 0 || c.ObservationDeadline > c.MaxObservationAge {
		t.Errorf("observationDeadline is %s, which is not a usable bound against a max age of %s",
			c.ObservationDeadline, c.MaxObservationAge)
	}
	if !c.TransportFailureIsNotMemberFailure {
		t.Error("transportFailureIsNotMemberFailure is false; a dial failure would be reportable as a degraded cluster")
	}
}
