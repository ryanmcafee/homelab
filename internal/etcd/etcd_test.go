package etcd

import (
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
// not against ExpectedMembers.
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
