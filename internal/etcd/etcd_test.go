package etcd

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// table renders headers and rows the way talosctl's tabwriter does: every
// column padded to the widest cell plus a two-space gap, so a header name
// that itself contains a single space ("RAFT INDEX") still starts at a fixed
// offset. Fixtures are built with it so a test stays readable; the
// hand-transcribed literals below guard the helper itself against drift.
func table(headers []string, rows [][]string) string {
	widths := make([]int, len(headers))
	for i, h := range headers {
		widths[i] = len(h)
		for _, r := range rows {
			if i < len(r) && len(r[i]) > widths[i] {
				widths[i] = len(r[i])
			}
		}
	}
	line := func(cells []string) string {
		var b strings.Builder
		for i := range headers {
			c := ""
			if i < len(cells) {
				c = cells[i]
			}
			b.WriteString(c)
			if i < len(headers)-1 {
				b.WriteString(strings.Repeat(" ", widths[i]-len(c)+2))
			}
		}
		return strings.TrimRight(b.String(), " ")
	}
	out := []string{line(headers)}
	for _, r := range rows {
		out = append(out, line(r))
	}
	return strings.Join(out, "\n") + "\n"
}

var statusHeaders = []string{
	"NODE", "MEMBER", "DB SIZE", "IN USE", "LEADER", "RAFT INDEX", "RAFT TERM", "LEARNER", "ERRORS",
}

func statusRow(node, member, leader, index string) []string {
	return []string{node, member, "21 MB", "14 MB (66.67%)", leader, index, "42", "false", ""}
}

func healthyStatusTable() string {
	return table(statusHeaders, [][]string{
		statusRow("10.10.0.11", "a1b2c3d4e5f60001", "a1b2c3d4e5f60002", "9182736"),
		statusRow("10.10.0.12", "a1b2c3d4e5f60002", "a1b2c3d4e5f60002", "9182740"),
		statusRow("10.10.0.13", "a1b2c3d4e5f60003", "a1b2c3d4e5f60002", "9182738"),
	})
}

func TestParseStatus(t *testing.T) {
	got := ParseStatus(healthyStatusTable())
	if len(got) != 3 {
		t.Fatalf("ParseStatus returned %d rows, want 3: %+v", len(got), got)
	}
	if got[0].Node != "10.10.0.11" {
		t.Errorf("Node = %q, want 10.10.0.11", got[0].Node)
	}
	if got[0].Member != "a1b2c3d4e5f60001" {
		t.Errorf("Member = %q, want a1b2c3d4e5f60001", got[0].Member)
	}
	if got[0].Leader != "a1b2c3d4e5f60002" {
		t.Errorf("Leader = %q, want a1b2c3d4e5f60002", got[0].Leader)
	}
	if !got[0].HasRaftIndex || got[0].RaftIndex != 9182736 {
		t.Errorf("RaftIndex = %d (ok=%t), want 9182736", got[0].RaftIndex, got[0].HasRaftIndex)
	}
	if got[0].RaftTerm != 42 {
		t.Errorf("RaftTerm = %d, want 42", got[0].RaftTerm)
	}
	if got[0].Learner {
		t.Error("Learner = true, want false")
	}
	if got[0].Errors != "" {
		t.Errorf("Errors = %q, want empty", got[0].Errors)
	}
}

// The ID layout is the other column set talosctl emits; the parser must read
// the member column under either name.
func TestParseStatusIDLayout(t *testing.T) {
	text := table(
		[]string{"NODE", "ID", "PROTOCOL-VERSION", "DB SIZE", "IN USE", "LEADER", "RAFT INDEX", "RAFT TERM", "LEARNER", "ERRORS"},
		[][]string{
			{"10.10.0.11", "a1b2c3d4e5f60001", "3.5.0", "21 MB", "14 MB", "a1b2c3d4e5f60001", "17", "9", "false", ""},
		},
	)
	got := ParseStatus(text)
	if len(got) != 1 {
		t.Fatalf("ParseStatus returned %d rows, want 1", len(got))
	}
	if got[0].Member != "a1b2c3d4e5f60001" {
		t.Errorf("Member = %q, want a1b2c3d4e5f60001 from the ID column", got[0].Member)
	}
}

