#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read

/**
 * Talos Node Recreation Script
 *
 * Automates the process of recreating a Talos node via terragrunt taint + apply.
 * This is useful when a node needs to be rebuilt with a new Talos image (e.g., after
 * adding system extensions like NVIDIA drivers).
 *
 * Usage:
 *   deno run --allow-net --allow-run --allow-env --allow-read scripts/talos-node-recreate.ts --node=worker-1
 *
 * Options:
 *   --node=<name>     Node to recreate (e.g., worker-1, controlplane-0)
 *   --skip-drain      Skip draining the node (for already-failed nodes)
 *   --dry-run         Show what would be done without executing
 */

import { parseArgs } from "jsr:@std/cli/parse-args";

interface CommandResult {
  stdout: string;
  stderr: string;
  success: boolean;
  code: number;
}

const TERRAGRUNT_DIR = "terragrunt/environments/homelab/talos-cluster";

// Parse command line arguments
const args = parseArgs(Deno.args, {
  string: ["node"],
  boolean: ["skip-drain", "dry-run", "help"],
  default: {
    node: "worker-1",
    "skip-drain": false,
    "dry-run": false,
    help: false,
  },
});

if (args.help) {
  console.log(`
Talos Node Recreation Script

Recreates a Talos node via terragrunt taint + apply workflow.

Usage:
  deno run --allow-net --allow-run --allow-env --allow-read scripts/talos-node-recreate.ts [options]

Options:
  --node=<name>     Node to recreate (default: worker-1)
  --skip-drain      Skip draining the node (for already-failed nodes)
  --dry-run         Show what would be done without executing
  --help            Show this help message

Examples:
  # Recreate worker-1 (default)
  deno run --allow-net --allow-run --allow-env --allow-read scripts/talos-node-recreate.ts

  # Recreate controlplane-1 without draining
  deno run --allow-net --allow-run --allow-env --allow-read scripts/talos-node-recreate.ts --node=controlplane-1 --skip-drain

  # Dry run to see what would happen
  deno run --allow-net --allow-run --allow-env --allow-read scripts/talos-node-recreate.ts --node=worker-2 --dry-run
`);
  Deno.exit(0);
}

const nodeName = args.node;
const skipDrain = args["skip-drain"];
const dryRun = args["dry-run"];

// Helper to run shell commands
async function run(
  cmd: string,
  cmdArgs: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<CommandResult> {
  const command = new Deno.Command(cmd, {
    args: cmdArgs,
    stdout: "piped",
    stderr: "piped",
    cwd: opts?.cwd,
    env: opts?.env ? { ...Deno.env.toObject(), ...opts.env } : undefined,
  });
  const { code, stdout, stderr } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    success: code === 0,
    code,
  };
}

// Run kubectl command
async function kubectl(cmdArgs: string[]): Promise<CommandResult> {
  return run("kubectl", cmdArgs);
}

// Run op command with secrets injection
async function opRun(cmdArgs: string[]): Promise<CommandResult> {
  return run("op", ["run", "--env-file=.env.op", "--", ...cmdArgs]);
}

// Run terragrunt command via op for secrets
async function terragrunt(cmdArgs: string[], cwd?: string): Promise<CommandResult> {
  return opRun(["terragrunt", ...cmdArgs]);
}

// Check if node exists and get its status
async function getNodeStatus(node: string): Promise<{ exists: boolean; ready: boolean; schedulable: boolean }> {
  const result = await kubectl(["get", "node", node, "-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status},{.spec.unschedulable}"]);

  if (!result.success) {
    return { exists: false, ready: false, schedulable: false };
  }

  const [readyStatus, unschedulable] = result.stdout.split(",");
  return {
    exists: true,
    ready: readyStatus === "True",
    schedulable: unschedulable !== "true",
  };
}

