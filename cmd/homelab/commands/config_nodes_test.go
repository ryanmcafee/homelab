package commands

import (
	"strings"
	"testing"

	"github.com/ryanmcafee/homelab/internal/config"
)

// TestClusterNodesFollowsTheConfigSet covers what `homelab config nodes`
// exists for: operator documentation that enumerates this cluster's addresses
// is wrong on every other topology, so the command has to be right on the
// shapes the schema now admits — including the workerless one (MCAA-423).
func TestClusterNodesFollowsTheConfigSet(t *testing.T) {
	rc := &config.ResolvedConfig{
		ControlPlane: []config.NodeMember{
			{Ordinal: 1, Address: "192.0.2.11"},
			{Ordinal: 5, Address: "192.0.2.15"},
		},
		Workers: []config.NodeMember{{Ordinal: 1, Address: "192.0.2.21"}},
	}

	tests := []struct {
		name string
		rc   *config.ResolvedConfig
		role string
		want string
	}{
		{"all, control plane first", rc, "all", "cp-1=192.0.2.11 cp-5=192.0.2.15 worker-1=192.0.2.21"},
		{"control plane only", rc, "control-plane", "cp-1=192.0.2.11 cp-5=192.0.2.15"},
		{"worker only", rc, "worker", "worker-1=192.0.2.21"},
		{
			// A one-node fork. The empty worker list must come back empty
			// rather than fall through to the control plane — a runbook that
			// printed the control planes under "workers" would have an
			// operator upgrade an etcd member while calling it a worker.
			name: "workerless fork has no workers",
			rc: &config.ResolvedConfig{
				ControlPlane: []config.NodeMember{{Ordinal: 1, Address: "192.0.2.11"}},
			},
			role: "worker",
			want: "",
		},
		{
			name: "workerless fork is one node in total",
			rc: &config.ResolvedConfig{
				ControlPlane: []config.NodeMember{{Ordinal: 1, Address: "192.0.2.11"}},
			},
			role: "all",
			want: "cp-1=192.0.2.11",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			nodes, err := clusterNodes(tc.rc, tc.role)
			if err != nil {
				t.Fatalf("clusterNodes(%q): %v", tc.role, err)
			}
			pairs := make([]string, 0, len(nodes))
			for _, n := range nodes {
				pairs = append(pairs, n[0]+"="+n[1])
			}
			if got := strings.Join(pairs, " "); got != tc.want {
				t.Errorf("clusterNodes(%q) = %q, want %q", tc.role, got, tc.want)
			}
		})
	}
}

// TestClusterNodesRejectsAnUnknownRole keeps the usage error listing the roles
// the command actually accepts; a silent empty result reads like a fork with no
// nodes of that kind.
func TestClusterNodesRejectsAnUnknownRole(t *testing.T) {
	_, err := clusterNodes(&config.ResolvedConfig{}, "workers")
	if err == nil {
		t.Fatal("clusterNodes accepted an unknown role")
	}
	for _, want := range []string{`"workers"`, "all, control-plane, worker"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not say %q", err, want)
		}
	}
}