func TestParseStatusRejectsGarbage(t *testing.T) {
	for _, text := range []string{"", "\n\n", "error: rpc error: code = Unavailable"} {
		if got := ParseStatus(text); len(got) != 0 {
			t.Errorf("ParseStatus(%q) = %+v, want no rows", text, got)
		}
	}
}

// An unparseable table must never read as healthy: no rows means no members
// answered, which fails the count check.
func TestUnparsedStatusIsUnhealthy(t *testing.T) {
	h := CheckHealth(ParseStatus("error: rpc error"), 3, DefaultRaftTolerance)
	if h.OK {
		t.Fatal("CheckHealth said OK for an unparseable status table")
	}
}

func TestParseStatusErrorsColumn(t *testing.T) {
	rows := [][]string{
		statusRow("10.10.0.11", "a1b2c3d4e5f60001", "a1b2c3d4e5f60002", "9182736"),
		statusRow("10.10.0.12", "a1b2c3d4e5f60002", "a1b2c3d4e5f60002", "9182740"),
	}
	rows[0][8] = "slow fdatasync"
	got := ParseStatus(table(statusHeaders, rows))
	if len(got) != 2 {
		t.Fatalf("ParseStatus returned %d rows, want 2", len(got))
	}
	if got[0].Errors != "slow fdatasync" {
		t.Errorf("Errors = %q, want %q", got[0].Errors, "slow fdatasync")
	}
}

func TestCheckHealthHappyPath(t *testing.T) {
	h := CheckHealth(ParseStatus(healthyStatusTable()), 3, DefaultRaftTolerance)
	if !h.OK {
		t.Fatalf("CheckHealth not OK: %v", h.Problems)
	}
}

func TestCheckHealthProblems(t *testing.T) {
	tests := []struct {
		name     string
		mutate   func(rows [][]string) [][]string
		expected int
		want     string
	}{
		{
			name:     "member count below expected",
			mutate:   func(rows [][]string) [][]string { return rows[:2] },
			expected: 3,
			want:     "2 member(s) answered, expected 3",
		},
		{
			name: "member reporting ERRORS",
			mutate: func(rows [][]string) [][]string {
				rows[1][8] = "etcdserver: no leader"
				return rows
			},
			expected: 3,
			want:     "ERRORS etcdserver: no leader",
		},
		{
			name: "learner does not count",
			mutate: func(rows [][]string) [][]string {
				rows[2][7] = "true"
				return rows
			},
			expected: 3,
			want:     "is a learner",
		},
		{
			name: "raft index beyond tolerance",
			mutate: func(rows [][]string) [][]string {
				rows[0][5] = "9182000"
				return rows
			},
			expected: 3,
			want:     "behind 9182740 (tolerance 10)",
		},
		{
			name: "members disagree about the leader",
			mutate: func(rows [][]string) [][]string {
				rows[0][4] = "a1b2c3d4e5f60001"
				return rows
			},
			expected: 3,
			want:     "members disagree about the leader",
		},
		{
			name: "no leader reported",
			mutate: func(rows [][]string) [][]string {
				for i := range rows {
					rows[i][4] = ""
				}
				return rows
			},
			expected: 3,
			want:     "no leader reported",
		},
		{
			name: "missing raft index",
			mutate: func(rows [][]string) [][]string {
				rows[0][5] = ""
				return rows
			},
			expected: 3,
			want:     "has no RAFT INDEX",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rows := [][]string{
				statusRow("10.10.0.11", "a1b2c3d4e5f60001", "a1b2c3d4e5f60002", "9182736"),
				statusRow("10.10.0.12", "a1b2c3d4e5f60002", "a1b2c3d4e5f60002", "9182740"),
				statusRow("10.10.0.13", "a1b2c3d4e5f60003", "a1b2c3d4e5f60002", "9182738"),
			}
			h := CheckHealth(ParseStatus(table(statusHeaders, tc.mutate(rows))), tc.expected, DefaultRaftTolerance)
			if h.OK {
				t.Fatalf("CheckHealth said OK, want a problem containing %q", tc.want)
			}
			if !strings.Contains(strings.Join(h.Problems, "; "), tc.want) {
				t.Errorf("problems %v do not mention %q", h.Problems, tc.want)
			}
		})
	}
}