// Check cluster health - ensure other nodes are Ready
async function checkClusterHealth(excludeNode: string): Promise<{ healthy: boolean; readyNodes: number; totalNodes: number }> {
  const result = await kubectl(["get", "nodes", "-o", "jsonpath={range .items[*]}{.metadata.name},{.status.conditions[?(@.type=='Ready')].status}{\"\\n\"}{end}"]);

  if (!result.success) {
    return { healthy: false, readyNodes: 0, totalNodes: 0 };
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  let readyNodes = 0;
  let totalNodes = 0;

  for (const line of lines) {
    const [name, ready] = line.split(",");
    if (name === excludeNode) continue;
    totalNodes++;
    if (ready === "True") readyNodes++;
  }

  return {
    healthy: readyNodes === totalNodes && totalNodes > 0,
    readyNodes,
    totalNodes,
  };
}

// Cordon the node (mark as unschedulable)
async function cordonNode(node: string): Promise<boolean> {
  console.log(`  Cordoning node ${node}...`);
  if (dryRun) {
    console.log(`  [DRY-RUN] Would run: kubectl cordon ${node}`);
    return true;
  }

  const result = await kubectl(["cordon", node]);
  if (!result.success) {
    console.error(`  Failed to cordon node: ${result.stderr}`);
    return false;
  }
  console.log(`  Node cordoned successfully`);
  return true;
}

// Drain the node (evict pods)
async function drainNode(node: string): Promise<boolean> {
  console.log(`  Draining node ${node}...`);
  if (dryRun) {
    console.log(`  [DRY-RUN] Would run: kubectl drain ${node} --ignore-daemonsets --delete-emptydir-data --force --timeout=300s`);
    return true;
  }

  const result = await kubectl([
    "drain", node,
    "--ignore-daemonsets",
    "--delete-emptydir-data",
    "--force",
    "--timeout=300s",
  ]);

  if (!result.success) {
    console.error(`  Failed to drain node: ${result.stderr}`);
    return false;
  }
  console.log(`  Node drained successfully`);
  return true;
}

// Get the terraform resource address for the node
function getResourceAddress(node: string): string {
  if (node.startsWith("controlplane")) {
    return `proxmox_virtual_environment_vm.controlplane["${node}"]`;
  }
  return `proxmox_virtual_environment_vm.worker["${node}"]`;
}

// Taint the node in terraform state
async function taintNode(node: string): Promise<boolean> {
  const resourceAddress = getResourceAddress(node);
  console.log(`  Tainting terraform resource: ${resourceAddress}`);

  if (dryRun) {
    console.log(`  [DRY-RUN] Would run: terragrunt taint '${resourceAddress}' in ${TERRAGRUNT_DIR}`);
    return true;
  }

  // Use op run to inject secrets, and specify the directory
  const result = await run("op", [
    "run", "--env-file=.env.op", "--",
    "sh", "-c", `cd ${TERRAGRUNT_DIR} && terragrunt taint '${resourceAddress}'`,
  ]);

  if (!result.success) {
    console.error(`  Failed to taint resource: ${result.stderr}`);
    return false;
  }
  console.log(`  Resource tainted successfully`);
  return true;
}

// Apply terragrunt to recreate the node
async function applyTerragrunt(): Promise<boolean> {
  console.log(`  Applying terragrunt to recreate node...`);

  if (dryRun) {
    console.log(`  [DRY-RUN] Would run: terragrunt apply --terragrunt-non-interactive --auto-approve in ${TERRAGRUNT_DIR}`);
    return true;
  }

  const result = await run("op", [
    "run", "--env-file=.env.op", "--",
    "sh", "-c", `cd ${TERRAGRUNT_DIR} && terragrunt apply --terragrunt-non-interactive --auto-approve`,
  ]);

  if (!result.success) {
    console.error(`  Terragrunt apply failed: ${result.stderr}`);
    console.error(`  stdout: ${result.stdout}`);
    return false;
  }
  console.log(`  Terragrunt apply completed successfully`);
  return true;
}

// Wait for node to become Ready
async function waitForNodeReady(node: string, timeoutSeconds = 600): Promise<boolean> {
  console.log(`  Waiting for node ${node} to become Ready (timeout: ${timeoutSeconds}s)...`);

  if (dryRun) {
    console.log(`  [DRY-RUN] Would wait for node to become Ready`);
    return true;
  }

  const startTime = Date.now();
  while ((Date.now() - startTime) / 1000 < timeoutSeconds) {
    const status = await getNodeStatus(node);
    if (status.exists && status.ready) {
      console.log(`  Node ${node} is Ready!`);
      return true;
    }

    // Show progress
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const statusStr = status.exists ? (status.ready ? "Ready" : "NotReady") : "NotFound";
    process.stdout.write(`\r  Waiting... (${elapsed}s elapsed, node status: ${statusStr})    `);

    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  console.log(`\n  Timeout waiting for node ${node} to become Ready`);
  return false;
}

// Uncordon the node (make schedulable again)
async function uncordonNode(node: string): Promise<boolean> {
  console.log(`  Uncordoning node ${node}...`);
  if (dryRun) {
    console.log(`  [DRY-RUN] Would run: kubectl uncordon ${node}`);
    return true;
  }

  const result = await kubectl(["uncordon", node]);
  if (!result.success) {
    console.error(`  Failed to uncordon node: ${result.stderr}`);
    return false;
  }
  console.log(`  Node uncordoned successfully`);
  return true;
}

// Main execution
async function main(): Promise<void> {
  console.log(`
${"=".repeat(60)}
  Talos Node Recreation
${"=".repeat(60)}
  Node: ${nodeName}
  Skip Drain: ${skipDrain}
  Dry Run: ${dryRun}
${"=".repeat(60)}
`);

  // Step 1: Pre-flight checks
  console.log("\n[1/7] Pre-flight checks...");

  const nodeStatus = await getNodeStatus(nodeName);
  console.log(`  Node ${nodeName}: exists=${nodeStatus.exists}, ready=${nodeStatus.ready}`);

  const clusterHealth = await checkClusterHealth(nodeName);
  console.log(`  Other nodes: ${clusterHealth.readyNodes}/${clusterHealth.totalNodes} ready`);

  if (!clusterHealth.healthy) {
    console.error(`  WARNING: Not all other nodes are Ready. Proceeding may be risky.`);
    if (!dryRun) {
      const proceed = confirm("Do you want to proceed anyway?");
      if (!proceed) {
        console.log("Aborted by user.");
        Deno.exit(1);
      }
    }
  }

  // Step 2: Cordon the node
  console.log("\n[2/7] Cordoning node...");
  if (nodeStatus.exists && nodeStatus.schedulable) {
    const cordoned = await cordonNode(nodeName);
    if (!cordoned && !dryRun) {
      console.error("Failed to cordon node. Aborting.");
      Deno.exit(1);
    }
  } else if (nodeStatus.exists) {
    console.log(`  Node is already cordoned or unschedulable`);
  } else {
    console.log(`  Node doesn't exist yet, skipping cordon`);
  }

  // Step 3: Drain the node
  console.log("\n[3/7] Draining node...");
  if (skipDrain) {
    console.log(`  Skipping drain as requested`);
  } else if (nodeStatus.exists) {
    const drained = await drainNode(nodeName);
    if (!drained && !dryRun) {
      console.error("Failed to drain node. Use --skip-drain if the node is already down.");
      Deno.exit(1);
    }
  } else {
    console.log(`  Node doesn't exist, skipping drain`);
  }

  // Step 4: Taint terraform resource
  console.log("\n[4/7] Tainting terraform resource...");
  const tainted = await taintNode(nodeName);
  if (!tainted && !dryRun) {
    console.error("Failed to taint terraform resource. Aborting.");
    Deno.exit(1);
  }

  // Step 5: Apply terragrunt
  console.log("\n[5/7] Applying terragrunt...");
  const applied = await applyTerragrunt();
  if (!applied && !dryRun) {
    console.error("Terragrunt apply failed. Check logs for details.");
    Deno.exit(1);
  }

  // Step 6: Wait for node to become Ready
  console.log("\n[6/7] Waiting for node to rejoin cluster...");
  const ready = await waitForNodeReady(nodeName);
  if (!ready && !dryRun) {
    console.error("Node did not become Ready within timeout.");
    console.error("Check Proxmox console and talosctl for node status.");
    Deno.exit(1);
  }

  // Step 7: Uncordon the node
  console.log("\n[7/7] Uncordoning node...");
  const uncordoned = await uncordonNode(nodeName);
  if (!uncordoned && !dryRun) {
    console.error("Failed to uncordon node. Run manually: kubectl uncordon " + nodeName);
  }

  console.log(`
${"=".repeat(60)}
  Node Recreation Complete!
${"=".repeat(60)}

Next steps:
  1. Verify node health: kubectl get node ${nodeName}
  2. Check pods are scheduling: kubectl get pods -A -o wide | grep ${nodeName}
  3. For GPU nodes, run: deno run --allow-net --allow-run --allow-env scripts/verify-gpu-support.ts
`);
}

// Run
await main();
