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
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultRaftTolerance is how far behind the highest RAFT INDEX a
	// member may be and still count as caught up. The members are queried
	// at slightly different moments on a cluster that keeps writing, so
	// exact equality is not a usable gate; a member many indices behind is
	// still catching up and must not be counted towards quorum.
	//
	// This is the contract's `raftIndexTolerance`, not an independent
	// constant. It is duplicated here only until the topology-contract
	// loader lands (contracts/cluster/topology.v1.yaml, ADR-034); at that
	// point this declaration is deleted and the value is read from the
	// contract. Callers may only *tighten* it — a larger tolerance makes
	// raft-index-converged weaker on a destructive path, so the flag that
	// feeds it refuses to loosen it.
	DefaultRaftTolerance int64 = 10
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

// Health is the verdict of the health gate.
type Health struct {
	OK bool
	// Problems are the human-readable reasons the cluster is not whole,
	// empty when OK. A refusal message quotes these verbatim so the
	// operator is told which member is at fault, not just "unhealthy".
	Problems []string
}

// CheckHealth is the runbook's gate, ported from etcdHealth in
// scripts/cp-storage-migrate.ts: exactly `expected` members answered, no
// ERRORS, no learner, exactly one agreed leader, and every RAFT INDEX within
// `tolerance` of the highest.
func CheckHealth(members []Status, expected int, tolerance int64) Health {
	var problems []string

	if len(members) != expected {
		problems = append(problems, fmt.Sprintf("%d member(s) answered, expected %d", len(members), expected))
	}
	problems = append(problems, convergenceProblems(members, tolerance)...)
	return Health{OK: len(problems) == 0, Problems: problems}
}

// convergenceProblems is the contract's four per-member conditions —
// no-errors, no-learners, single-leader and raft-index-converged — evaluated
// over the members that answered. It deliberately says nothing about *how
// many* answered: that is the one condition `whole` and `survivable` differ
// on, so it is the caller's, and keeping it out of here is what stops
// `survivable` from accidentally relaxing anything else.
func convergenceProblems(members []Status, tolerance int64) []string {
	var problems []string

	for _, m := range members {
		if m.Errors != "" {
			problems = append(problems, fmt.Sprintf("%s: ERRORS %s", m.Node, m.Errors))
		}
	}
	for _, m := range members {
		if m.Learner {
			problems = append(problems, fmt.Sprintf("%s is a learner", m.Node))
		}
	}
	for _, m := range members {
		if !m.HasRaftIndex {
			problems = append(problems, fmt.Sprintf("%s has no RAFT INDEX", m.Node))
		}
	}

	var indices []int64
	for _, m := range members {
		if m.HasRaftIndex {
			indices = append(indices, m.RaftIndex)
		}
	}
	if len(indices) > 1 {
		highest := indices[0]
		for _, i := range indices[1:] {
			if i > highest {
				highest = i
			}
		}
		for _, m := range members {
			if m.HasRaftIndex && highest-m.RaftIndex > tolerance {
				problems = append(problems, fmt.Sprintf(
					"%s RAFT INDEX %d is %d behind %d (tolerance %d)",
					m.Node, m.RaftIndex, highest-m.RaftIndex, highest, tolerance))
			}
		}
	}

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
			problems = append(problems, fmt.Sprintf("members disagree about the leader (%s)", strings.Join(names, ", ")))
		}
	}

	return problems
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

// Quorum is the number of members that must agree in a cluster of `size`.
func Quorum(size int) int {
	if size <= 0 {
		return 0
	}
	return size/2 + 1
}

// MaxUnavailable is how many members of a cluster of `size` may be absent
// while the cluster still has quorum.
func MaxUnavailable(size int) int {
	if size <= 0 {
		return 0
	}
	return size - Quorum(size)
}

// Predicate is a named health gate. The two names, and the conditions behind
// them, are the ones in contracts/cluster/topology.v1.yaml (ADR-034).
type Predicate string

const (
	// Whole requires every expected member present and converged. It is the
	// gate for "the cluster is finished and fault-tolerant again".
	Whole Predicate = "whole"

	// Survivable relaxes Whole in exactly one way and no other: the members
	// absent may only be the ones this operation declared as its targets,
	// and there must still be a quorum. It is the gate at the moment a
	// destructive step is about to run, and on resume — the two points where
	// the cluster is deliberately short a member, so Whole is unsatisfiable
	// by construction and a Whole gate there would abort mid-procedure.
	Survivable Predicate = "survivable"
)

// Observation is what one evaluation point actually saw. It is the whole
// input to a predicate: nothing is read from a constant or from the
// environment, so a gate is reproducible from its Observation alone.
type Observation struct {
	// Expected are the control-plane addresses derived from the ConfigSet's
	// CP<n>_IP keys. This — never the live member list — is the cluster
	// size the quorum arithmetic is measured against. Sizing quorum off the
	// live list is how a cluster that is already a member short consents to
	// losing another one.
	Expected []string

	// Members is the live `etcd members` list, used to catch a member at an
	// address that is not a configured control plane.
	Members []Member

	// Statuses are the `etcd status` rows that came back. An expected
	// address with no row here counts as absent, whether it was queried and
	// did not answer or was deliberately not queried at all.
	Statuses []Status

	// Declared are the addresses this operation has declared as its targets:
	// the absences it is allowed to explain. For `talos recreate` that is
	// the single node being replaced.
	Declared []string
}