// A fork with a two-member control plane is measured against its own size,
// not against this repo's three.
func TestCheckHealthHonoursExpected(t *testing.T) {
	text := table(statusHeaders, [][]string{
		statusRow("10.10.0.11", "a1b2c3d4e5f60001", "a1b2c3d4e5f60002", "9182736"),
		statusRow("10.10.0.12", "a1b2c3d4e5f60002", "a1b2c3d4e5f60002", "9182740"),
	})
	if h := CheckHealth(ParseStatus(text), 2, DefaultRaftTolerance); !h.OK {
		t.Fatalf("two-member cluster measured against 2 should be OK: %v", h.Problems)
	}
	if h := CheckHealth(ParseStatus(text), 3, DefaultRaftTolerance); h.OK {
		t.Fatal("two-member cluster measured against 3 should not be OK")
	}
}

// Transcribed from a real `talosctl -n <ip> etcd members` run: the parser has
// to cope with the exact spacing talosctl emits, not only with the spacing
// the test helper produces.
const membersFixture = `NODE         ID                 HOSTNAME              PEER URLS                    CLIENT URLS                  LEARNER
10.10.0.11   a1b2c3d4e5f60001   talos-aa1-bb2         https://10.10.0.11:2380      https://10.10.0.11:2379      false
10.10.0.11   a1b2c3d4e5f60002   talos-cc3-dd4         https://10.10.0.12:2380      https://10.10.0.12:2379      false
10.10.0.11   a1b2c3d4e5f60003   talos-ee5-ff6         https://10.10.0.13:2380      https://10.10.0.13:2379      false
`

func TestParseMembers(t *testing.T) {
	got := ParseMembers(membersFixture)
	if len(got) != 3 {
		t.Fatalf("ParseMembers returned %d rows, want 3: %+v", len(got), got)
	}
	if got[1].ID != "a1b2c3d4e5f60002" {
		t.Errorf("ID = %q, want a1b2c3d4e5f60002", got[1].ID)
	}
	if got[1].Hostname != "talos-cc3-dd4" {
		t.Errorf("Hostname = %q, want talos-cc3-dd4", got[1].Hostname)
	}
	if len(got[1].PeerURLs) != 1 || got[1].PeerURLs[0] != "https://10.10.0.12:2380" {
		t.Errorf("PeerURLs = %v, want [https://10.10.0.12:2380]", got[1].PeerURLs)
	}
	if got[1].Learner {
		t.Error("Learner = true, want false")
	}
}

func TestParseMembersRejectsGarbage(t *testing.T) {
	if got := ParseMembers("error: rpc error: code = Unavailable"); len(got) != 0 {
		t.Errorf("ParseMembers = %+v, want no rows", got)
	}
}

func TestFindMemberByIP(t *testing.T) {
	members := ParseMembers(membersFixture)

	m, ok := FindMemberByIP(members, "10.10.0.12")
	if !ok {
		t.Fatal("FindMemberByIP did not find 10.10.0.12")
	}
	if m.ID != "a1b2c3d4e5f60002" {
		t.Errorf("ID = %q, want a1b2c3d4e5f60002", m.ID)
	}

	// A worker is not an etcd member: the recreate path must be able to
	// tell that apart from "the cluster did not answer".
	if _, ok := FindMemberByIP(members, "10.10.0.21"); ok {
		t.Error("FindMemberByIP matched a worker IP that is not a member")
	}

	// A prefix of a member IP must not match.
	if _, ok := FindMemberByIP(members, "10.10.0.1"); ok {
		t.Error("FindMemberByIP matched 10.10.0.1 against 10.10.0.11")
	}
}

