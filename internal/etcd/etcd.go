// Package etcd holds the pure parsers and safety rules for the Talos etcd
// control plane: the `talosctl etcd status` and `talosctl etcd members`
// tabwriter tables, the health gate a destructive operation must pass, and
// the quorum arithmetic behind "is it safe to remove this member".
//
// The rules are a port of the ones already proven in
// scripts/cp-storage-migrate.ts (parseEtcdStatus / etcdHealth /
// EXPECTED_MEMBERS / DEFAULT_RAFT_TOLERANCE) so the Go CLI and the TypeScript
// migration tool cannot drift into two different definitions of "healthy".
// Per ADR-030 the distributable CLI is Go, so `homelab talos recreate` reads
// the rule from here.
//
// Everything in this file is pure: no exec, no network. The callers in
// cmd/homelab/commands own the talosctl invocations.
package etcd

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/topology"
)

// Status is one row of `talosctl etcd status`.
type Status struct {
	Node   string
	Member string
	Leader string
	// RaftIndex is only meaningful when HasRaftIndex is true; a row whose
	// RAFT INDEX did not parse is a member that did not really answer.
	RaftIndex    int64
	HasRaftIndex bool
	RaftTerm     int64
	Learner      bool
	Errors       string
}

// Member is one row of `talosctl etcd members`.
type Member struct {
	Node     string
	ID       string
	Hostname string
	// PeerURLs and ClientURLs are the raw comma-separated values split on
	// ",". The IP of the machine backing a member is read from these.
	PeerURLs   []string
	ClientURLs []string
	Learner    bool
}

// headerCell is a column of a tabwriter table: its name and the byte offset
// the column starts at on the header line.
type headerCell struct {
	name  string
	start int
}

// headerOffsets returns the columns of a tabwriter header line. Header names
// may contain single spaces ("RAFT INDEX", "PEER URLS"), so the cells are
// split on runs of two or more spaces, never on a single space.
func headerOffsets(header string) []headerCell {
	var cells []headerCell
	pos := 0
	for _, name := range splitOnGaps(header) {
		start := strings.Index(header[pos:], name)
		if start < 0 {
			continue
		}
		start += pos
		cells = append(cells, headerCell{name: name, start: start})
		pos = start + len(name)
	}
	return cells
}

