#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env

/**
 * Cilium LB IPAM Migration Verification Script
 *
 * TDD verification for MetalLB to Cilium LB IPAM migration.
 * Run with different phases:
 *   - pre-migration: Establish baseline (Traefik IP, external connectivity)
 *   - post-cilium: Verify Cilium BGP enabled, CRDs deployed
 *   - post-removal: Verify MetalLB removed, Cilium handling all LB traffic
 */

const TRAEFIK_EXPECTED_IP = "172.16.100.101";
const IP_POOL_RANGE = "172.16.100.100-172.16.100.200";
const LOCAL_ASN = 64512;
const PEER_ASN = 64513;
const UNIFI_GATEWAY_IP = "172.16.100.1";

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  error?: string;
}

interface TestPhase {
  name: string;
  tests: (() => Promise<TestResult>)[];
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

// Helper to run cilium CLI commands via exec into cilium pod
async function ciliumCli(args: string[]): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const cmd = new Deno.Command("kubectl", {
    args: ["-n", "kube-system", "exec", "ds/cilium", "-c", "cilium-agent", "--", "cilium", ...args],
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
// Pre-Migration Tests - Establish baseline
// ============================================================================

async function testTraefikIP(): Promise<TestResult> {
  const result = await kubectl([
    "-n", "traefik",
    "get", "svc", "traefik",
    "-o", "jsonpath={.status.loadBalancer.ingress[0].ip}"
  ]);

  const ip = result.stdout.trim();
  const passed = ip === TRAEFIK_EXPECTED_IP;

  return {
    name: "Traefik has expected LoadBalancer IP",
    passed,
    message: passed
      ? `Traefik IP is ${ip} ✓`
      : `Expected ${TRAEFIK_EXPECTED_IP}, got ${ip || "no IP assigned"}`,
    error: result.success ? undefined : result.stderr,
  };
}

async function testExternalHTTPS(): Promise<TestResult> {
  try {
    const cmd = new Deno.Command("curl", {
      args: [
        "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "--connect-timeout", "10",
        "--resolve", `traefik.ryanmcafee.com:443:${TRAEFIK_EXPECTED_IP}`,
        "-k",
        "https://traefik.ryanmcafee.com/dashboard/"
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout } = await cmd.output();
    const httpCode = new TextDecoder().decode(stdout).trim();

    // Accept 200, 302 (redirect), or 401/403 (auth required but reachable)
    const passed = code === 0 && ["200", "302", "401", "403"].includes(httpCode);

    return {
      name: "External HTTPS connectivity works",
      passed,
      message: passed
        ? `HTTPS reachable (HTTP ${httpCode}) ✓`
        : `HTTP ${httpCode} - connectivity issue`,
    };
  } catch (e) {
    return {
      name: "External HTTPS connectivity works",
      passed: false,
      message: "Failed to test external connectivity",
      error: String(e),
    };
  }
}

// ============================================================================
// Post-Cilium Tests - Verify Cilium BGP and CRDs
// ============================================================================

async function testCiliumBGPEnabled(): Promise<TestResult> {
  const result = await kubectl([
    "-n", "kube-system",
    "get", "cm", "cilium-config",
    "-o", "jsonpath={.data.enable-bgp-control-plane}"
  ]);

  const enabled = result.stdout.trim() === "true";

  return {
    name: "Cilium BGP Control Plane enabled",
    passed: enabled,
    message: enabled
      ? "BGP Control Plane is enabled ✓"
      : "BGP Control Plane not enabled in cilium-config",
    error: result.success ? undefined : result.stderr,
  };
}

async function testCiliumLoadBalancerIPPool(): Promise<TestResult> {
  const result = await kubectl([
    "get", "ciliumloadbalancerippool", "default",
    "-o", "jsonpath={.spec.blocks[0].cidr}"
  ]);

  // CiliumLoadBalancerIPPool uses CIDR blocks, not ranges
  // The pool might use either format - check for existence first
  const existsResult = await kubectl([
    "get", "ciliumloadbalancerippool", "default", "-o", "name"
  ]);

  if (!existsResult.success || !existsResult.stdout.trim()) {
    return {
      name: "CiliumLoadBalancerIPPool exists",
      passed: false,
      message: "CiliumLoadBalancerIPPool 'default' not found",
      error: existsResult.stderr,
    };
  }

  return {
    name: "CiliumLoadBalancerIPPool exists",
    passed: true,
    message: `CiliumLoadBalancerIPPool 'default' exists ✓`,
  };
}

async function testCiliumBGPClusterConfig(): Promise<TestResult> {
  const result = await kubectl([
    "get", "ciliumbgpclusterconfig", "homelab-bgp",
    "-o", "jsonpath={.spec.bgpInstances[0].localASN}"
  ]);

  const asn = parseInt(result.stdout.trim());
  const passed = asn === LOCAL_ASN;

  return {
    name: "CiliumBGPClusterConfig exists with correct ASN",
    passed,
    message: passed
      ? `CiliumBGPClusterConfig has ASN ${asn} ✓`
      : `Expected ASN ${LOCAL_ASN}, got ${asn || "not found"}`,
    error: result.success ? undefined : result.stderr,
  };
}

async function testCiliumBGPPeerConfig(): Promise<TestResult> {
  const result = await kubectl([
    "get", "ciliumbgppeerconfig", "unifi-gateway-peer",
    "-o", "name"
  ]);

  const exists = result.success && result.stdout.trim().length > 0;

  return {
    name: "CiliumBGPPeerConfig for UniFi gateway exists",
    passed: exists,
    message: exists
      ? "CiliumBGPPeerConfig 'unifi-gateway-peer' exists ✓"
      : "CiliumBGPPeerConfig 'unifi-gateway-peer' not found",
    error: result.success ? undefined : result.stderr,
  };
}

async function testCiliumBGPAdvertisement(): Promise<TestResult> {
  const result = await kubectl([
    "get", "ciliumbgpadvertisement", "loadbalancer-ips",
    "-o", "jsonpath={.spec.advertisements[0].advertisementType}"
  ]);

  const advType = result.stdout.trim();
  const passed = advType === "Service";

  return {
    name: "CiliumBGPAdvertisement configured for LoadBalancer services",
    passed,
    message: passed
      ? "CiliumBGPAdvertisement for LoadBalancer services exists ✓"
      : `CiliumBGPAdvertisement type: ${advType || "not found"}`,
    error: result.success ? undefined : result.stderr,
  };
}

async function testBGPSessionEstablished(): Promise<TestResult> {
  const result = await ciliumCli(["bgp", "peers"]);

  if (!result.success) {
    return {
      name: "BGP session established with UniFi gateway",
      passed: false,
      message: "Failed to query Cilium BGP peers",
      error: result.stderr,
    };
  }

  // Check for established session with the UniFi gateway
  const output = result.stdout;
  const hasEstablished = output.toLowerCase().includes("established") &&
    output.includes(UNIFI_GATEWAY_IP);

  return {
    name: "BGP session established with UniFi gateway",
    passed: hasEstablished,
    message: hasEstablished
      ? `BGP session with ${UNIFI_GATEWAY_IP} is established ✓`
      : `BGP session not established. Output: ${output.substring(0, 200)}`,
  };
}

// ============================================================================
// Post-Removal Tests - Verify MetalLB removed
// ============================================================================

async function testMetalLBNamespaceRemoved(): Promise<TestResult> {
  const result = await kubectl(["get", "namespace", "metallb-system", "-o", "name"]);

  const removed = !result.success || !result.stdout.trim();

  return {
    name: "MetalLB namespace removed",
    passed: removed,
    message: removed
      ? "MetalLB namespace no longer exists ✓"
      : "MetalLB namespace still exists - needs cleanup",
  };
}

async function testTraefikAnnotationUpdated(): Promise<TestResult> {
  const result = await kubectl([
    "-n", "traefik",
    "get", "svc", "traefik",
    "-o", "jsonpath={.metadata.annotations}"
  ]);

  const annotations = result.stdout.trim();
  const hasOldAnnotation = annotations.includes("metallb.universe.tf");
  const hasNewAnnotation = annotations.includes("io.cilium/lb-ipam-ips");

  const passed = !hasOldAnnotation && hasNewAnnotation;

  return {
    name: "Traefik service annotation updated to Cilium",
    passed,
    message: passed
      ? "Traefik uses io.cilium/lb-ipam-ips annotation ✓"
      : hasOldAnnotation
        ? "Still using MetalLB annotation"
        : "Missing Cilium LB IPAM annotation",
  };
}

// ============================================================================
// Test Runner
// ============================================================================

const phases: Record<string, TestPhase> = {
  "pre-migration": {
    name: "Pre-Migration Baseline",
    tests: [testTraefikIP, testExternalHTTPS],
  },
  "post-cilium": {
    name: "Post-Cilium Deployment",
    tests: [
      testCiliumBGPEnabled,
      testCiliumLoadBalancerIPPool,
      testCiliumBGPClusterConfig,
      testCiliumBGPPeerConfig,
      testCiliumBGPAdvertisement,
      testTraefikIP,
      testExternalHTTPS,
      testBGPSessionEstablished,
    ],
  },
  "post-removal": {
    name: "Post-MetalLB Removal",
    tests: [
      testMetalLBNamespaceRemoved,
      testCiliumBGPEnabled,
      testCiliumLoadBalancerIPPool,
      testCiliumBGPClusterConfig,
      testTraefikIP,
      testTraefikAnnotationUpdated,
      testExternalHTTPS,
      testBGPSessionEstablished,
    ],
  },
};

async function runPhase(phaseName: string): Promise<void> {
  const phase = phases[phaseName];
  if (!phase) {
    console.error(`Unknown phase: ${phaseName}`);
    console.error(`Available phases: ${Object.keys(phases).join(", ")}`);
    Deno.exit(1);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${phase.name} Tests`);
  console.log(`${"=".repeat(60)}\n`);

  const results: TestResult[] = [];
  for (const testFn of phase.tests) {
    const result = await testFn();
    results.push(result);

    const status = result.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${status}: ${result.name}`);
    console.log(`       ${result.message}`);
    if (result.error) {
      console.log(`       Error: ${result.error.substring(0, 100)}`);
    }
    console.log();
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const allPassed = passed === total;

  console.log(`${"=".repeat(60)}`);
  console.log(`  Results: ${passed}/${total} tests passed`);
  console.log(`${"=".repeat(60)}\n`);

  Deno.exit(allPassed ? 0 : 1);
}

// Main
const phase = Deno.args[0] || "pre-migration";
await runPhase(phase);