func TestMemberIPsAndWithout(t *testing.T) {
	members := ParseMembers(membersFixture)
	ips := MemberIPs(members)
	want := []string{"10.10.0.11", "10.10.0.12", "10.10.0.13"}
	if strings.Join(ips, ",") != strings.Join(want, ",") {
		t.Errorf("MemberIPs = %v, want %v", ips, want)
	}

	remaining := Without(members, "a1b2c3d4e5f60002")
	if len(remaining) != 2 {
		t.Fatalf("Without returned %d members, want 2", len(remaining))
	}
	if HasID(remaining, "a1b2c3d4e5f60002") {
		t.Error("Without left the removed member in the list")
	}
	if !HasID(remaining, "a1b2c3d4e5f60001") {
		t.Error("Without dropped an unrelated member")
	}
}

func TestHealthyCount(t *testing.T) {
	base := func() [][]string {
		return [][]string{
			statusRow("10.10.0.11", "a1b2c3d4e5f60001", "a1b2c3d4e5f60002", "9182736"),
			statusRow("10.10.0.12", "a1b2c3d4e5f60002", "a1b2c3d4e5f60002", "9182740"),
			statusRow("10.10.0.13", "a1b2c3d4e5f60003", "a1b2c3d4e5f60002", "9182738"),
		}
	}

	tests := []struct {
		name   string
		mutate func(rows [][]string) [][]string
		want   int
	}{
		{"all three healthy", func(r [][]string) [][]string { return r }, 3},
		{"one reporting ERRORS", func(r [][]string) [][]string { r[0][8] = "no leader"; return r }, 2},
		{"one learner", func(r [][]string) [][]string { r[1][7] = "true"; return r }, 2},
		{"one raft-lagging", func(r [][]string) [][]string { r[2][5] = "9100000"; return r }, 2},
		{"one missing its raft index", func(r [][]string) [][]string { r[2][5] = ""; return r }, 2},
		{"only one answered", func(r [][]string) [][]string { return r[:1] }, 1},
		{"none answered", func(r [][]string) [][]string { return nil }, 0},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rows := tc.mutate(base())
			got := HealthyCount(ParseStatus(table(statusHeaders, rows)), DefaultRaftTolerance)
			if got != tc.want {
				t.Errorf("HealthyCount = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestQuorum(t *testing.T) {
	for _, tc := range []struct{ size, want int }{
		{0, 0}, {1, 1}, {2, 2}, {3, 2}, {4, 3}, {5, 3},
	} {
		if got := Quorum(tc.size); got != tc.want {
			t.Errorf("Quorum(%d) = %d, want %d", tc.size, got, tc.want)
		}
	}
}

func TestCheckRemoval(t *testing.T) {
	tests := []struct {
		name             string
		size             int
		healthyRemaining int
		wantOK           bool
		wantReason       string
	}{
		{
			name: "three healthy members, remove one", size: 3, healthyRemaining: 2, wantOK: true,
		},
		{
			name: "three members but one survivor already down", size: 3, healthyRemaining: 1,
			wantReason: "leaves 2 member(s) needing a quorum of 2, but only 1 remaining member(s) are healthy",
		},
		{
			name: "three members with both survivors down", size: 3, healthyRemaining: 0,
			wantReason: "the removal itself needs a quorum of 2 to commit",
		},
		{
			name: "single member cluster", size: 1, healthyRemaining: 0,
			wantReason: "refusing to remove the only etcd member",
		},
		{
			name: "two member cluster, survivor healthy", size: 2, healthyRemaining: 1, wantOK: true,
		},
		{
			name: "five members, three survivors healthy", size: 5, healthyRemaining: 3, wantOK: true,
		},
		{
			name: "five members, two survivors healthy", size: 5, healthyRemaining: 2,
			wantReason: "leaves 4 member(s) needing a quorum of 3",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := CheckRemoval(tc.size, tc.healthyRemaining)
			if got.OK != tc.wantOK {
				t.Fatalf("CheckRemoval(%d, %d).OK = %t, want %t (reason %q)",
					tc.size, tc.healthyRemaining, got.OK, tc.wantOK, got.Reason)
			}
			if tc.wantReason != "" && !strings.Contains(got.Reason, tc.wantReason) {
				t.Errorf("reason = %q, want it to contain %q", got.Reason, tc.wantReason)
			}
			if tc.wantOK && got.Reason != "" {
				t.Errorf("OK verdict carried a reason: %q", got.Reason)
			}
		})
	}
}

func TestSnapshotName(t *testing.T) {
	at := time.Date(2026, 9, 25, 5, 33, 7, 408_000_000, time.UTC)
	if got, want := SnapshotName(at), "etcd-20260925T053307Z.snapshot"; got != want {
		t.Errorf("SnapshotName = %q, want %q", got, want)
	}
	// A non-UTC input must still produce a UTC stamp, so two operators in
	// different timezones cannot write colliding or misleading names.
	loc := time.FixedZone("UTC+5", 5*3600)
	if got, want := SnapshotName(at.In(loc)), "etcd-20260925T053307Z.snapshot"; got != want {
		t.Errorf("SnapshotName (non-UTC) = %q, want %q", got, want)
	}
}

// ---------------------------------------------------------------------------
// The `whole` / `survivable` predicates (contracts/cluster/topology.v1.yaml).
// ---------------------------------------------------------------------------

var cp3 = []string{"10.10.0.11", "10.10.0.12", "10.10.0.13"}

// membersAt builds a member list with one member per address, each under a
// distinct id, the way `etcd members` prints one.
func membersAt(ips ...string) []Member {
	out := make([]Member, 0, len(ips))
	for i, ip := range ips {
		out = append(out, Member{
			ID:       fmt.Sprintf("a1b2c3d4e5f6000%d", i+1),
			Hostname: fmt.Sprintf("talos-node-%d", i+1),
			PeerURLs: []string{"https://" + ip + ":2380"},
		})
	}
	return out
}

// statusAt builds a converged status table for the given addresses.
func statusAt(ips ...string) []Status {
	rows := make([][]string, 0, len(ips))
	for i, ip := range ips {
		rows = append(rows, statusRow(ip, fmt.Sprintf("a1b2c3d4e5f6000%d", i+1), "a1b2c3d4e5f60001", "9182740"))
	}
	return ParseStatus(table(statusHeaders, rows))
}

func TestMaxUnavailable(t *testing.T) {
	for _, tc := range []struct{ size, want int }{
		{1, 0}, {2, 0}, {3, 1}, {4, 1}, {5, 2}, {7, 3}, {0, 0},
	} {
		if got := MaxUnavailable(tc.size); got != tc.want {
			t.Errorf("MaxUnavailable(%d) = %d, want %d", tc.size, got, tc.want)
		}
	}
}

// `whole` is satisfied only when every configured control plane is a member
// and answered.
func TestEvaluateWhole(t *testing.T) {
	ok := Evaluate(Whole, Observation{
		Expected: cp3, Members: membersAt(cp3...), Statuses: statusAt(cp3...),
	}, DefaultRaftTolerance)
	if !ok.OK {
		t.Fatalf("a converged three-member cluster failed `whole`: %v", ok.Problems)
	}
	if ok.Answered != 3 {
		t.Errorf("Answered = %d, want 3", ok.Answered)
	}

	// One member silent: `whole` refuses even though the absence would be a
	// declared target, because at completion nothing may be missing.
	short := Evaluate(Whole, Observation{
		Expected: cp3, Members: membersAt(cp3[0], cp3[2]), Statuses: statusAt(cp3[0], cp3[2]),
		Declared: []string{cp3[1]},
	}, DefaultRaftTolerance)
	if short.OK {
		t.Fatal("`whole` accepted a cluster one member short")
	}
	if !strings.Contains(short.Reason(), cp3[1]) {
		t.Errorf("reason does not name the missing member: %q", short.Reason())
	}
}

// This is homelab #39's own failure shape: a stale member left at the right
// address under the wrong id, so the cluster has the expected *number* of
// members and is broken. A member-count check passes it; `whole` must not.
func TestEvaluateWholeRejectsAMemberAtAnUnconfiguredAddress(t *testing.T) {
	stale := append(membersAt(cp3...), Member{
		ID: "b00000001a374507", Hostname: "talos-stale", PeerURLs: []string{"https://10.10.0.99:2380"},
	})
	v := Evaluate(Whole, Observation{
		Expected: cp3, Members: stale, Statuses: statusAt(cp3...),
	}, DefaultRaftTolerance)
	if v.OK {
		t.Fatal("`whole` accepted a cluster carrying a member at an address that is not a configured control plane")
	}
	if !strings.Contains(v.Reason(), "10.10.0.99") {
		t.Errorf("reason does not name the stray member: %q", v.Reason())
	}
}

// `survivable` relaxes `whole` in exactly one way: the declared target may be
// absent. Everything else it still requires.
func TestEvaluateSurvivableAcceptsOnlyTheDeclaredAbsence(t *testing.T) {
	// The pre-removal shape: the target is still a member but deliberately
	// not queried, so it reads as absent — and it is declared.
	v := Evaluate(Survivable, Observation{
		Expected: cp3, Members: membersAt(cp3...), Statuses: statusAt(cp3[0], cp3[2]),
		Declared: []string{cp3[1]},
	}, DefaultRaftTolerance)
	if !v.OK {
		t.Fatalf("`survivable` refused the declared target's absence: %v", v.Problems)
	}
	if len(v.Undeclared) != 0 {
		t.Errorf("Undeclared = %v, want none", v.Undeclared)
	}

	// The resume shape: the target's member is already gone, the other two
	// answer. This is the legitimate recovery path, and a gate that refuses
	// here is a gate the operator has to bypass to finish.
	resume := Evaluate(Survivable, Observation{
		Expected: cp3, Members: membersAt(cp3[0], cp3[2]), Statuses: statusAt(cp3[0], cp3[2]),
		Declared: []string{cp3[1]},
	}, DefaultRaftTolerance)
	if !resume.OK {
		t.Fatalf("`survivable` refused a resumable cluster: %v", resume.Problems)
	}
}

// The condition that bounds the relaxation. One target absent is a procedure
// in flight; one target plus one stranger is a degraded cluster.
func TestEvaluateSurvivableRefusesAnUndeclaredAbsence(t *testing.T) {
	v := Evaluate(Survivable, Observation{
		Expected: cp3, Members: membersAt(cp3[0], cp3[2]), Statuses: statusAt(cp3[0]),
		Declared: []string{cp3[1]},
	}, DefaultRaftTolerance)
	if v.OK {
		t.Fatal("`survivable` accepted a cluster with an absence it did not ask for")
	}
	if !strings.Contains(v.Reason(), cp3[2]) {
		t.Errorf("reason does not name the undeclared absence: %q", v.Reason())
	}
	if !strings.Contains(v.Reason(), "degraded, not mid-procedure") {
		t.Errorf("reason does not distinguish degraded from mid-procedure: %q", v.Reason())
	}
}

// The defect from the review of PR #364: a crashed recreate of cp-2 left
// membership {cp-1, cp-3}; the operator then recreates cp-3. Sized off the
// live member list the arithmetic consents — Quorum(2)=2 is met by the two
// live members, and after removal Quorum(1)=1 is met by the one survivor — and
// the control plane goes to a single member. Sized off the configured count it
// refuses, which is the only correct answer.
func TestEvaluateSurvivableRefusesASecondRemovalAfterACrashedRun(t *testing.T) {
	v := Evaluate(Survivable, Observation{
		Expected: cp3,
		Members:  membersAt(cp3[0], cp3[2]), // cp-2's member was already removed
		Statuses: statusAt(cp3[0]),          // cp-3 is the new target, so only cp-1 answers
		Declared: []string{cp3[2]},          // this run declares cp-3
	}, DefaultRaftTolerance)
	if v.OK {
		t.Fatal("the guard consented to removing a second etcd member; this takes a 3-node control plane to one")
	}
	if !strings.Contains(v.Reason(), "quorum of 2") {
		t.Errorf("reason does not show the arithmetic against the configured size: %q", v.Reason())
	}
	if !strings.Contains(v.Reason(), cp3[1]) {
		t.Errorf("reason does not name the member a previous run left out: %q", v.Reason())
	}
}

// `survivable` is laxer than `whole` on the member count and on nothing else.
// If it ever stops applying one of the four per-member conditions, the gate at
// the most dangerous moment has become weaker than the gate at the door.
func TestEvaluateSurvivableKeepsEveryOtherCondition(t *testing.T) {
	declared := []string{cp3[1]}
	members := membersAt(cp3...)

	lagging := ParseStatus(table(statusHeaders, [][]string{
		statusRow(cp3[0], "a1b2c3d4e5f60001", "a1b2c3d4e5f60001", "9182740"),
		statusRow(cp3[2], "a1b2c3d4e5f60003", "a1b2c3d4e5f60001", "9177740"),
	}))
	if v := Evaluate(Survivable, Observation{
		Expected: cp3, Members: members, Statuses: lagging, Declared: declared,
	}, DefaultRaftTolerance); v.OK {
		t.Error("raft-index-converged was dropped: a lagging survivor passed `survivable`")
	}

	learner := ParseStatus(table(statusHeaders, [][]string{
		statusRow(cp3[0], "a1b2c3d4e5f60001", "a1b2c3d4e5f60001", "9182740"),
		{cp3[2], "a1b2c3d4e5f60003", "21 MB", "14 MB (66.67%)", "a1b2c3d4e5f60001", "9182740", "42", "true", ""},
	}))
	if v := Evaluate(Survivable, Observation{
		Expected: cp3, Members: members, Statuses: learner, Declared: declared,
	}, DefaultRaftTolerance); v.OK {
		t.Error("no-learners was dropped: a learner counted towards quorum under `survivable`")
	}

	errored := ParseStatus(table(statusHeaders, [][]string{
		statusRow(cp3[0], "a1b2c3d4e5f60001", "a1b2c3d4e5f60001", "9182740"),
		{cp3[2], "a1b2c3d4e5f60003", "21 MB", "14 MB (66.67%)", "a1b2c3d4e5f60001", "9182740", "42", "false", "context deadline exceeded"},
	}))
	if v := Evaluate(Survivable, Observation{
		Expected: cp3, Members: members, Statuses: errored, Declared: declared,
	}, DefaultRaftTolerance); v.OK {
		t.Error("no-errors was dropped: a member reporting ERRORS passed `survivable`")
	}

	split := ParseStatus(table(statusHeaders, [][]string{
		statusRow(cp3[0], "a1b2c3d4e5f60001", "a1b2c3d4e5f60001", "9182740"),
		statusRow(cp3[2], "a1b2c3d4e5f60003", "a1b2c3d4e5f60003", "9182740"),
	}))
	if v := Evaluate(Survivable, Observation{
		Expected: cp3, Members: members, Statuses: split, Declared: declared,
	}, DefaultRaftTolerance); v.OK {
		t.Error("single-leader was dropped: survivors disagreeing about the leader passed `survivable`")
	}
}

// Fail-closed. Everything that means "could not tell" must mean "do not
// proceed", never "nothing to report".
func TestEvaluateFailsClosed(t *testing.T) {
	// An unparseable status table yields no rows at all.
	unparseable := Evaluate(Survivable, Observation{
		Expected: cp3, Members: membersAt(cp3...), Statuses: ParseStatus("totally not a table\n"),
		Declared: []string{cp3[1]},
	}, DefaultRaftTolerance)
	if unparseable.OK {
		t.Error("an unparseable status table read as safe to proceed")
	}

	// No configured control planes: there is no size to measure against.
	noSize := Evaluate(Survivable, Observation{Declared: []string{cp3[1]}}, DefaultRaftTolerance)
	if noSize.OK {
		t.Error("an empty expected set read as safe to proceed")
	}

	// An unknown predicate is not a pass.
	if v := Evaluate(Predicate("whatever"), Observation{
		Expected: cp3, Members: membersAt(cp3...), Statuses: statusAt(cp3...),
	}, DefaultRaftTolerance); v.OK {
		t.Error("an unknown predicate read as safe to proceed")
	}
}

// A one-node control plane: removing its only member is a snapshot-restore
// operation, not a member removal. Both the predicate and the arithmetic
// refuse, and the arithmetic says where to go instead.
func TestSingleControlPlaneRefusesRemoval(t *testing.T) {
	one := []string{cp3[0]}
	v := Evaluate(Survivable, Observation{
		Expected: one, Members: membersAt(one...), Statuses: nil, Declared: one,
	}, DefaultRaftTolerance)
	if v.OK {
		t.Fatal("`survivable` consented to removing the only member of a one-node control plane")
	}

	safety := CheckRemoval(1, 0)
	if safety.OK {
		t.Fatal("CheckRemoval consented to removing the only member")
	}
	if !strings.Contains(safety.Reason, "snapshot-restore") {
		t.Errorf("refusal does not point at the restore path: %q", safety.Reason)
	}
}

// Characterisation test for the trap in CheckRemoval's first argument, kept
// because the argument is easy to "simplify" back into the defect.
//
// The scenario is the one from the review of PR #364: a crashed recreate of
// cp-2 left the cluster at 2 of 3, and the operator now recreates cp-3, so one
// survivor (cp-1) is healthy. Fed the LIVE member count the arithmetic
// consents; fed the CONFIGURED count it refuses. Both readings are arithmetic
// that type-checks, which is exactly why this is pinned rather than trusted to
// the doc comment.
//
// `survivable` refuses this case independently — `absences-are-declared` names
// cp-2, and quorum-present fails against the configured three — so the guard is
// two-deep here. That is deliberate: this is the failure that turns a degraded
// control plane into a dead one, and a single gate protecting it is thin.
func TestCheckRemovalMustBeGivenTheConfiguredCountNotTheLiveOne(t *testing.T) {
	const healthySurvivors = 1 // cp-1; cp-2's member is already gone, cp-3 is the target

	if wrong := CheckRemoval(2, healthySurvivors); !wrong.OK {
		t.Fatalf("this test no longer characterises the defect it exists for: "+
			"CheckRemoval(liveCount=2, %d) now refuses (%q). If that is a deliberate change, "+
			"delete this test; do not relax the assertion below.", healthySurvivors, wrong.Reason)
	}

	right := CheckRemoval(3, healthySurvivors)
	if right.OK {
		t.Fatal("CheckRemoval consented to removing a second member from a three-member control plane; " +
			"this leaves one etcd member and no fault tolerance")
	}
	if !strings.Contains(right.Reason, "quorum of 2") {
		t.Errorf("refusal does not show the arithmetic: %q", right.Reason)
	}
}
