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
	// ExpectedMembers is the default control-plane size. It is only a
	// default: every check takes the expected count as an argument so a
	// fork running one or five control planes is measured against its own
	// cluster, not against this repo's three.
	ExpectedMembers = 3

	// DefaultRaftTolerance is how far behind the highest RAFT INDEX a
	// member may be and still count as caught up. The members are queried
	// at slightly different moments on a cluster that keeps writing, so
	// exact equality is not a usable gate; a member many indices behind is
	// still catching up and must not be counted towards quorum.
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

	return Health{OK: len(problems) == 0, Problems: problems}
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

// CheckRemoval decides whether removing one member from a cluster of `size`
// members, of which `healthyRemaining` of the others are healthy, keeps a
// quorum.
//
// Two separate conditions have to hold and both are checked here:
//
//   - The removal itself is a raft write, so the cluster must have quorum
//     *now*, at its current size — a 3-member cluster with one member already
//     down cannot commit the removal of a second.
//   - The cluster left behind must still be able to elect a leader, so the
//     healthy survivors must reach quorum at the post-removal size.
//
// The raft-lag tolerance is not a parameter here: it is applied by
// CheckHealth, whose verdict is what produces healthyRemaining.
func CheckRemoval(size, healthyRemaining int) RemovalSafety {
	after := size - 1
	quorumAfter := Quorum(after)
	res := RemovalSafety{SizeAfter: after, QuorumAfter: quorumAfter}

	switch {
	case size <= 1:
		res.Reason = fmt.Sprintf(
			"refusing to remove the only etcd member (cluster size %d): the removal would destroy the cluster", size)
		return res
	case healthyRemaining+1 < Quorum(size):
		// +1 counts the member being removed, which is still voting now.
		res.Reason = fmt.Sprintf(
			"etcd has %d healthy member(s) of %d; the removal itself needs a quorum of %d to commit",
			healthyRemaining+1, size, Quorum(size))
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