// Verdict is the result of evaluating a predicate.
type Verdict struct {
	OK        bool
	Predicate Predicate
	// Problems are the failed conditions, named individually so a refusal
	// tells the operator which condition failed and with what arithmetic.
	Problems []string
	// Absent are the expected addresses that did not report a status row.
	Absent []string
	// Undeclared are the absent addresses this operation did not declare —
	// the ones that mean "this cluster is degraded" rather than "this
	// procedure is in flight".
	Undeclared []string
	// Answered is how many expected members reported a status row.
	Answered int
}

// Evaluate is the fail-closed gate. Anything it could not establish counts
// against proceeding: an unparseable status table produces no rows, so every
// member reads as absent and the verdict is not-OK — never "nothing to
// report, carry on".
func Evaluate(p Predicate, obs Observation, tolerance int64) Verdict {
	size := len(obs.Expected)
	answeredAt := map[string]bool{}
	for _, s := range obs.Statuses {
		if s.Node != "" {
			answeredAt[s.Node] = true
		}
	}

	v := Verdict{Predicate: p}
	for _, ip := range obs.Expected {
		if answeredAt[ip] {
			v.Answered++
			continue
		}
		v.Absent = append(v.Absent, ip)
		if !containsString(obs.Declared, ip) {
			v.Undeclared = append(v.Undeclared, ip)
		}
	}

	// A member at an address that is not a configured control plane fails
	// both predicates. That is #39's own wreckage: a stale member left at an
	// address the ConfigSet no longer describes, or a second member at an
	// address that already has one.
	var unexpected []string
	for _, ip := range MemberIPs(obs.Members) {
		if !containsString(obs.Expected, ip) {
			unexpected = append(unexpected, ip)
		}
	}

	if size == 0 {
		v.Problems = append(v.Problems,
			"no control-plane addresses are configured, so there is no cluster size to measure against")
	}
	for _, ip := range unexpected {
		v.Problems = append(v.Problems, fmt.Sprintf(
			"etcd member at %s is not one of the configured control planes (%s)", ip, strings.Join(obs.Expected, ", ")))
	}

	switch p {
	case Whole:
		if len(v.Absent) > 0 {
			v.Problems = append(v.Problems, fmt.Sprintf(
				"%d of %d expected member(s) did not report: %s", len(v.Absent), size, strings.Join(v.Absent, ", ")))
		}
	case Survivable:
		// quorum-present.
		if q := Quorum(size); v.Answered < q {
			v.Problems = append(v.Problems, fmt.Sprintf(
				"only %d of %d expected member(s) answered; a quorum of %d is required", v.Answered, size, q))
		}
		if mu := MaxUnavailable(size); len(v.Absent) > mu {
			v.Problems = append(v.Problems, fmt.Sprintf(
				"%d member(s) absent (%s) but a %d-member cluster tolerates at most %d",
				len(v.Absent), strings.Join(v.Absent, ", "), size, mu))
		}
		// absences-are-declared. This is the condition that tells a
		// procedure in flight apart from a degraded cluster, and it is the
		// only reason Survivable is safe to be laxer than Whole.
		if len(v.Undeclared) > 0 {
			v.Problems = append(v.Problems, fmt.Sprintf(
				"member(s) %s are absent and are not a declared target of this operation (declared: %s) — "+
					"this cluster is degraded, not mid-procedure", strings.Join(v.Undeclared, ", "), declaredList(obs.Declared)))
		}
	default:
		v.Problems = append(v.Problems, fmt.Sprintf("unknown predicate %q", p))
	}

	// The four per-member conditions apply identically under both
	// predicates, over whichever members answered.
	v.Problems = append(v.Problems, convergenceProblems(obs.Statuses, tolerance)...)

	v.OK = len(v.Problems) == 0
	return v
}

// Reason renders a verdict's problems for a refusal message.
func (v Verdict) Reason() string {
	if len(v.Problems) == 0 {
		return ""
	}
	return strings.Join(v.Problems, "; ")
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
func CheckRemoval(expected, healthyRemaining int) RemovalSafety {
	after := expected - 1
	quorumAfter := Quorum(after)
	res := RemovalSafety{SizeAfter: after, QuorumAfter: quorumAfter}

	switch {
	case expected <= 1:
		res.Reason = fmt.Sprintf(
			"refusing to remove the only etcd member of a %d-member control plane: recreating the sole etcd "+
				"member is a snapshot-restore operation, not a member removal — see docs/runbooks/talos-upgrade.md "+
				"(Scenario 1: restore etcd from a snapshot)", expected)
		return res
	case healthyRemaining+1 < Quorum(expected):
		// +1 counts the member being removed, which is still voting now.
		res.Reason = fmt.Sprintf(
			"etcd has %d healthy member(s) of %d; the removal itself needs a quorum of %d to commit",
			healthyRemaining+1, expected, Quorum(expected))
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
