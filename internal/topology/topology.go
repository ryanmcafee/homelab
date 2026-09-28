// Package topology reads contracts/cluster/topology.v1.yaml — the normative
// control-plane topology, etcd quorum rule and health predicates (ADR-035).
//
// The contract exists because one safety rule has two consumers in two
// languages, and a constant in either that restates a value from the file is a
// review failure. So nothing in this package hard-codes a member count, a
// quorum, a raft tolerance, an observation bound, or which predicate guards
// which evaluation point: every one of those is read from the file. What Go
// supplies is the *implementation* of the formulas and conditions, and
// internal/topology's conformance test holds that implementation against the
// file's own worked values.
//
// Fail-closed is a property of the loader, not only of the caller. A contract
// naming a condition this implementation does not know, or a predicate with no
// evaluation point, fails to load rather than silently evaluating a subset:
// a guard that skips the condition it did not recognise is worse than one that
// refuses to start.
package topology

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/ryanmcafee/homelab/contracts"
)

// ConditionID is one health condition atom from health.conditions.
type ConditionID string

const (
	MemberCount                   ConditionID = "member-count"
	QuorumPresent                 ConditionID = "quorum-present"
	AbsencesAreDeclared           ConditionID = "absences-are-declared"
	MembershipAccountsForExpected ConditionID = "membership-accounts-for-expected"
	NoErrors                      ConditionID = "no-errors"
	NoLearners                    ConditionID = "no-learners"
	SingleLeader                  ConditionID = "single-leader"
	RaftIndexConverged            ConditionID = "raft-index-converged"
)

// implemented is every condition this Go consumer can evaluate. The loader
// rejects a contract that names one outside this set, so extending the
// contract fails the build's tests rather than quietly weakening the guard.
var implemented = map[ConditionID]bool{
	MemberCount:                   true,
	QuorumPresent:                 true,
	AbsencesAreDeclared:           true,
	MembershipAccountsForExpected: true,
	NoErrors:                      true,
	NoLearners:                    true,
	SingleLeader:                  true,
	RaftIndexConverged:            true,
}

// PredicateID is a named composition of conditions from health.predicates.
type PredicateID string

const (
	Whole      PredicateID = "whole"
	Survivable PredicateID = "survivable"
)

// PointID is an evaluation point from evaluation.points.
type PointID string

const (
	Preflight             PointID = "preflight"
	BeforeDestructiveStep PointID = "before-destructive-step"
	Resume                PointID = "resume"
	Completion            PointID = "completion"
)

// Entry semantics and selector values this consumer implements. A contract
// declaring anything else refuses to load: reading a different entry rule as
// this one is how a guard ends up evaluating the door's predicate mid-procedure.
const (
	EntryExclusive = "exclusive"
	// SelectorObservedMembership is the only selector this consumer implements —
	// the entry point comes from whether the declared target is in etcd's own
	// membership, never from a flag or a state file (ADR-035 rejected `--resume`).
	SelectorObservedMembership = "declared-target-present-in-observed-membership"
)

// Point kinds. An `entry` point is where a run may start; an `in-run` point is
// reached only from one.
const (
	KindEntry = "entry"
	KindInRun = "in-run"
)

// Predicate is one named predicate and the conditions it composes.
type Predicate struct {
	ID            PredicateID
	Summary       string
	EvaluatedOver string
	Conditions    []ConditionID
}

// Requires reports whether this predicate evaluates the given condition.
// Callers switch on this rather than on the predicate's name, so the contract
// decides what each gate checks.
func (p Predicate) Requires(c ConditionID) bool {
	for _, have := range p.Conditions {
		if have == c {
			return true
		}
	}
	return false
}

