package commands

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ryanmcafee/homelab/internal/logger"
	"github.com/ryanmcafee/homelab/internal/utils"
	"github.com/spf13/cobra"
)

// perCheckTimeout bounds every individual cluster query. The parent cobra
// RunE wraps the full dispatch in a 2-minute deadline; this prevents any
// one check from consuming the whole budget (threat T-07-03).
const perCheckTimeout = 30 * time.Second

// gpuCheckRunner abstracts cluster queries so verifyGPU is unit-testable.
// The production implementation is kubectlGPUCheckRunner; tests provide a
// fake in verify_test.go.
type gpuCheckRunner interface {
	NodeAllocatable(ctx context.Context, node string) (map[string]string, error)
	RuntimeClassExists(ctx context.Context, name string) (bool, error)
	NamespacePodsHealthy(ctx context.Context, namespace string) (bool, error)
	DevDriDeviceNodes(ctx context.Context, namespace string) ([]string, error)
}

// kubectlGPUCheckRunner is the production implementation. Every method uses
// a bounded context and a FIXED argv slice — no string concatenation with
// any config-derived or user-supplied value (threat T-07-01).
type kubectlGPUCheckRunner struct{}

// NodeAllocatable returns the node's allocatable resources as a flat
// resource -> quantity map. It parses `kubectl get node <node> -o json` and
// extracts only the allocatable map, never logging the full JSON (T-07-02).
func (k kubectlGPUCheckRunner) NodeAllocatable(ctx context.Context, node string) (map[string]string, error) {
	cctx, cancel := context.WithTimeout(ctx, perCheckTimeout)
	defer cancel()

	// Fixed argv — node is a compile-time constant from the caller.
	cmd := exec.CommandContext(cctx, "kubectl", "get", "node", node, "-o", "json")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl get node %s: %w", node, stderrOf(err))
	}

	// Parse only the fields we need — never log the raw JSON.
	var parsed struct {
		Status struct {
			Allocatable map[string]string `json:"allocatable"`
		} `json:"status"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, fmt.Errorf("parsing node %s allocatable: %w", node, err)
	}
	if parsed.Status.Allocatable == nil {
		return map[string]string{}, nil
	}
	return parsed.Status.Allocatable, nil
}

// RuntimeClassExists returns true when `kubectl get runtimeclass <name>`
// exits successfully.
func (k kubectlGPUCheckRunner) RuntimeClassExists(ctx context.Context, name string) (bool, error) {
	cctx, cancel := context.WithTimeout(ctx, perCheckTimeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, "kubectl", "get", "runtimeclass", name)
	if err := cmd.Run(); err != nil {
		// Distinguish "not found" (exit 1) from other errors (kubectl missing, cluster unreachable).
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return false, nil
		}
		return false, fmt.Errorf("kubectl get runtimeclass %s: %w", name, err)
	}
	return true, nil
}

// NamespacePodsHealthy returns true when every pod in the namespace is in
// phase Running or Succeeded. Errors are returned unwrapped for caller
// wrapping.
func (k kubectlGPUCheckRunner) NamespacePodsHealthy(ctx context.Context, namespace string) (bool, error) {
	cctx, cancel := context.WithTimeout(ctx, perCheckTimeout)
	defer cancel()

	cmd := exec.CommandContext(
		cctx, "kubectl", "-n", namespace, "get", "pods",
		"-o", "jsonpath={range .items[*]}{.status.phase}{\"\\n\"}{end}",
	)
	out, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("kubectl -n %s get pods: %w", namespace, stderrOf(err))
	}

	phases := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(phases) == 0 || (len(phases) == 1 && phases[0] == "") {
		// Empty namespace or no pods — treat as unhealthy. For our use case
		// (gpu-operator, intel-device-plugins) an empty namespace means
		// not-installed.
		return false, nil
	}
	for _, p := range phases {
		if p != "Running" && p != "Succeeded" {
			return false, nil
		}
	}
	return true, nil
}

// DevDriDeviceNodes enumerates /dev/dri device nodes visible inside a pod
// running in the given namespace. It execs `ls /dev/dri` in the first pod
// it finds (typically an intel-device-plugins daemonset pod).
func (k kubectlGPUCheckRunner) DevDriDeviceNodes(ctx context.Context, namespace string) ([]string, error) {
	cctx, cancel := context.WithTimeout(ctx, perCheckTimeout)
	defer cancel()

	// Find any running pod in the namespace with a fixed jsonpath.
	podCmd := exec.CommandContext(
		cctx, "kubectl", "-n", namespace, "get", "pods",
		"--field-selector=status.phase=Running",
		"-o", "jsonpath={.items[0].metadata.name}",
	)
	podOut, err := podCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl -n %s get pods: %w", namespace, stderrOf(err))
	}
	podName := strings.TrimSpace(string(podOut))
	if podName == "" {
		return nil, fmt.Errorf("no running pod in namespace %s", namespace)
	}

	execCmd := exec.CommandContext(
		cctx, "kubectl", "-n", namespace, "exec", podName, "--", "ls", "/dev/dri",
	)
	execOut, err := execCmd.Output()
	if err != nil {
		return nil, fmt.Errorf("kubectl exec in %s/%s: %w", namespace, podName, stderrOf(err))
	}

	fields := strings.Fields(string(execOut))
	sort.Strings(fields)
	return fields, nil
}

// stderrOf returns an error enriched with stderr content when the cause is
// an *exec.ExitError. Safe to call with any error.
func stderrOf(err error) error {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(exitErr.Stderr)))
	}
	return err
}

// verifyGPU dispatches to vendor-specific check logic based on the value
// resolved from `GPU_VENDOR` in the homelab config pipeline. The vendor
// string MUST come from the schema-validated config pipeline — never from
// os.Getenv (threat T-07-05).
func verifyGPU(ctx context.Context, vendor, node string, runner gpuCheckRunner) error {
	switch vendor {
	case "none":
		logger.Info("GPU_VENDOR=none — skipping GPU checks (expected on GPU-free clones)")
		return nil
	case "nvidia":
		return verifyNvidiaGPU(ctx, node, runner)
	case "intel":
		return verifyIntelGPU(ctx, node, runner)
	case "":
		return fmt.Errorf("GPU_VENDOR not set in resolved config")
	default:
		return fmt.Errorf("unsupported GPU vendor %q (expected none|nvidia|intel)", vendor)
	}
}

// verifyNvidiaGPU runs the NVIDIA-specific check set.
func verifyNvidiaGPU(ctx context.Context, node string, runner gpuCheckRunner) error {
	logger.Info("Running NVIDIA GPU verification...")

	ok, err := runner.RuntimeClassExists(ctx, "nvidia")
	if err != nil {
		return fmt.Errorf("nvidia check %q failed: %w", "runtime-class", err)
	}
	if !ok {
		return fmt.Errorf("nvidia check %q failed: RuntimeClass 'nvidia' not found", "runtime-class")
	}
	logger.OK("RuntimeClass 'nvidia' present")

	alloc, err := runner.NodeAllocatable(ctx, node)
	if err != nil {
		return fmt.Errorf("nvidia check %q failed: %w", "allocatable", err)
	}
	qty, ok := alloc["nvidia.com/gpu"]
	if !ok {
		return fmt.Errorf("nvidia check %q failed: resource nvidia.com/gpu not advertised on %s", "allocatable", node)
	}
	if n, _ := strconv.Atoi(qty); n < 1 {
		return fmt.Errorf("nvidia check %q failed: nvidia.com/gpu=%s on %s (want >=1)", "allocatable", qty, node)
	}
	logger.OK(fmt.Sprintf("nvidia.com/gpu=%s on %s", qty, node))

	healthy, err := runner.NamespacePodsHealthy(ctx, "gpu-operator")
	if err != nil {
		return fmt.Errorf("nvidia check %q failed: %w", "namespace-health", err)
	}
	if !healthy {
		return fmt.Errorf("nvidia check %q failed: gpu-operator namespace has unhealthy pods", "namespace-health")
	}
	logger.OK("gpu-operator namespace healthy")

	return nil
}

// verifyIntelGPU runs the Intel-specific check set.
func verifyIntelGPU(ctx context.Context, node string, runner gpuCheckRunner) error {
	logger.Info("Running Intel GPU verification...")

	alloc, err := runner.NodeAllocatable(ctx, node)
	if err != nil {
		return fmt.Errorf("intel check %q failed: %w", "allocatable", err)
	}
	qty, ok := alloc["gpu.intel.com/xe"]
	if !ok {
		return fmt.Errorf("intel check %q failed: resource gpu.intel.com/xe not advertised on %s", "allocatable", node)
	}
	if n, _ := strconv.Atoi(qty); n < 1 {
		return fmt.Errorf("intel check %q failed: gpu.intel.com/xe=%s on %s (want >=1)", "allocatable", qty, node)
	}
	logger.OK(fmt.Sprintf("gpu.intel.com/xe=%s on %s", qty, node))

	healthy, err := runner.NamespacePodsHealthy(ctx, "intel-device-plugins")
	if err != nil {
		return fmt.Errorf("intel check %q failed: %w", "namespace-health", err)
	}
	if !healthy {
		return fmt.Errorf("intel check %q failed: intel-device-plugins namespace has unhealthy pods", "namespace-health")
	}
	logger.OK("intel-device-plugins namespace healthy")

	nodes, err := runner.DevDriDeviceNodes(ctx, "intel-device-plugins")
	if err != nil {
		return fmt.Errorf("intel check %q failed: %w", "dev-dri", err)
	}
	haveCard, haveRender := false, false
	for _, n := range nodes {
		switch n {
		case "card0":
			haveCard = true
		case "renderD128":
			haveRender = true
		}
	}
	if !haveCard || !haveRender {
		return fmt.Errorf("intel check %q failed: /dev/dri missing required nodes (got %v, want card0 + renderD128)", "dev-dri", nodes)
	}
	logger.OK("/dev/dri contains card0 + renderD128")

	return nil
}

// printGPUStatus prints a read-only status summary without failing on
// individual check errors (status mode is advisory, not a health gate).
func printGPUStatus(ctx context.Context, vendor, node string, runner gpuCheckRunner) {
	logger.Info(fmt.Sprintf("Active vendor: %s", vendor))
	logger.Info(fmt.Sprintf("Target node:   %s", node))

	if vendor == "none" {
		logger.Info("Status: GPU support disabled (GPU_VENDOR=none)")
		return
	}

	// Allocatable (applies to both nvidia + intel)
	alloc, err := runner.NodeAllocatable(ctx, node)
	if err != nil {
		logger.Info(fmt.Sprintf("allocatable: unavailable (%v)", err))
	} else {
		resource := ""
		switch vendor {
		case "nvidia":
			resource = "nvidia.com/gpu"
		case "intel":
			resource = "gpu.intel.com/xe"
		}
		if qty, ok := alloc[resource]; ok {
			logger.OK(fmt.Sprintf("%s=%s on %s", resource, qty, node))
		} else {
			logger.Info(fmt.Sprintf("%s: not advertised on %s", resource, node))
		}
	}

	// Namespace health (vendor-specific)
	ns := ""
	switch vendor {
	case "nvidia":
		ns = "gpu-operator"
	case "intel":
		ns = "intel-device-plugins"
	}
	if ns != "" {
		healthy, err := runner.NamespacePodsHealthy(ctx, ns)
		if err != nil {
			logger.Info(fmt.Sprintf("namespace %s: unavailable (%v)", ns, err))
		} else if healthy {
			logger.OK(fmt.Sprintf("namespace %s: healthy", ns))
		} else {
			logger.Info(fmt.Sprintf("namespace %s: unhealthy or empty", ns))
		}
	}
}

func NewVerifyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "verify",
		Short: "Verification utilities",
		Long:  `Verify GPU support, Cilium migration, etc.`,
	}

	cmd.AddCommand(newVerifyGPUCmd())
	cmd.AddCommand(newVerifyCiliumCmd())

	return cmd
}

func newVerifyGPUCmd() *cobra.Command {
	var statusOnly bool

	cmd := &cobra.Command{
		Use:   "gpu",
		Short: "Verify GPU support (vendor-aware)",
		Long:  `Verify GPU support in the Talos cluster. The active vendor is resolved from the GPU_VENDOR key in the homelab config pipeline (none|nvidia|intel).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			logger.Info("======================================")
			logger.Info("  GPU Support Verification")
			logger.Info("======================================")

			rc, err := loadResolvedConfig()
			if err != nil {
				return fmt.Errorf("loading resolved config: %w", err)
			}
			vendor := rc.Values["GPU_VENDOR"].Value

			ctx, cancel := context.WithTimeout(cmd.Context(), 2*time.Minute)
			defer cancel()

			// Resolve the K8s node name by the GPU worker's InternalIP
			// from the resolved config. The single-GPU topology pins this
			// to WORKER1_IP. The IP comes from schema-validated config;
			// the name comes from cluster state — neither is user input
			// (threat T-07-01 mitigated).
			var node string
			if vendor != "none" {
				gpuIP := rc.Values["WORKER1_IP"].Value
				if gpuIP == "" {
					return fmt.Errorf("WORKER1_IP missing from resolved config")
				}
				n, rerr := resolveK8sNodeByIP(ctx, gpuIP)
				if rerr != nil {
					return fmt.Errorf("resolving GPU K8s node by InternalIP %s: %w", gpuIP, rerr)
				}
				node = n
			}

			logger.Info(fmt.Sprintf("  Active vendor: %s", vendor))
			if node != "" {
				logger.Info(fmt.Sprintf("  Target node:   %s", node))
			} else {
				logger.Info("  Target node:   n/a (GPU disabled)")
			}
			fmt.Println()

			runner := kubectlGPUCheckRunner{}

			if statusOnly {
				printGPUStatus(ctx, vendor, node, runner)
				return nil
			}

			if err := verifyGPU(ctx, vendor, node, runner); err != nil {
				logger.Error(err.Error())
				return err
			}
			logger.OK("All GPU checks passed")
			return nil
		},
	}

	cmd.Flags().BoolVar(&statusOnly, "status-only", false, "Print GPU status summary instead of running health checks")

	return cmd
}

func newVerifyCiliumCmd() *cobra.Command {
	var phase string

	cmd := &cobra.Command{
		Use:   "cilium",
		Short: "Verify Cilium LB migration",
		Long:  `Verify MetalLB to Cilium LB IPAM migration`,
		RunE: func(cmd *cobra.Command, args []string) error {
			utils.DryRun = DryRun

			logger.Info("======================================")
			logger.Info("  Cilium LB Migration Verification")
			logger.Info("======================================")
			logger.Info(fmt.Sprintf("  Phase: %s", phase))
			logger.Info("======================================")
			fmt.Println()

			logger.Warn("Cilium verification implementation pending - feature deferred to future iteration")
			logger.Info("Phases:")
			logger.Info("  pre-migration  - Establish baseline")
			logger.Info("  post-cilium    - Verify Cilium BGP")
			logger.Info("  post-removal   - Verify MetalLB removed")

			return nil
		},
	}

	cmd.Flags().StringVar(&phase, "phase", "pre-migration", "Migration phase to verify")

	return cmd
}
