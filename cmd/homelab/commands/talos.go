package commands

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

const (
	talosClusterModuleDir = "terragrunt/environments/homelab/talos-cluster"
	talosApplyLogPath     = "/tmp/phase-07-apply.log"
	talosDrainTimeout     = "10m"
	talosReadyTimeout     = "20m"
)

// vmAddressRe matches Terraform resource addresses for Proxmox VMs created
// via `for_each`, e.g. `proxmox_virtual_environment_vm.worker["worker-1"]`.
var vmAddressRe = regexp.MustCompile(`^proxmox_virtual_environment_vm\.[a-z0-9_]+\["([^"]+)"\]$`)

func NewTalosCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "talos",
		Short: "Talos node operations",
		Long:  `Manage Talos nodes - recreation, upgrades, etc.`,
	}

	cmd.AddCommand(newTalosRecreateCmd())

	return cmd
}

func newTalosRecreateCmd() *cobra.Command {
	var node string
	var skipDrain bool

	cmd := &cobra.Command{
		Use:   "recreate",
		Short: "Recreate a Talos node",
		Long:  `Drain, taint, and recreate a Talos node via terragrunt`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTalosRecreate(node, skipDrain)
		},
	}

	cmd.Flags().StringVar(&node, "node", "worker-1", "Node to recreate")
	cmd.Flags().BoolVar(&skipDrain, "skip-drain", false, "Skip draining the node")

	return cmd
}

func runTalosRecreate(node string, skipDrain bool) error {
	utils.DryRun = DryRun
	utils.AutoAccept = AutoAccept

	logger.Info("======================================")
	logger.Info("  Talos Node Recreation")
	logger.Info("======================================")
	logger.Info(fmt.Sprintf("  Node: %s", node))
	logger.Info(fmt.Sprintf("  Skip Drain: %t", skipDrain))
	logger.Info(fmt.Sprintf("  Dry Run: %t", DryRun))
	logger.Info("======================================")
	fmt.Println()

	moduleDir, err := resolveTalosClusterDir()
	if err != nil {
		return err
	}
	opEnvFile, err := resolveOpEnvFile()
	if err != nil {
		return err
	}

	// Resolve the InternalIP for this terragrunt node key. Talos assigns
	// random K8s hostnames that do NOT match terragrunt keys, so every
	// kubectl op must go through IP → name lookup.
	rc, cerr := loadResolvedConfig()
	if cerr != nil {
		return fmt.Errorf("loading resolved config: %w", cerr)
	}
	ipKey := workerIPConfigKey(node)
	nodeIP := rc.Values[ipKey].Value
	if nodeIP == "" {
		return fmt.Errorf("resolved config missing %s (required to map %s → K8s node)", ipKey, node)
	}
	logger.Info(fmt.Sprintf("Resolved terragrunt key %q → InternalIP %s", node, nodeIP))

	if !AutoAccept && !DryRun {
		msg := fmt.Sprintf("This will DESTROY and recreate the Proxmox VM for node %q (IP %s). Continue?", node, nodeIP)
		if !utils.Confirm(msg) {
			return fmt.Errorf("recreate aborted: user declined confirmation")
		}
	}

	ctx := context.Background()

	preK8sName, lookupErr := resolveK8sNodeByIP(ctx, nodeIP)
	if lookupErr != nil {
		logger.Warn(fmt.Sprintf("Step 1/6: No existing K8s node at %s (%v) — continuing", nodeIP, lookupErr))
	} else {
		logger.Info(fmt.Sprintf("Step 1/6: Current K8s node at %s: %s", nodeIP, preK8sName))
		_ = streamCmd("", "", "", "kubectl", "get", "node", preK8sName, "-o", "wide")
	}

	if preK8sName != "" {
		logger.Info(fmt.Sprintf("Step 2/6: Cordoning node %q", preK8sName))
		if err := streamCmd("", "", "", "kubectl", "cordon", preK8sName); err != nil {
			logger.Warn(fmt.Sprintf("Cordon failed (continuing): %v", err))
		}
	} else {
		logger.Warn("Step 2/6: SKIPPED cordon (no existing K8s node at that IP)")
	}

	effectiveSkipDrain := skipDrain || preK8sName == ""
	if !effectiveSkipDrain {
		ready, rerr := isNodeReady(preK8sName)
		if rerr != nil {
			logger.Warn(fmt.Sprintf("Could not determine node Ready state (%v); proceeding with drain anyway", rerr))
		} else if !ready {
			logger.Warn(fmt.Sprintf("Node %q is NotReady — auto-skipping drain (pods cannot be evicted from a stopped kubelet)", preK8sName))
			effectiveSkipDrain = true
		}
	}

	if effectiveSkipDrain {
		logger.Warn("Step 3/6: SKIPPED drain")
	} else {
		logger.Info(fmt.Sprintf("Step 3/6: Draining node %q (timeout %s)", preK8sName, talosDrainTimeout))
		if err := streamCmd("", "", "",
			"kubectl", "drain", preK8sName,
			"--ignore-daemonsets", "--delete-emptydir-data",
			"--force", "--timeout="+talosDrainTimeout,
		); err != nil {
			return fmt.Errorf("drain node %q: %w", preK8sName, err)
		}
	}

	logger.Info("Step 4/6: Resolving VM resource address in terragrunt state")
	address, err := lookupVMResourceAddress(moduleDir, opEnvFile, node)
	if err != nil {
		return err
	}
	logger.OK(fmt.Sprintf("Resource address: %s", address))

	logger.Info(fmt.Sprintf("Step 5/6: terragrunt apply -replace=%s (log: %s)", address, talosApplyLogPath))
	if err := terragruntApplyReplace(moduleDir, opEnvFile, address); err != nil {
		return fmt.Errorf("terragrunt apply -replace=%s: %w", address, err)
	}

	logger.Info(fmt.Sprintf("Step 6/6: Waiting up to %s for a new Ready K8s node at %s", talosReadyTimeout, nodeIP))
	newK8sName, werr := waitForNewReadyNodeByIP(ctx, nodeIP, preK8sName, 20*time.Minute)
	if werr != nil {
		return werr
	}
	logger.OK(fmt.Sprintf("New K8s node %q is Ready at %s", newK8sName, nodeIP))

	if err := streamCmd("", "", "", "kubectl", "uncordon", newK8sName); err != nil {
		logger.Warn(fmt.Sprintf("Uncordon failed: %v", err))
	}

	// Talos assigns a fresh random hostname on every boot, so the old
	// K8s node entry is stale and will never come back Ready. Delete it
	// so downstream verify steps see a clean cluster view.
	if preK8sName != "" && preK8sName != newK8sName {
		logger.Info(fmt.Sprintf("Deleting stale K8s node entry %q", preK8sName))
		if err := streamCmd("", "", "", "kubectl", "delete", "node", preK8sName); err != nil {
			logger.Warn(fmt.Sprintf("Delete stale node %q failed (non-fatal): %v", preK8sName, err))
		}
	}

	logger.OK(fmt.Sprintf("Node %q recreated and Ready (K8s name: %s)", node, newK8sName))
	return nil
}

