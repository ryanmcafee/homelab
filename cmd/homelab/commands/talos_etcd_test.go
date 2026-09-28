package commands

import (
	"fmt"
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/config"
	"github.com/ryanmcafee/homelab/internal/topology"
)

// resolved builds a ResolvedConfig whose control-plane list is the one the
// resolver derived, alongside raw values that deliberately disagree with it.
func resolved(addresses []string, rawValues map[string]string) *config.ResolvedConfig {
	members := make([]config.ControlPlaneMember, 0, len(addresses))
	for i, a := range addresses {
		members = append(members, config.ControlPlaneMember{
			Ordinal: i + 1,
			Key:     fmt.Sprintf("CP%d_IP", i+1),
			Address: a,
		})
	}
	values := make(map[string]config.ConfigValue, len(rawValues))
	for k, v := range rawValues {
		values[k] = config.ConfigValue{Value: v}
	}
	return &config.ResolvedConfig{Values: values, ControlPlane: members}
}

func TestControlPlaneIPs(t *testing.T) {
	tests := []struct {
		name      string
		addresses []string
		want      []string
	}{
		{
			name:      "the resolver's order is kept",
			addresses: []string{"10.10.0.11", "10.10.0.12", "10.10.0.13"},
			want:      []string{"10.10.0.11", "10.10.0.12", "10.10.0.13"},
		},
		{
			// The localdev set points every control plane at loopback;
			// three queries to one endpoint would invent members.
			name:      "duplicate addresses collapse",
			addresses: []string{"127.0.0.1", "127.0.0.1", "127.0.0.1"},
			want:      []string{"127.0.0.1"},
		},
		{
			name:      "a fork with a single control plane",
			addresses: []string{"192.0.2.5"},
			want:      []string{"192.0.2.5"},
		},
		{
			name:      "a fork with seven",
			addresses: []string{"10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6", "10.0.0.7"},
			want:      []string{"10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5", "10.0.0.6", "10.0.0.7"},
		},
		{
			name:      "no control planes derived",
			addresses: nil,
			want:      nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := controlPlaneIPs(resolved(tc.addresses, nil))
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("controlPlaneIPs = %v, want %v", got, tc.want)
			}
		})
	}
}

// ADR-035's merge condition on #39: the key-name rule is applied once, by the
// resolver, and this consumer reads the result. Re-deriving it here would be
// a second statement of controlPlane.countKeyPattern — and the one that can
// disagree with the first. So the raw values are given a CP key family that
// contradicts the derived list, and the derived list must win.
func TestControlPlaneIPsReadsTheResolverNotTheRawKeys(t *testing.T) {
	rc := resolved([]string{"10.10.0.11"}, map[string]string{
		"CP1_IP": "192.0.2.1",
		"CP2_IP": "192.0.2.2",
		"CP3_IP": "192.0.2.3",
	})

	got := controlPlaneIPs(rc)
	if strings.Join(got, ",") != "10.10.0.11" {
		t.Errorf("controlPlaneIPs = %v, want the resolver's [10.10.0.11]: the CP key pattern is being "+
			"re-applied here instead of read from ResolvedConfig.ControlPlane", got)
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
	contract, err := topology.Load()
	if err != nil {
		t.Fatalf("loading the topology contract: %v", err)
	}
	base := talosRecreateOptions{snapshotDir: "./etcd-snapshots", contract: contract}

	tighter := base
	tighter.raftTolerance = contract.RaftIndexTolerance - 1
	if err := tighter.validate(); err != nil {
		t.Errorf("tightening the tolerance was rejected: %v", err)
	}

	atDefault := base
	atDefault.raftTolerance = contract.RaftIndexTolerance
	if err := atDefault.validate(); err != nil {
		t.Errorf("the default tolerance was rejected: %v", err)
	}

	looser := base
	looser.raftTolerance = contract.RaftIndexTolerance + 1
	err = looser.validate()
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
