#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env

/**
 * GPU Support Verification Script
 *
 * Verifies that NVIDIA GPU support is properly configured in the Talos cluster.
 * Checks:
 *   - NVIDIA kernel modules are loaded on GPU node
 *   - RuntimeClass "nvidia" exists
 *   - GPU operator pods are healthy
 *   - GPU resources are advertised by the node
 *   - nvidia-smi works on the GPU node
 *
 * Usage:
 *   deno run --allow-net --allow-run --allow-env scripts/verify-gpu-support.ts
 */

const GPU_NODE_NAME = "worker-1";
const GPU_NODE_IP = "172.16.100.21";
const GPU_OPERATOR_NAMESPACE = "gpu-operator";

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  error?: string;
}

// Helper to run kubectl commands
async function kubectl(args: string[]): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const cmd = new Deno.Command("kubectl", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    success: code === 0,
  };
}

// Helper to run talosctl commands
async function talosctl(args: string[]): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const cmd = new Deno.Command("talosctl", {
    args: ["-n", GPU_NODE_IP, ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    success: code === 0,
  };
}

// ============================================================================
// Talos System Extension Tests
// ============================================================================

async function testNvidiaExtensionInstalled(): Promise<TestResult> {
  const result = await talosctl(["get", "extensions"]);

  if (!result.success) {
    return {
      name: "NVIDIA extension installed in Talos",
      passed: false,
      message: "Failed to get extensions from Talos",
      error: result.stderr,
    };
  }

  const hasNvidiaKmod = result.stdout.includes("nonfree-kmod-nvidia");
  const hasToolkit = result.stdout.includes("nvidia-container-toolkit");
  const passed = hasNvidiaKmod && hasToolkit;

  return {
    name: "NVIDIA extensions installed in Talos",
    passed,
    message: passed
      ? "Both nonfree-kmod-nvidia and nvidia-container-toolkit installed"
      : `Missing extensions: ${!hasNvidiaKmod ? "nonfree-kmod-nvidia " : ""}${!hasToolkit ? "nvidia-container-toolkit" : ""}`,
    error: result.success ? undefined : result.stderr,
  };
}

async function testNvidiaKernelModulesLoaded(): Promise<TestResult> {
  const result = await talosctl(["read", "/proc/modules"]);

  if (!result.success) {
    return {
      name: "NVIDIA kernel modules loaded",
      passed: false,
      message: "Failed to read /proc/modules from Talos node",
      error: result.stderr,
    };
  }

  const modules = result.stdout.toLowerCase();
  const hasNvidia = modules.includes("nvidia ");
  const hasNvidiaUvm = modules.includes("nvidia_uvm");
  const hasNvidiaDrm = modules.includes("nvidia_drm");

  const passed = hasNvidia && hasNvidiaUvm;

  return {
    name: "NVIDIA kernel modules loaded",
    passed,
    message: passed
      ? `nvidia=${hasNvidia}, nvidia_uvm=${hasNvidiaUvm}, nvidia_drm=${hasNvidiaDrm}`
      : "NVIDIA kernel modules not loaded - check Talos config",
  };
}

// ============================================================================
// Kubernetes RuntimeClass Tests
// ============================================================================

async function testNvidiaRuntimeClassExists(): Promise<TestResult> {
  const result = await kubectl(["get", "runtimeclass", "nvidia", "-o", "name"]);

  const exists = result.success && result.stdout.trim().length > 0;

  return {
    name: "RuntimeClass 'nvidia' exists",
    passed: exists,
    message: exists
      ? "RuntimeClass 'nvidia' is configured"
      : "RuntimeClass 'nvidia' not found - GPU operator may not be deployed",
    error: result.success ? undefined : result.stderr,
  };
}

async function testNvidiaRuntimeHandler(): Promise<TestResult> {
  const result = await kubectl([
    "get", "runtimeclass", "nvidia",
    "-o", "jsonpath={.handler}",
  ]);

  const handler = result.stdout.trim();
  const passed = handler === "nvidia";

  return {
    name: "RuntimeClass handler is correct",
    passed,
    message: passed
      ? `Handler is 'nvidia'`
      : `Expected handler 'nvidia', got '${handler || "none"}'`,
    error: result.success ? undefined : result.stderr,
  };
}

// ============================================================================
// GPU Operator Tests
// ============================================================================

async function testGpuOperatorNamespaceExists(): Promise<TestResult> {
  const result = await kubectl(["get", "namespace", GPU_OPERATOR_NAMESPACE, "-o", "name"]);

  const exists = result.success && result.stdout.trim().length > 0;

  return {
    name: "GPU operator namespace exists",
    passed: exists,
    message: exists
      ? `Namespace '${GPU_OPERATOR_NAMESPACE}' exists`
      : `Namespace '${GPU_OPERATOR_NAMESPACE}' not found`,
    error: result.success ? undefined : result.stderr,
  };
}

async function testGpuOperatorPodsRunning(): Promise<TestResult> {
  const result = await kubectl([
    "-n", GPU_OPERATOR_NAMESPACE,
    "get", "pods",
    "-o", "jsonpath={range .items[*]}{.metadata.name},{.status.phase}{\"\\n\"}{end}",
  ]);

  if (!result.success) {
    return {
      name: "GPU operator pods are running",
      passed: false,
      message: "Failed to get GPU operator pods",
      error: result.stderr,
    };
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) {
    return {
      name: "GPU operator pods are running",
      passed: false,
      message: "No pods found in GPU operator namespace",
    };
  }

  const podStatuses: string[] = [];
  let allRunning = true;

  for (const line of lines) {
    const [name, phase] = line.split(",");
    podStatuses.push(`${name}=${phase}`);
    if (phase !== "Running" && phase !== "Succeeded") {
      allRunning = false;
    }
  }

  return {
    name: "GPU operator pods are running",
    passed: allRunning,
    message: allRunning
      ? `All ${lines.length} pods healthy`
      : `Some pods not running: ${podStatuses.filter(s => !s.endsWith("Running") && !s.endsWith("Succeeded")).join(", ")}`,
  };
}

async function testGpuOperatorDaemonset(): Promise<TestResult> {
  const result = await kubectl([
    "-n", GPU_OPERATOR_NAMESPACE,
    "get", "ds",
    "-o", "jsonpath={range .items[*]}{.metadata.name},{.status.numberReady}/{.status.desiredNumberScheduled}{\"\\n\"}{end}",
  ]);

  if (!result.success) {
    return {
      name: "GPU operator daemonsets healthy",
      passed: false,
      message: "Failed to get GPU operator daemonsets",
      error: result.stderr,
    };
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const daemonsets: string[] = [];
  let allHealthy = true;

  for (const line of lines) {
    const [name, readiness] = line.split(",");
    const [ready, desired] = readiness.split("/").map(Number);
    daemonsets.push(`${name}=${ready}/${desired}`);
    if (ready !== desired || desired === 0) {
      allHealthy = false;
    }
  }

  return {
    name: "GPU operator daemonsets healthy",
    passed: allHealthy,
    message: allHealthy
      ? `Daemonsets healthy: ${daemonsets.join(", ")}`
      : `Daemonsets not fully ready: ${daemonsets.join(", ")}`,
  };
}

// ============================================================================
// Node GPU Resource Tests
// ============================================================================

async function testNodeHasGpuLabel(): Promise<TestResult> {
  const result = await kubectl([
    "get", "node", GPU_NODE_NAME,
    "-o", "jsonpath={.metadata.labels.nvidia\\.com/gpu}",
  ]);

  const hasLabel = result.stdout.trim() === "true";

  return {
    name: "GPU node has nvidia.com/gpu label",
    passed: hasLabel,
    message: hasLabel
      ? `Node ${GPU_NODE_NAME} has nvidia.com/gpu=true label`
      : `Node ${GPU_NODE_NAME} missing nvidia.com/gpu label`,
    error: result.success ? undefined : result.stderr,
  };
}

async function testNodeAdvertisesGpuResource(): Promise<TestResult> {
  const result = await kubectl([
    "get", "node", GPU_NODE_NAME,
    "-o", "jsonpath={.status.capacity.nvidia\\.com/gpu}",
  ]);

  const gpuCount = result.stdout.trim();
  const hasGpu = gpuCount && parseInt(gpuCount) > 0;

  return {
    name: "Node advertises GPU resources",
    passed: Boolean(hasGpu),
    message: hasGpu
      ? `Node ${GPU_NODE_NAME} has ${gpuCount} GPU(s) available`
      : `Node ${GPU_NODE_NAME} not advertising GPU resources (got: '${gpuCount}')`,
    error: result.success ? undefined : result.stderr,
  };
}

async function testAllocatableGpu(): Promise<TestResult> {
  const result = await kubectl([
    "get", "node", GPU_NODE_NAME,
    "-o", "jsonpath={.status.allocatable.nvidia\\.com/gpu}",
  ]);

  const gpuCount = result.stdout.trim();
  const hasGpu = gpuCount && parseInt(gpuCount) > 0;

  return {
    name: "GPU is allocatable (not reserved)",
    passed: Boolean(hasGpu),
    message: hasGpu
      ? `${gpuCount} GPU(s) allocatable on ${GPU_NODE_NAME}`
      : `No GPUs allocatable on ${GPU_NODE_NAME}`,
    error: result.success ? undefined : result.stderr,
  };
}

// ============================================================================
// nvidia-smi Test
// ============================================================================

async function testNvidiaSmiWorking(): Promise<TestResult> {
  // Run nvidia-smi through a test pod on the GPU node
  const podName = `nvidia-smi-test-${Date.now()}`;

  // Create test pod
  const createResult = await kubectl([
    "run", podName,
    "--image=nvcr.io/nvidia/cuda:12.4.1-base-ubuntu22.04",
    "--restart=Never",
    "--rm",
    "-i",
    "--timeout=60s",
    `--overrides={
      "spec": {
        "runtimeClassName": "nvidia",
        "nodeSelector": {"kubernetes.io/hostname": "${GPU_NODE_NAME}"},
        "containers": [{
          "name": "${podName}",
          "image": "nvcr.io/nvidia/cuda:12.4.1-base-ubuntu22.04",
          "command": ["nvidia-smi", "-L"],
          "resources": {
            "limits": {"nvidia.com/gpu": "1"}
          }
        }]
      }
    }`,
    "--", "nvidia-smi", "-L",
  ]);

  if (!createResult.success) {
    // Check if RuntimeClass doesn't exist (common early failure)
    if (createResult.stderr.includes("runtimeclass") || createResult.stderr.includes("nvidia")) {
      return {
        name: "nvidia-smi works in container",
        passed: false,
        message: "RuntimeClass 'nvidia' not available or GPU operator not ready",
        error: createResult.stderr.substring(0, 200),
      };
    }

    return {
      name: "nvidia-smi works in container",
      passed: false,
      message: "Failed to run nvidia-smi test pod",
      error: createResult.stderr.substring(0, 200),
    };
  }

  const output = createResult.stdout.trim();
  const hasGpu = output.toLowerCase().includes("gpu") || output.includes("UUID");

  return {
    name: "nvidia-smi works in container",
    passed: hasGpu,
    message: hasGpu
      ? `nvidia-smi output: ${output.substring(0, 100)}`
      : `nvidia-smi did not detect GPU: ${output}`,
  };
}

// ============================================================================
// Test Runner
// ============================================================================

async function runAllTests(): Promise<void> {
  console.log(`
${"=".repeat(60)}
  GPU Support Verification
${"=".repeat(60)}
  GPU Node: ${GPU_NODE_NAME} (${GPU_NODE_IP})
  Namespace: ${GPU_OPERATOR_NAMESPACE}
${"=".repeat(60)}
`);

  const tests = [
    // Talos system extension tests
    { category: "Talos System Extensions", tests: [testNvidiaExtensionInstalled, testNvidiaKernelModulesLoaded] },

    // Kubernetes RuntimeClass tests
    { category: "Kubernetes RuntimeClass", tests: [testNvidiaRuntimeClassExists, testNvidiaRuntimeHandler] },

    // GPU Operator tests
    { category: "GPU Operator", tests: [testGpuOperatorNamespaceExists, testGpuOperatorPodsRunning, testGpuOperatorDaemonset] },

    // Node resource tests
    { category: "Node GPU Resources", tests: [testNodeHasGpuLabel, testNodeAdvertisesGpuResource, testAllocatableGpu] },

    // Functional test
    { category: "Functional Test", tests: [testNvidiaSmiWorking] },
  ];

  const allResults: TestResult[] = [];

  for (const section of tests) {
    console.log(`\n--- ${section.category} ---\n`);

    for (const testFn of section.tests) {
      const result = await testFn();
      allResults.push(result);

      const status = result.passed ? "PASS" : "FAIL";
      console.log(`${status}: ${result.name}`);
      console.log(`       ${result.message}`);
      if (result.error) {
        console.log(`       Error: ${result.error.substring(0, 100)}`);
      }
    }
  }

  // Summary
  const passed = allResults.filter((r) => r.passed).length;
  const total = allResults.length;
  const allPassed = passed === total;

  console.log(`
${"=".repeat(60)}
  Results: ${passed}/${total} tests passed
${"=".repeat(60)}
`);

  if (!allPassed) {
    console.log(`
Troubleshooting:
  1. If Talos extensions missing, regenerate Talos image:
     task talos:upgrade:image

  2. If kernel modules not loaded, check machine config:
     talosctl -n ${GPU_NODE_IP} get machineconfig -o yaml | grep -A10 kernel

  3. If GPU operator pods failing, check logs:
     kubectl -n ${GPU_OPERATOR_NAMESPACE} logs -l app=gpu-operator

  4. If node not advertising GPUs, check device plugin:
     kubectl -n ${GPU_OPERATOR_NAMESPACE} logs -l app=nvidia-device-plugin-daemonset
`);
  }

  Deno.exit(allPassed ? 0 : 1);
}

// Run
await runAllTests();