// waitForNewReadyNodeByIP polls kubectl until a K8s node whose InternalIP
// matches ip is Ready. If oldName is non-empty it also requires the
// resolved name to differ from oldName (so we do not accept the stale
// pre-recreate entry). The name differs because Talos assigns a new
// random hostname on every boot.
func waitForNewReadyNodeByIP(ctx context.Context, ip, oldName string, timeout time.Duration) (string, error) {
	if utils.DryRun {
		return "dry-run-node", nil
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		name, err := resolveK8sNodeByIP(ctx, ip)
		if err == nil && name != "" && name != oldName {
			if ready, _ := isNodeReady(name); ready {
				return name, nil
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(15 * time.Second):
		}
	}
	return "", fmt.Errorf("timed out after %s waiting for a new Ready K8s node at %s (old=%q)", timeout, ip, oldName)
}

// resolveTalosClusterDir returns an absolute path to the talos-cluster
// terragrunt module. Expected to be run from the repo root (matches how the
// Taskfile invokes the binary via ROOT_DIR).
func resolveTalosClusterDir() (string, error) {
	abs, err := filepath.Abs(talosClusterModuleDir)
	if err != nil {
		return "", err
	}
	stat, err := os.Stat(abs)
	if err != nil || !stat.IsDir() {
		return "", fmt.Errorf("talos-cluster module not found at %s (run from repo root)", abs)
	}
	return abs, nil
}

// resolveOpEnvFile returns the absolute path to .env.op in the current
// working directory.
func resolveOpEnvFile() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	f := filepath.Join(cwd, ".env.op")
	if _, err := os.Stat(f); err != nil {
		return "", fmt.Errorf(".env.op not found at %s (required for terragrunt secret injection)", f)
	}
	return f, nil
}