// Contract is the parsed topology contract.
type Contract struct {
	Version int

	// CountKeyPattern is the ConfigSet key family the member count derives
	// from. internal/config holds the resolver; this is here so the schema
	// and the contract can be held character-identical by a test.
	CountKeyPattern string
	PermittedCounts []int
	DegradedCounts  []int

	// RemovalOfLastMember is what to do when a removal would empty the
	// cluster, and the guidance to print instead of bare arithmetic.
	RemovalOfLastMember         string
	RemovalOfLastMemberGuidance string

	RaftIndexTolerance int64

	// MaxObservationAge bounds how old a reading may be when it is acted on;
	// ObservationDeadline bounds how long the consumer may wait for one.
	// Both are indeterminate-therefore-unsafe when exceeded.
	MaxObservationAge   time.Duration
	ObservationDeadline time.Duration

	// TransportFailureIsNotMemberFailure requires a dial or deadline error to
	// be reported as the transport fault it is, never flattened into "N
	// member(s) answered".
	TransportFailureIsNotMemberFailure bool

	// Entry, EntrySelector and EntrySelectorIsObserved carry the rule that
	// evaluation.points is a set of gates with exclusive entry rather than a
	// pipeline: a run enters at exactly one point, chosen from the observed
	// membership. Empty on a contract revision that predates the clause; a
	// declared value this consumer does not implement refuses to load.
	Entry                   string
	EntrySelector           string
	EntrySelectorIsObserved bool

	quorumTable []quorumRow
	predicates  map[PredicateID]Predicate
	points      map[PointID]PredicateID
	pointKinds  map[PointID]string
	entryPoints []PointID
	runShapes   []RunShape
}

// RunShape is one whole path through the evaluation points: where a run of that
// shape enters and which points it reaches. The conformance test holds the
// implementation's entry selection against `sequence[0]`, which is what a
// pipeline implementation fails.
type RunShape struct {
	ID       string
	When     string
	Sequence []PointID
}

type quorumRow struct {
	Count          int `yaml:"count"`
	Quorum         int `yaml:"quorum"`
	MaxUnavailable int `yaml:"maxUnavailable"`
}

// Quorum is the minimum number of members that must be present for a cluster
// of `count` to accept writes: the contract's floor(count / 2) + 1.
func (c *Contract) Quorum(count int) int {
	if count <= 0 {
		return 0
	}
	return count/2 + 1
}

// MaxUnavailable is how many members of a cluster of `count` may be absent
// while it still has quorum: the contract's count - quorum.
func (c *Contract) MaxUnavailable(count int) int {
	if count <= 0 {
		return 0
	}
	return count - c.Quorum(count)
}

// PredicateAt returns the predicate the contract assigns to an evaluation
// point. An unmapped point is an error rather than a default: evaluating the
// wrong predicate at the wrong moment either aborts every procedure or
// consents to starting on a degraded cluster, and both are one line away.
func (c *Contract) PredicateAt(point PointID) (Predicate, error) {
	id, ok := c.points[point]
	if !ok {
		return Predicate{}, fmt.Errorf(
			"contracts/cluster/topology.v1.yaml declares no predicate for evaluation point %q", point)
	}
	p, ok := c.predicates[id]
	if !ok {
		return Predicate{}, fmt.Errorf(
			"evaluation point %q names predicate %q, which the contract does not define", point, id)
	}
	return p, nil
}

// PredicateByID returns a predicate by name.
func (c *Contract) PredicateByID(id PredicateID) (Predicate, error) {
	p, ok := c.predicates[id]
	if !ok {
		return Predicate{}, fmt.Errorf("contracts/cluster/topology.v1.yaml defines no predicate %q", id)
	}
	return p, nil
}

