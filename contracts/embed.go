// Package contracts embeds the normative contract files so a compiled
// `homelab` binary carries them rather than reading them out of whatever
// working directory it happens to be run from.
//
// Only the embed lives here; parsing and the typed accessors are in the
// package that consumes each contract (internal/topology for the cluster
// topology). go:embed cannot reach outside its own directory, which is why
// this file sits beside the data instead of next to its consumer.
package contracts

import _ "embed"

// ClusterTopologyV1 is contracts/cluster/topology.v1.yaml: the control-plane
// topology, the etcd quorum rule and the health predicates that decide whether
// destroying a control-plane node is safe. Parsed by internal/topology.
//
//go:embed cluster/topology.v1.yaml
var ClusterTopologyV1 []byte