// isNodeReady queries the Kubernetes API for the given node's Ready condition.
func isNodeReady(node string) (bool, error) {
	if utils.DryRun {
		return true, nil
	}
	out, err := exec.Command("kubectl", "get", "node", node,
		"-o", `jsonpath={.status.conditions[?(@.type=="Ready")].status}`).Output()
	if err != nil {
		return false, fmt.Errorf("kubectl get node %q: %w", node, err)
	}
	return strings.TrimSpace(string(out)) == "True", nil
}

// streamCmd runs a command with live stdout/stderr on the user's terminal.
// When dir is non-empty it is used as the working directory. When opEnvFile is
// non-empty the command is wrapped in `op run --env-file=<file> -- <cmd>` so
// 1Password secret references resolve in the child's environment. When
// teeFile is non-empty stdout/stderr are also written to that path.
func streamCmd(dir, opEnvFile, teeFile string, name string, args ...string) error {
	realName := name
	realArgs := args
	if opEnvFile != "" {
		realName = "op"
		realArgs = append([]string{"run", "--env-file=" + opEnvFile, "--", name}, args...)
	}

	if utils.DryRun {
		prefix := ""
		if dir != "" {
			prefix = "[dir=" + dir + "] "
		}
		logger.Warn(fmt.Sprintf("Would run: %s%s %s", prefix, realName, strings.Join(realArgs, " ")))
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := exec.CommandContext(ctx, realName, realArgs...)
	c.Dir = dir
	c.Env = os.Environ()
	c.Stdin = os.Stdin

	var outW io.Writer = os.Stdout
	var errW io.Writer = os.Stderr
	if teeFile != "" {
		f, ferr := os.Create(teeFile)
		if ferr != nil {
			return fmt.Errorf("open tee file %s: %w", teeFile, ferr)
		}
		defer f.Close()
		outW = io.MultiWriter(os.Stdout, f)
		errW = io.MultiWriter(os.Stderr, f)
	}
	c.Stdout = outW
	c.Stderr = errW

	start := time.Now()
	if rerr := c.Run(); rerr != nil {
		return fmt.Errorf("%s %s: %w (elapsed %s)", realName, strings.Join(realArgs, " "), rerr, time.Since(start).Round(time.Second))
	}
	return nil
}

// lookupVMResourceAddress runs `terragrunt state list` in the talos-cluster
// module and returns the Terraform resource address for the VM whose
// for_each key equals node.
func lookupVMResourceAddress(moduleDir, opEnvFile, node string) (string, error) {
	if utils.DryRun {
		return fmt.Sprintf(`proxmox_virtual_environment_vm.worker["%s"]`, node), nil
	}

	// --no-masking: op otherwise redacts "proxmox" from stdout (it appears in
	// concealed env values), which prevents vmAddressRe from matching.
	c := exec.Command("op", "run", "--no-masking", "--env-file="+opEnvFile, "--", "terragrunt", "state", "list")
	c.Dir = moduleDir
	c.Env = os.Environ()
	var stderr strings.Builder
	c.Stderr = &stderr
	out, err := c.Output()
	if err != nil {
		return "", fmt.Errorf("terragrunt state list: %w (stderr: %s)", err, stderr.String())
	}
	return findVMAddress(string(out), node)
}

// findVMAddress scans `terragrunt state list` output for the Proxmox VM
// resource whose for_each key matches node. Pure function — unit tested.
func findVMAddress(stateListOutput, node string) (string, error) {
	scanner := bufio.NewScanner(strings.NewReader(stateListOutput))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		m := vmAddressRe.FindStringSubmatch(line)
		if m != nil && m[1] == node {
			return line, nil
		}
	}
	return "", fmt.Errorf("no proxmox_virtual_environment_vm.*[%q] resource in terragrunt state", node)
}

// terragruntApplyReplace runs `terragrunt apply -replace=<address>` with
// non-interactive + auto-approve, streaming output to the terminal and
// tee'ing to talosApplyLogPath so the operator has an audit trail.
func terragruntApplyReplace(moduleDir, opEnvFile, address string) error {
	return streamCmd(moduleDir, opEnvFile, talosApplyLogPath,
		"terragrunt", "--non-interactive", "apply",
		"-replace="+address,
		"-auto-approve",
	)
}