// Points returns every declared evaluation point, sorted, for tests and for
// the `--explain` style output a refusal can quote.
func (c *Contract) Points() []PointID {
	out := make([]PointID, 0, len(c.points))
	for p := range c.points {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// EntryPoints returns the points a run may enter at, in contract order. Empty
// means the contract revision does not state the rule; callers hold the
// implemented entry set instead, and Parse has already refused any revision
// that states a rule this consumer does not implement.
func (c *Contract) EntryPoints() []PointID {
	return append([]PointID(nil), c.entryPoints...)
}

// EntryPointsAreDeclared reports whether the contract states the entry rule.
func (c *Contract) EntryPointsAreDeclared() bool {
	return len(c.entryPoints) > 0
}

// IsEntryPoint reports whether a run may enter at this point. An `in-run` point
// is reachable only from an entry point; entering there would skip the gate at
// the door.
func (c *Contract) IsEntryPoint(point PointID) bool {
	for _, p := range c.entryPoints {
		if p == point {
			return true
		}
	}
	return false
}

// RunShapes returns the contract's enumerated whole paths.
func (c *Contract) RunShapes() []RunShape {
	out := make([]RunShape, 0, len(c.runShapes))
	for _, s := range c.runShapes {
		out = append(out, RunShape{ID: s.ID, When: s.When, Sequence: append([]PointID(nil), s.Sequence...)})
	}
	return out
}

// QuorumTable returns the contract's worked rows. The conformance test walks
// these; nothing at runtime reads them, because the formula is the rule and
// the table is how the formula is held honest.
func (c *Contract) QuorumTable() []struct{ Count, Quorum, MaxUnavailable int } {
	out := make([]struct{ Count, Quorum, MaxUnavailable int }, 0, len(c.quorumTable))
	for _, r := range c.quorumTable {
		out = append(out, struct{ Count, Quorum, MaxUnavailable int }{r.Count, r.Quorum, r.MaxUnavailable})
	}
	return out
}

// CheckCount validates a derived control-plane count against permittedCounts
// and reports whether the count is one the contract calls degraded.
//
// A degraded count is permitted, not healthy: a one-node control plane is a
// real fork, and the guard says so out loud rather than reporting a cluster
// with no fault tolerance as fine.
func (c *Contract) CheckCount(count int) (degraded bool, err error) {
	permitted := false
	for _, n := range c.PermittedCounts {
		if n == count {
			permitted = true
			break
		}
	}
	if !permitted {
		return false, fmt.Errorf(
			"%d control-plane address(es) are configured, but contracts/cluster/topology.v1.yaml permits only %s: "+
				"an even member count adds a failure to tolerate without adding one it can survive",
			count, joinInts(c.PermittedCounts))
	}
	for _, n := range c.DegradedCounts {
		if n == count {
			return true, nil
		}
	}
	return false, nil
}

func joinInts(ns []int) string {
	parts := make([]string, 0, len(ns))
	for _, n := range ns {
		parts = append(parts, fmt.Sprint(n))
	}
	return strings.Join(parts, ", ")
}

// raw mirrors the file. It exists only inside Parse; everything outside this
// package sees the validated Contract.
type raw struct {
	Version      int `yaml:"version"`
	ControlPlane struct {
		CountKeyPattern string `yaml:"countKeyPattern"`
		PermittedCounts []int  `yaml:"permittedCounts"`
		DegradedCounts  []int  `yaml:"degradedCounts"`
	} `yaml:"controlPlane"`
	Quorum struct {
		Table                       []quorumRow `yaml:"table"`
		RemovalOfLastMember         string      `yaml:"removalOfLastMember"`
		RemovalOfLastMemberGuidance string      `yaml:"removalOfLastMemberGuidance"`
	} `yaml:"quorum"`
	Health struct {
		Conditions []struct {
			ID ConditionID `yaml:"id"`
		} `yaml:"conditions"`
		RaftIndexTolerance int64 `yaml:"raftIndexTolerance"`
		Predicates         []struct {
			ID            PredicateID   `yaml:"id"`
			Summary       string        `yaml:"summary"`
			EvaluatedOver string        `yaml:"evaluatedOver"`
			Conditions    []ConditionID `yaml:"conditions"`
		} `yaml:"predicates"`
	} `yaml:"health"`
	Evaluation struct {
		OnIndeterminate                    string `yaml:"onIndeterminate"`
		MaxObservationAgeSeconds           int    `yaml:"maxObservationAgeSeconds"`
		ObservationDeadlineSeconds         int    `yaml:"observationDeadlineSeconds"`
		TransportFailureIsNotMemberFailure bool   `yaml:"transportFailureIsNotMemberFailure"`
		Points                             []struct {
			ID        PointID     `yaml:"id"`
			Predicate PredicateID `yaml:"predicate"`
			Kind      string      `yaml:"kind"`
		} `yaml:"points"`
		Entry                   string    `yaml:"entry"`
		EntryPoints             []PointID `yaml:"entryPoints"`
		EntrySelector           string    `yaml:"entrySelector"`
		EntrySelectorIsObserved bool      `yaml:"entrySelectorIsObserved"`
		RunShapes               []struct {
			ID       string    `yaml:"id"`
			When     string    `yaml:"when"`
			Sequence []PointID `yaml:"sequence"`
		} `yaml:"runShapes"`
	} `yaml:"evaluation"`
}

// Parse validates and returns the contract in the given YAML.
func Parse(data []byte) (*Contract, error) {
	var r raw
	if err := yaml.Unmarshal(data, &r); err != nil {
		return nil, fmt.Errorf("parsing the topology contract: %w", err)
	}
	if r.Version != 1 {
		return nil, fmt.Errorf("topology contract version %d is not 1; this consumer implements v1", r.Version)
	}

	c := &Contract{
		Version:                            r.Version,
		CountKeyPattern:                    r.ControlPlane.CountKeyPattern,
		PermittedCounts:                    r.ControlPlane.PermittedCounts,
		DegradedCounts:                     r.ControlPlane.DegradedCounts,
		RemovalOfLastMember:                r.Quorum.RemovalOfLastMember,
		RemovalOfLastMemberGuidance:        strings.TrimSpace(r.Quorum.RemovalOfLastMemberGuidance),
		RaftIndexTolerance:                 r.Health.RaftIndexTolerance,
		MaxObservationAge:                  time.Duration(r.Evaluation.MaxObservationAgeSeconds) * time.Second,
		ObservationDeadline:                time.Duration(r.Evaluation.ObservationDeadlineSeconds) * time.Second,
		TransportFailureIsNotMemberFailure: r.Evaluation.TransportFailureIsNotMemberFailure,
		Entry:                              r.Evaluation.Entry,
		EntrySelector:                      r.Evaluation.EntrySelector,
		EntrySelectorIsObserved:            r.Evaluation.EntrySelectorIsObserved,
		quorumTable:                        r.Quorum.Table,
		predicates:                         map[PredicateID]Predicate{},
		points:                             map[PointID]PredicateID{},
		pointKinds:                         map[PointID]string{},
	}

	if err := requirePositive("health.raftIndexTolerance", c.RaftIndexTolerance >= 0); err != nil {
		return nil, err
	}
	if err := requirePositive("evaluation.maxObservationAgeSeconds", c.MaxObservationAge > 0); err != nil {
		return nil, err
	}
	if err := requirePositive("evaluation.observationDeadlineSeconds", c.ObservationDeadline > 0); err != nil {
		return nil, err
	}
	if c.ObservationDeadline > c.MaxObservationAge {
		return nil, fmt.Errorf(
			"evaluation.observationDeadlineSeconds (%s) exceeds maxObservationAgeSeconds (%s): a read allowed to take "+
				"longer than a result may live produces a reading that is stale the moment it arrives",
			c.ObservationDeadline, c.MaxObservationAge)
	}
	if len(c.PermittedCounts) == 0 {
		return nil, fmt.Errorf("controlPlane.permittedCounts is empty: no control-plane size would be allowed")
	}
	if len(c.quorumTable) == 0 {
		return nil, fmt.Errorf("quorum.table is empty: the formula would have nothing holding it honest")
	}

	declared := map[ConditionID]bool{}
	for _, cond := range r.Health.Conditions {
		if !implemented[cond.ID] {
			return nil, fmt.Errorf(
				"the topology contract declares health condition %q, which this Go consumer does not implement: "+
					"refusing to load rather than evaluate a guard with a condition missing", cond.ID)
		}
		declared[cond.ID] = true
	}

	used := map[ConditionID]bool{}
	for _, p := range r.Health.Predicates {
		if len(p.Conditions) == 0 {
			return nil, fmt.Errorf("predicate %q composes no conditions", p.ID)
		}
		for _, cond := range p.Conditions {
			if !declared[cond] {
				return nil, fmt.Errorf("predicate %q names condition %q, which health.conditions does not declare", p.ID, cond)
			}
			used[cond] = true
		}
		c.predicates[p.ID] = Predicate{
			ID:            p.ID,
			Summary:       strings.TrimSpace(p.Summary),
			EvaluatedOver: p.EvaluatedOver,
			Conditions:    append([]ConditionID(nil), p.Conditions...),
		}
	}

	// The generalised form of the defect that produced `survivable`: a value
	// published in the contract and consumed by no predicate is a rule nobody
	// applies. The TypeScript consumer asserts this too.
	for cond := range declared {
		if !used[cond] {
			return nil, fmt.Errorf("health condition %q is declared but no predicate composes it", cond)
		}
	}

	for _, pt := range r.Evaluation.Points {
		if _, ok := c.predicates[pt.Predicate]; !ok {
			return nil, fmt.Errorf("evaluation point %q names undefined predicate %q", pt.ID, pt.Predicate)
		}
		c.points[pt.ID] = pt.Predicate
		if pt.Kind != "" {
			if pt.Kind != KindEntry && pt.Kind != KindInRun {
				return nil, fmt.Errorf(
					"evaluation point %q declares kind %q, which is neither %q nor %q", pt.ID, pt.Kind, KindEntry, KindInRun)
			}
			c.pointKinds[pt.ID] = pt.Kind
		}
	}
	if len(c.points) == 0 {
		return nil, fmt.Errorf("evaluation.points is empty: no gate would be placed anywhere")
	}

	if err := c.parseEntryRule(r); err != nil {
		return nil, err
	}

	return c, nil
}

// parseEntryRule validates the exclusive-entry clause. The clause is additive to
// v1, so a revision that omits it loads; a revision that states an entry
// semantics or selector this consumer does not implement does not. Reading an
// unknown rule as the one we implement is how a consumer ends up evaluating the
// door's predicate mid-procedure, which is the defect the clause records.
func (c *Contract) parseEntryRule(r raw) error {
	if c.Entry != "" && c.Entry != EntryExclusive {
		return fmt.Errorf(
			"evaluation.entry is %q; this consumer implements only %q entry and will not read a different rule as that one",
			c.Entry, EntryExclusive)
	}
	if c.EntrySelector != "" && c.EntrySelector != SelectorObservedMembership {
		return fmt.Errorf(
			"evaluation.entrySelector is %q; this consumer selects the entry point only by %q",
			c.EntrySelector, SelectorObservedMembership)
	}
	if c.EntrySelector != "" && !c.EntrySelectorIsObserved {
		return fmt.Errorf(
			"evaluation.entrySelectorIsObserved is false: a caller-asserted entry point is the `--resume` flag ADR-035 " +
				"rejected, because asserting `resume` is how `survivable` ends up at the door")
	}

	kindEntry := map[PointID]bool{}
	for point, kind := range c.pointKinds {
		if kind == KindEntry {
			kindEntry[point] = true
		}
	}

	for _, point := range r.Evaluation.EntryPoints {
		if _, ok := c.points[point]; !ok {
			return fmt.Errorf("evaluation.entryPoints names %q, which evaluation.points does not declare", point)
		}
		if len(kindEntry) > 0 && !kindEntry[point] {
			return fmt.Errorf("evaluation.entryPoints names %q but that point declares kind %q",
				point, c.pointKinds[point])
		}
		c.entryPoints = append(c.entryPoints, point)
	}
	for point := range kindEntry {
		if len(c.entryPoints) > 0 && !c.IsEntryPoint(point) {
			return fmt.Errorf("evaluation point %q declares kind %q but evaluation.entryPoints omits it",
				point, KindEntry)
		}
	}
	if c.Entry != "" && len(c.entryPoints) == 0 {
		return fmt.Errorf("evaluation.entry is %q but evaluation.entryPoints is empty: no run could start anywhere",
			c.Entry)
	}

	for _, s := range r.Evaluation.RunShapes {
		if len(s.Sequence) == 0 {
			return fmt.Errorf("run shape %q has an empty sequence", s.ID)
		}
		for _, point := range s.Sequence {
			if _, ok := c.points[point]; !ok {
				return fmt.Errorf("run shape %q names point %q, which evaluation.points does not declare", s.ID, point)
			}
		}
		if len(c.entryPoints) > 0 && !c.IsEntryPoint(s.Sequence[0]) {
			return fmt.Errorf("run shape %q starts at %q, which is not an entry point", s.ID, s.Sequence[0])
		}
		c.runShapes = append(c.runShapes, RunShape{ID: s.ID, When: strings.TrimSpace(s.When), Sequence: s.Sequence})
	}

	return nil
}

func requirePositive(field string, ok bool) error {
	if ok {
		return nil
	}
	return fmt.Errorf("%s is missing or not positive in the topology contract", field)
}

var (
	loadOnce sync.Once
	loaded   *Contract
	loadErr  error
)

// Load returns the embedded contract, parsed once.
func Load() (*Contract, error) {
	loadOnce.Do(func() {
		loaded, loadErr = Parse(contracts.ClusterTopologyV1)
	})
	return loaded, loadErr
}