// splitOnGaps splits a header line on runs of two or more spaces, dropping
// empty fields.
func splitOnGaps(header string) []string {
	var out []string
	for _, f := range strings.Split(strings.TrimSpace(header), "  ") {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// cellReader returns a function that slices a data line by the column
// offsets of its header.
func cellReader(cells []headerCell) func(line, name string) string {
	return func(line, name string) string {
		for i, c := range cells {
			if c.name != name {
				continue
			}
			if c.start >= len(line) {
				return ""
			}
			end := len(line)
			if i+1 < len(cells) && cells[i+1].start < end {
				end = cells[i+1].start
			}
			return strings.TrimSpace(line[c.start:end])
		}
		return ""
	}
}

// nonEmptyLines splits text into lines, dropping blank ones.
func nonEmptyLines(text string) []string {
	var out []string
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimSpace(strings.TrimRight(l, "\r")) != "" {
			out = append(out, strings.TrimRight(l, "\r\n"))
		}
	}
	return out
}

// ParseStatus parses `talosctl -n a,b,c etcd status`. It understands both the
// MEMBER and the ID column layouts; ERRORS is often empty. A table with no
// recognisable header yields no rows rather than an error, and the caller
// treats "no rows" as "the cluster did not answer" — which fails the health
// gate, so an unparsed table can never read as healthy.
func ParseStatus(text string) []Status {
	lines := nonEmptyLines(text)
	headerIdx := -1
	for i, l := range lines {
		if strings.Contains(l, "NODE") && strings.Contains(l, "RAFT INDEX") {
			headerIdx = i
			break
		}
	}
	if headerIdx < 0 {
		return nil
	}
	cells := headerOffsets(lines[headerIdx])
	cell := cellReader(cells)
	memberCol := "ID"
	for _, c := range cells {
		if c.name == "MEMBER" {
			memberCol = "MEMBER"
			break
		}
	}

	var out []Status
	for _, line := range lines[headerIdx+1:] {
		node := cell(line, "NODE")
		if node == "" {
			continue
		}
		raftIndex, indexOK := parseInt64(cell(line, "RAFT INDEX"))
		raftTerm, _ := parseInt64(cell(line, "RAFT TERM"))
		out = append(out, Status{
			Node:         node,
			Member:       cell(line, memberCol),
			Leader:       cell(line, "LEADER"),
			RaftIndex:    raftIndex,
			HasRaftIndex: indexOK,
			RaftTerm:     raftTerm,
			Learner:      strings.EqualFold(cell(line, "LEARNER"), "true"),
			Errors:       cell(line, "ERRORS"),
		})
	}
	return out
}

// ParseMembers parses `talosctl -n <ip> etcd members`. The ID string is kept
// verbatim: `talosctl etcd remove-member` takes the same representation the
// members table prints, so passing it through avoids any hex/decimal
// ambiguity in the round trip.
func ParseMembers(text string) []Member {
	lines := nonEmptyLines(text)
	headerIdx := -1
	for i, l := range lines {
		if strings.Contains(l, "NODE") && strings.Contains(l, "ID") && strings.Contains(l, "PEER URLS") {
			headerIdx = i
			break
		}
	}
	if headerIdx < 0 {
		return nil
	}
	cells := headerOffsets(lines[headerIdx])
	cell := cellReader(cells)

	var out []Member
	for _, line := range lines[headerIdx+1:] {
		id := cell(line, "ID")
		if id == "" {
			continue
		}
		out = append(out, Member{
			Node:       cell(line, "NODE"),
			ID:         id,
			Hostname:   cell(line, "HOSTNAME"),
			PeerURLs:   splitURLs(cell(line, "PEER URLS")),
			ClientURLs: splitURLs(cell(line, "CLIENT URLS")),
			Learner:    strings.EqualFold(cell(line, "LEARNER"), "true"),
		})
	}
	return out
}

func splitURLs(s string) []string {
	var out []string
	for _, u := range strings.Split(s, ",") {
		if u = strings.TrimSpace(u); u != "" {
			out = append(out, u)
		}
	}
	return out
}

func parseInt64(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// conditionProblems evaluates one of the contract's per-member condition
// atoms over the members that answered, and returns the reasons it failed.
//
// One function per condition id, dispatched from the predicate's own
// condition list, is what keeps the two gates honest against each other: a
// predicate cannot skip a check by being written differently, only by the
// contract naming fewer conditions.
func conditionProblems(cond topology.ConditionID, members []Status, tolerance int64) []string {
	var problems []string

	switch cond {
	case topology.NoErrors:
		for _, m := range members {
			if m.Errors != "" {
				problems = append(problems, fmt.Sprintf("%s: ERRORS %s", m.Node, m.Errors))
			}
		}
	case topology.NoLearners:
		for _, m := range members {
			if m.Learner {
				problems = append(problems, fmt.Sprintf("%s is a learner", m.Node))
			}
		}
	case topology.RaftIndexConverged:
		for _, m := range members {
			if !m.HasRaftIndex {
				problems = append(problems, fmt.Sprintf("%s has no RAFT INDEX", m.Node))
			}
		}
		if highest, ok := highestRaftIndex(members); ok {
			for _, m := range members {
				if m.HasRaftIndex && highest-m.RaftIndex > tolerance {
					problems = append(problems, fmt.Sprintf(
						"%s RAFT INDEX %d is %d behind %d (tolerance %d)",
						m.Node, m.RaftIndex, highest-m.RaftIndex, highest, tolerance))
				}
			}
		}
	case topology.SingleLeader:
		leaders := map[string]struct{}{}
		for _, m := range members {
			if m.Leader != "" {
				leaders[m.Leader] = struct{}{}
			}
		}
		if len(members) > 0 && len(leaders) != 1 {
			if len(leaders) == 0 {
				problems = append(problems, "no leader reported")
			} else {
				names := make([]string, 0, len(leaders))
				for l := range leaders {
					names = append(names, l)
				}
				sort.Strings(names)
				problems = append(problems, fmt.Sprintf("members disagree about the leader (%s)", strings.Join(names, ", ")))
			}
		}
	}

	return problems
}

// highestRaftIndex returns the highest index reported, and whether more than
// one member reported one at all: a single member is trivially converged with
// itself, so there is nothing to compare.
func highestRaftIndex(members []Status) (int64, bool) {
	var indices []int64
	for _, m := range members {
		if m.HasRaftIndex {
			indices = append(indices, m.RaftIndex)
		}
	}
	if len(indices) < 2 {
		return 0, false
	}
	highest := indices[0]
	for _, i := range indices[1:] {
		if i > highest {
			highest = i
		}
	}
	return highest, true
}

// HealthyCount is how many of the given members are individually fit to
// count towards quorum: they answered, reported no ERRORS, are not learners,
// and are within `tolerance` of the highest RAFT INDEX seen.
//
// CheckHealth is the whole-cluster gate and stays the thing that decides
// whether to proceed; this is the per-member count the quorum arithmetic
// needs, so a refusal can say "only 1 remaining member is healthy" instead of
// collapsing every failure to zero.
func HealthyCount(members []Status, tolerance int64) int {
	var highest int64
	seen := false
	for _, m := range members {
		if m.HasRaftIndex && (!seen || m.RaftIndex > highest) {
			highest = m.RaftIndex
			seen = true
		}
	}
	n := 0
	for _, m := range members {
		if m.Errors != "" || m.Learner || !m.HasRaftIndex {
			continue
		}
		if seen && highest-m.RaftIndex > tolerance {
			continue
		}
		n++
	}
	return n
}

// Observation is what one evaluation point actually saw. It is the whole
// input to a predicate: nothing is read from a constant or from the
// environment, so a gate is reproducible from its Observation alone.
type Observation struct {
	// Expected are the control-plane addresses the resolver derived from the
	// ConfigSet (config.ResolvedConfig.ControlPlane). Their COUNT is the
	// expectation the observation is compared against — it is never the
	// enumeration the member set is built from. A consumer that dials the
	// addresses it derived and then asserts that many answered has restated
	// its own input; see health.memberSetSource in the contract.
	Expected []string

	// Members is etcd's own membership, from `etcd members`. This, and not
	// the address list, is the observed member set.
	Members []Member

	// Statuses are the `etcd status` rows that came back. A member of the
	// observed membership with no row here did not answer.
	Statuses []Status

	// Declared are the addresses this operation has declared as its targets:
	// the absences it is allowed to explain. For `talos recreate` that is
	// the single node being replaced.
	Declared []string

	// TransportErrors are dial, deadline or apid failures encountered while
	// reading. The contract forbids flattening these into "N member(s)
	// answered": etcd healthy behind a wedged apid is a different fault from
	// etcd being down, and both refuse, but the operator is told which.
	TransportErrors []string

	// ObservedAt is when the member set was read. An evaluation older than
	// the contract's maxObservationAge is stale, therefore indeterminate,
	// therefore unsafe — it is never reused for a later gate.
	ObservedAt time.Time

	// EvaluatedAt defaults to now; tests set it to make staleness testable
	// without sleeping.
	EvaluatedAt time.Time
}

// Verdict is the result of evaluating a predicate.
type Verdict struct {
	OK        bool
	Predicate topology.PredicateID
	// Problems are the failed conditions, named individually so a refusal
	// tells the operator which condition failed and with what arithmetic.
	Problems []string
	// Absent are the members of etcd's membership that did not answer.
	Absent []string
	// Undeclared are the absent members this operation did not declare —
	// the ones that mean "this cluster is degraded" rather than "this
	// procedure is in flight".
	Undeclared []string
	// Answered is how many members of etcd's membership reported a status.
	Answered int
	// Unrepresented are configured control-plane addresses with no member in
	// etcd's membership at all. They are not absences — a removed member is
	// not an expected member — but they are the difference between telling
	// the operator "your 2-member cluster is too small to touch" and telling
	// them which member an earlier run left out.
	Unrepresented []string
}

// Evaluate is the fail-closed gate: it applies exactly the conditions the
// contract composes into the given predicate, and anything it could not
// establish counts against proceeding. An unparseable status table produces
// no rows, so every member reads as absent and the verdict is not-OK — never
// "nothing to report, carry on".
func Evaluate(c *topology.Contract, p topology.Predicate, obs Observation) Verdict {
	// The derived count is the expectation; etcd's membership is the
	// observation. Keeping these apart is what makes member-count able to
	// fail at all.
	count := len(obs.Expected)
	membership := MemberIPs(obs.Members)

	answeredAt := map[string]bool{}
	for _, s := range obs.Statuses {
		if s.Node != "" {
			answeredAt[s.Node] = true
		}
	}

	v := Verdict{Predicate: p.ID}
	for _, ip := range obs.Expected {
		if !containsString(membership, ip) {
			v.Unrepresented = append(v.Unrepresented, ip)
		}
	}
	for _, ip := range membership {
		if answeredAt[ip] {
			v.Answered++
			continue
		}
		v.Absent = append(v.Absent, ip)
		if !containsString(obs.Declared, ip) {
			v.Undeclared = append(v.Undeclared, ip)
		}
	}

	// Indeterminate inputs, before any condition. Silence is never consent
	// on a path that destroys a node.
	if count == 0 {
		v.Problems = append(v.Problems,
			"no control-plane addresses are configured, so there is no expected size to measure against")
	}
	if len(obs.Members) == 0 {
		v.Problems = append(v.Problems,
			"etcd reported no membership: the member set is unknown, not empty")
	}
	for _, e := range obs.TransportErrors {
		v.Problems = append(v.Problems, fmt.Sprintf(
			"could not reach etcd through Talos apid, so this is a transport fault and not a member fault: %s", e))
	}
	if stale := staleness(c, obs); stale != "" {
		v.Problems = append(v.Problems, stale)
	}

	for _, cond := range p.Conditions {
		switch cond {
		case topology.MemberCount:
			if len(membership) != count {
				v.Problems = append(v.Problems, fmt.Sprintf(
					"etcd has %d member(s) (%s) but %d control-plane address(es) are configured (%s)",
					len(membership), strings.Join(membership, ", "), count, strings.Join(obs.Expected, ", ")))
			}
			if len(v.Absent) > 0 {
				v.Problems = append(v.Problems, fmt.Sprintf(
					"%d of %d member(s) did not answer: %s", len(v.Absent), len(membership), strings.Join(v.Absent, ", ")))
			}
		case topology.QuorumPresent:
			if q := c.Quorum(count); v.Answered < q {
				v.Problems = append(v.Problems, fmt.Sprintf(
					"only %d member(s) answered; a %d-member control plane needs a quorum of %d%s",
					v.Answered, count, q, unrepresentedSuffix(v.Unrepresented)))
			}
			if mu := c.MaxUnavailable(count); len(v.Absent) > mu {
				v.Problems = append(v.Problems, fmt.Sprintf(
					"%d member(s) absent (%s) but a %d-member control plane tolerates at most %d",
					len(v.Absent), strings.Join(v.Absent, ", "), count, mu))
			}
		case topology.AbsencesAreDeclared:
			if len(v.Undeclared) > 0 {
				v.Problems = append(v.Problems, fmt.Sprintf(
					"member(s) %s are absent and are not a declared target of this operation (declared: %s) — "+
						"this cluster is degraded, not mid-procedure",
					strings.Join(v.Undeclared, ", "), declaredList(obs.Declared)))
			}
		default:
			v.Problems = append(v.Problems, conditionProblems(cond, obs.Statuses, c.RaftIndexTolerance)...)
		}
	}

	v.OK = len(v.Problems) == 0
	return v
}

// staleness enforces the contract's observation window. A reading older than
// maxObservationAge is not "immediately before" anything, so it is
// indeterminate and must be taken again rather than reused.
func staleness(c *topology.Contract, obs Observation) string {
	if obs.ObservedAt.IsZero() {
		return "the member set carries no observation time, so its age cannot be checked"
	}
	at := obs.EvaluatedAt
	if at.IsZero() {
		at = time.Now()
	}
	if age := at.Sub(obs.ObservedAt); age > c.MaxObservationAge {
		return fmt.Sprintf(
			"this reading of etcd is %s old and the contract allows at most %s: a stale observation is "+
				"indeterminate, so it is taken again rather than acted on",
			age.Truncate(time.Second), c.MaxObservationAge)
	}
	return ""
}

// Reason renders a verdict's problems for a refusal message.
func (v Verdict) Reason() string {
	if len(v.Problems) == 0 {
		return ""
	}
	return strings.Join(v.Problems, "; ")
}

// unrepresentedSuffix names the configured control planes etcd has no member
// for. Without it a resumed run on a cluster an earlier removal left short
// reports only that the cluster is too small, which is true and useless: the
// operator needs to know which member is missing to know what to repair.
func unrepresentedSuffix(ips []string) string {
	if len(ips) == 0 {
		return ""
	}
	return fmt.Sprintf(" — etcd has no member at all for configured control plane(s) %s, "+
		"which an earlier removal would explain", strings.Join(ips, ", "))
}

func declaredList(declared []string) string {
	if len(declared) == 0 {
		return "none"
	}
	return strings.Join(declared, ", ")
}

func containsString(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}

// RemovalSafety is the verdict on removing one member from a cluster.
type RemovalSafety struct {
	OK bool
	// Reason names why the removal is refused, empty when OK.
	Reason string
	// SizeAfter and QuorumAfter describe the cluster the removal leaves
	// behind, so the refusal message can show the arithmetic.
	SizeAfter   int
	QuorumAfter int
}

// CheckRemoval decides whether removing one member from a cluster whose
// expected size is `expected`, and of which `healthyRemaining` of the other
// members are healthy, keeps a quorum.
//
// `expected` is the configured control-plane count, NEVER the length of the
// live member list. Sizing this off the live list is unsound: a cluster that a
// crashed earlier run already left at 2 of 3 would be measured as a 2-member
// cluster, Quorum(1) is 1, and the removal of a second member would be
// consented to — taking a 3-node control plane to one member. The live list
// is an observation; the expected size is the contract.
//
// Two separate conditions have to hold and both are checked here:
//
//   - The removal itself is a raft write, so the cluster must have quorum
//     *now*, at its expected size — a 3-member cluster with one member already
//     down cannot commit the removal of a second.
//   - The cluster left behind must still be able to elect a leader, so the
//     healthy survivors must reach quorum at the post-removal size.
//
// The raft-lag tolerance is not a parameter here: it is applied by
// CheckHealth, whose verdict is what produces healthyRemaining.
func CheckRemoval(c *topology.Contract, expected, healthyRemaining int) RemovalSafety {
	after := expected - 1
	quorumAfter := c.Quorum(after)
	res := RemovalSafety{SizeAfter: after, QuorumAfter: quorumAfter}

	switch {
	case expected <= 1:
		// quorum.removalOfLastMember: refuse, with the contract's own
		// guidance rather than bare arithmetic — recreating the sole member
		// is a restore, and the operator needs to be told which procedure
		// applies, not that 1 is less than 1.
		res.Reason = fmt.Sprintf(
			"refusing to remove the only etcd member of a %d-member control plane. %s",
			expected, c.RemovalOfLastMemberGuidance)
		return res
	case healthyRemaining+1 < c.Quorum(expected):
		// +1 counts the member being removed, which is still voting now.
		res.Reason = fmt.Sprintf(
			"etcd has %d healthy member(s) of %d; the removal itself needs a quorum of %d to commit",
			healthyRemaining+1, expected, c.Quorum(expected))
		return res
	case healthyRemaining < quorumAfter:
		res.Reason = fmt.Sprintf(
			"removing this member leaves %d member(s) needing a quorum of %d, but only %d remaining member(s) are healthy",
			after, quorumAfter, healthyRemaining)
		return res
	}

	res.OK = true
	return res
}

// FindMemberByIP returns the member whose peer or client URL points at ip.
// Kubernetes and Talos disagree about a node's name — Talos assigns a fresh
// random hostname on every boot — so the IP is the only stable join between a
// terragrunt node key and an etcd member.
func FindMemberByIP(members []Member, ip string) (Member, bool) {
	for _, m := range members {
		for _, raw := range append(append([]string{}, m.PeerURLs...), m.ClientURLs...) {
			if urlHost(raw) == ip {
				return m, true
			}
		}
	}
	return Member{}, false
}

// urlHost returns the host of a peer/client URL, tolerating a bare host:port.
func urlHost(raw string) string {
	if u, err := url.Parse(raw); err == nil && u.Host != "" {
		return u.Hostname()
	}
	if h, _, found := strings.Cut(raw, ":"); found {
		return h
	}
	return raw
}

// MemberIPs returns the peer IPs of the given members, in order, skipping any
// member whose peer URL does not parse to a host.
func MemberIPs(members []Member) []string {
	var out []string
	for _, m := range members {
		for _, raw := range m.PeerURLs {
			if h := urlHost(raw); h != "" {
				out = append(out, h)
				break
			}
		}
	}
	return out
}

// Without returns members with the member whose ID is id removed.
func Without(members []Member, id string) []Member {
	out := make([]Member, 0, len(members))
	for _, m := range members {
		if m.ID != id {
			out = append(out, m)
		}
	}
	return out
}

// HasID reports whether a member with the given ID is still in the list. This
// is the idempotency check and the post-removal verification: the outgoing
// member must be absent before anything destructive runs.
func HasID(members []Member, id string) bool {
	for _, m := range members {
		if m.ID == id {
			return true
		}
	}
	return false
}

// SnapshotName is the etcd snapshot file name for a run started at `at`,
// matching the naming scripts/cp-storage-migrate.ts already writes.
func SnapshotName(at time.Time) string {
	return fmt.Sprintf("etcd-%s.snapshot", at.UTC().Format("20060102T150405Z"))
}
