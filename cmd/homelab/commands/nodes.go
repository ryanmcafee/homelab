package commands

import (
	"context"
	"fmt"
	"os/exec"
	"slices"
	"strings"
	"time"
)

const nodeListJSONPath = `jsonpath={range .items[*]}{.metadata.name}={.status.addresses[?(@.type=="InternalIP")].address}={.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}`

type k8sNode struct {
	name  string
	ips   []string
	ready bool
}

func (n k8sNode) hasIP(ip string) bool { return slices.Contains(n.ips, ip) }

// parseK8sNodes parses the name=ips=readyStatus lines nodeListJSONPath renders.
func parseK8sNodes(out string) []k8sNode {
	var nodes []k8sNode
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		parts := strings.SplitN(line, "=", 3)
		if len(parts) < 2 || parts[0] == "" {
			continue
		}
		node := k8sNode{name: parts[0], ips: strings.Fields(parts[1])}
		node.ready = len(parts) == 3 && parts[2] == "True"
		nodes = append(nodes, node)
	}
	return nodes
}

func nodesWithIP(nodes []k8sNode, ip string) []k8sNode {
	var matches []k8sNode
	for _, n := range nodes {
		if n.hasIP(ip) {
			matches = append(matches, n)
		}
	}
	return matches
}

func nodeNames(nodes []k8sNode) []string {
	names := make([]string, 0, len(nodes))
	for _, n := range nodes {
		names = append(names, n.name)
	}
	return names
}

// pickNodeByIP returns the only node at ip, or the only Ready one when a
// recreate has left stale entries sharing that address.
func pickNodeByIP(nodes []k8sNode, ip string) (string, error) {
	matches := nodesWithIP(nodes, ip)
	if len(matches) == 0 {
		return "", fmt.Errorf("no Kubernetes node with InternalIP %s", ip)
	}
	if len(matches) == 1 {
		return matches[0].name, nil
	}
	ready := slices.DeleteFunc(slices.Clone(matches), func(n k8sNode) bool { return !n.ready })
	if len(ready) == 1 {
		return ready[0].name, nil
	}
	return "", fmt.Errorf("%d Kubernetes nodes share InternalIP %s (%s) and %d of them are Ready; "+
		"delete the stale entries with `kubectl delete node <name>` and retry",
		len(matches), ip, strings.Join(nodeNames(matches), ", "), len(ready))
}

// pickNewReadyNodeByIP returns a Ready node at ip whose name is not oldName.
func pickNewReadyNodeByIP(nodes []k8sNode, ip, oldName string) (string, bool) {
	for _, n := range nodesWithIP(nodes, ip) {
		if n.ready && n.name != oldName {
			return n.name, true
		}
	}
	return "", false
}

// staleNodesByIP returns every node at ip other than keep.
func staleNodesByIP(nodes []k8sNode, ip, keep string) []string {
	var stale []string
	for _, n := range nodesWithIP(nodes, ip) {
		if n.name != keep {
			stale = append(stale, n.name)
		}
	}
	return stale
}

func listK8sNodes(ctx context.Context) ([]k8sNode, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "kubectl", "get", "nodes", "-o", nodeListJSONPath).Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl get nodes: %w", stderrOf(err))
	}
	return parseK8sNodes(string(out)), nil
}

// resolveK8sNodeByIP returns the Kubernetes node name whose InternalIP
// matches ip.
//
// The homelab Talos cluster assigns random hostnames (e.g. talos-abc-def)
// that do NOT match the terragrunt for_each keys (e.g. worker-1), so any
// caller that operates on specific hardware must resolve the K8s name by
// the node's known InternalIP rather than assuming the key matches.
func resolveK8sNodeByIP(ctx context.Context, ip string) (string, error) {
	nodes, err := listK8sNodes(ctx)
	if err != nil {
		return "", err
	}
	return pickNodeByIP(nodes, ip)
}

// workerIPConfigKey maps a terragrunt node key like "worker-1" or "cp-2"
// to the resolved config key "WORKER1_IP" / "CP2_IP".
func workerIPConfigKey(nodeKey string) string {
	return strings.ToUpper(strings.ReplaceAll(nodeKey, "-", "")) + "_IP"
}
