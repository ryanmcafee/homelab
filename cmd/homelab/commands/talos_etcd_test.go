package commands

import (
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/config"
)

func values(pairs map[string]string) map[string]config.ConfigValue {
	out := make(map[string]config.ConfigValue, len(pairs))
	for k, v := range pairs {
		out[k] = config.ConfigValue{Value: v}
	}
	return out
}

func TestControlPlaneIPs(t *testing.T) {
	tests := []struct {
		name string
		in   map[string]string
		want []string
	}{
		{
			name: "three control planes in index order",
			in: map[string]string{
				"CP3_IP":     "10.10.0.13",
				"CP1_IP":     "10.10.0.11",
				"CP2_IP":     "10.10.0.12",
				"WORKER1_IP": "10.10.0.21",
				"CP_VIP":     "10.10.0.10",
				"DOMAIN":     "example.test",
			},
			want: []string{"10.10.0.11", "10.10.0.12", "10.10.0.13"},
		},
		{
			// Index order, not string order: CP10 must not sort before CP2.
			name: "double digit indices sort numerically",
			in: map[string]string{
				"CP1_IP":  "10.10.0.11",
				"CP2_IP":  "10.10.0.12",
				"CP10_IP": "10.10.0.20",
			},
			want: []string{"10.10.0.11", "10.10.0.12", "10.10.0.20"},
		},
		{
			// The localdev set points every control plane at loopback;
			// three queries to one endpoint would invent members.
			name: "duplicate addresses collapse",
			in: map[string]string{
				"CP1_IP": "127.0.0.1",
				"CP2_IP": "127.0.0.1",
				"CP3_IP": "127.0.0.1",
			},
			want: []string{"127.0.0.1"},
		},
		{
			name: "a fork with a single control plane",
			in:   map[string]string{"CP1_IP": "192.0.2.5"},
			want: []string{"192.0.2.5"},
		},
		{
			name: "empty values are skipped",
			in:   map[string]string{"CP1_IP": "10.10.0.11", "CP2_IP": "", "CP3_IP": "   "},
			want: []string{"10.10.0.11"},
		},
		{
			name: "no control planes configured",
			in:   map[string]string{"WORKER1_IP": "10.10.0.21"},
			want: nil,
		},
		{
			// CP_VIP is the shared virtual IP, not a member address:
			// querying it would hit whichever node currently holds it.
			name: "the control plane VIP is not a member address",
			in:   map[string]string{"CP_VIP": "10.10.0.10", "CPX_IP": "10.10.0.99"},
			want: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := controlPlaneIPs(values(tc.in))
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("controlPlaneIPs = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestExceptIP(t *testing.T) {
	all := []string{"10.10.0.11", "10.10.0.12", "10.10.0.13"}

	got := exceptIP(all, "10.10.0.12")
	if strings.Join(got, ",") != "10.10.0.11,10.10.0.13" {
		t.Errorf("exceptIP = %v, want the other two", got)
	}
	// A worker IP is not in the list; nothing is dropped.
	if got := exceptIP(all, "10.10.0.21"); len(got) != 3 {
		t.Errorf("exceptIP dropped something for an absent IP: %v", got)
	}
	if got := exceptIP(nil, "10.10.0.11"); len(got) != 0 {
		t.Errorf("exceptIP(nil) = %v, want empty", got)
	}
}

func TestEtcdSnapshotSummary(t *testing.T) {
	if got := etcdSnapshotSummary(talosRecreateOptions{snapshotDir: "./etcd-snapshots"}); got != "./etcd-snapshots" {
		t.Errorf("etcdSnapshotSummary = %q, want the directory", got)
	}
	got := etcdSnapshotSummary(talosRecreateOptions{snapshotDir: "./etcd-snapshots", skipSnapshot: true})
	if !strings.Contains(got, "SKIPPED") {
		t.Errorf("etcdSnapshotSummary = %q, want it to say the run has no snapshot", got)
	}
}
