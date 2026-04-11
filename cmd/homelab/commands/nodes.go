package commands

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// resolveK8sNodeByIP returns the Kubernetes node name whose InternalIP
// matches ip.
//
// The homelab Talos cluster assigns random hostnames (e.g. talos-abc-def)
// that do NOT match the terragrunt for_each keys (e.g. worker-1), so any
// caller that operates on specific hardware must resolve the K8s name by
// the node's known InternalIP rather than assuming the key matches.
func resolveK8sNodeByIP(ctx context.Context, ip string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "kubectl", "get", "nodes",
		"-o", `jsonpath={range .items[*]}{.metadata.name}={.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}`,
	)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("kubectl get nodes: %w", stderrOf(err))
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 && parts[1] == ip {
			return parts[0], nil
		}
	}
	return "", fmt.Errorf("no Kubernetes node with InternalIP %s", ip)
}

// workerIPConfigKey maps a terragrunt node key like "worker-1" or "cp-2"
// to the resolved config key "WORKER1_IP" / "CP2_IP".
func workerIPConfigKey(nodeKey string) string {
	return strings.ToUpper(strings.ReplaceAll(nodeKey, "-", "")) + "_IP"
}
