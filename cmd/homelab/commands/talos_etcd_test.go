package commands

import (
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/etcd"
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

// The raft-index-converged tolerance may only be tightened. A flag that can
// loosen a safety check on a path that removes an etcd member is a bypass, so
// it is rejected before any cluster call happens.
func TestRecreateOptionsValidateRaftTolerance(t *testing.T) {
	base := talosRecreateOptions{snapshotDir: "./etcd-snapshots"}

	tighter := base
	tighter.raftTolerance = etcd.DefaultRaftTolerance - 1
	if err := tighter.validate(); err != nil {
		t.Errorf("tightening the tolerance was rejected: %v", err)
	}

	atDefault := base
	atDefault.raftTolerance = etcd.DefaultRaftTolerance
	if err := atDefault.validate(); err != nil {
		t.Errorf("the default tolerance was rejected: %v", err)
	}

	looser := base
	looser.raftTolerance = etcd.DefaultRaftTolerance + 1
	err := looser.validate()
	if err == nil {
		t.Fatal("a tolerance looser than the default was accepted; the gate can be turned off from the command line")
	}
	if !strings.Contains(err.Error(), "only be tightened") {
		t.Errorf("refusal does not say why: %v", err)
	}

	negative := base
	negative.raftTolerance = -1
	if err := negative.validate(); err == nil {
		t.Error("a negative tolerance was accepted")
	}
}

// There must be no way to ask for the removal without a snapshot: it is a
// precondition of the operation, not an option on it.
func TestRecreateHasNoSnapshotBypassFlag(t *testing.T) {
	cmd := newTalosRecreateCmd()
	for _, name := range []string{"skip-etcd-snapshot", "skip-snapshot", "no-etcd-snapshot", "force"} {
		if f := cmd.Flags().Lookup(name); f != nil {
			t.Errorf("--%s exists: the verified pre-removal snapshot can be skipped", name)
		}
	}
	if cmd.Flags().Lookup("etcd-snapshot-dir") == nil {
		t.Error("--etcd-snapshot-dir is missing: the operator cannot say where the snapshot goes")
	}
}
