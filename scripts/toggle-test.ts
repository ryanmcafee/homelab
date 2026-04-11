#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read --allow-write

/**
 * toggle-test.ts
 *
 * GPU vendor abstraction toggle test harness.
 *
 * Renders charts/addons + charts/applications three times (GPU_VENDOR=none|nvidia|intel)
 * and asserts each rendered output matches its expected shape (TGL-01..TGL-04).
 *
 * - GPU_VENDOR=none   → no GPU operator Applications, no Plex GPU block
 * - GPU_VENDOR=nvidia → byte-identical to tests/fixtures/toggle-baseline/nvidia/
 * - GPU_VENDOR=intel  → intel-gpu-device-plugin Application present, Plex requests
 *                       gpu.intel.com/xe, /dev/dri mounted, no runtimeClassName
 *
 * All three renders are validated against `helm lint` and `kubeconform -strict`.
 *
 * Usage:
 *   task gpu:toggle-test                       # full run
 *   deno run ... scripts/toggle-test.ts --help
 *   deno run ... scripts/toggle-test.ts --dry-run
 *   deno run ... scripts/toggle-test.ts --vendor=intel
 *   deno run ... scripts/toggle-test.ts --keep-artifacts
 *
 * Exit codes: 0 = all assertions pass; 1 = any failure.
 */

// ============================================================================
// Logging
// ============================================================================
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.log(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.log(`${green("OK")}    ${msg}`),
  warn: (msg: string) => console.log(`${yellow("WARN")}  ${msg}`),
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
};

// ============================================================================
// Constants
// ============================================================================
type Vendor = "none" | "nvidia" | "intel";
const ALL_VENDORS: Vendor[] = ["none", "nvidia", "intel"];
const ARTIFACT_ROOT = "/tmp/gpu-toggle-test";
const BASELINE_ROOT = "tests/fixtures/toggle-baseline";
const HOMELAB_BIN = "./bin/homelab";
const ADDONS_CHART = "charts/addons";
const APPS_CHART = "charts/applications";

// ============================================================================
// CLI args
// ============================================================================
interface Args {
  help: boolean;
  dryRun: boolean;
  keepArtifacts: boolean;
  vendor: Vendor | null;
  regenBaseline: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    dryRun: false,
    keepArtifacts: false,
    vendor: null,
    regenBaseline: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--keep-artifacts") args.keepArtifacts = true;
    else if (a === "--regen-baseline") args.regenBaseline = true;
    else if (a.startsWith("--vendor=")) {
      const v = a.slice("--vendor=".length);
      if (v !== "none" && v !== "nvidia" && v !== "intel") {
        log.error(`Invalid --vendor value: ${v} (must be none|nvidia|intel)`);
        Deno.exit(2);
      }
      args.vendor = v as Vendor;
    } else {
      log.error(`Unknown argument: ${a}`);
      Deno.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`toggle-test.ts — GPU vendor abstraction toggle test harness

Usage:
  task gpu:toggle-test
  deno run --allow-net --allow-run --allow-env --allow-read --allow-write \\
    scripts/toggle-test.ts [flags]

Flags:
  --help, -h         Show this help and exit 0
  --dry-run          Print the planned vendor matrix and exit 0 (no rendering)
  --vendor=<v>       Run only one vendor (none|nvidia|intel); default: all three
  --keep-artifacts   Do not delete /tmp/gpu-toggle-test/ on exit
  --regen-baseline   Regenerate tests/fixtures/toggle-baseline/nvidia/ from current code

Constants (compile-time):
  ARTIFACT_ROOT  = ${ARTIFACT_ROOT}
  BASELINE_ROOT  = ${BASELINE_ROOT}
  HOMELAB_BIN    = ${HOMELAB_BIN}
  ADDONS_CHART   = ${ADDONS_CHART}
  APPS_CHART     = ${APPS_CHART}

Exit codes:
  0  All assertions pass
  1  Any vendor failed (render, lint, kubeconform, or assertion)
  2  Argument error
`);
}

// ============================================================================
// Shell helpers
// ============================================================================
async function run(
  cmd: string[],
  opts: { stdin?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    stdin: opts.stdin !== undefined ? "piped" : "null",
  });
  const child = p.spawn();
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }
  const output = await child.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

// ============================================================================
// Stub: Plan 02 will implement these
// ============================================================================
interface VendorResult {
  vendor: Vendor;
  renderOk: boolean;
  lintOk: boolean;
  kubeconformOk: boolean;
  assertionsOk: boolean;
  errors: string[];
}

async function renderVendor(
  vendor: Vendor,
  _outDir: string,
): Promise<VendorResult> {
  // PLAN 02 IMPLEMENTATION GOES HERE
  // For Plan 01, this is a stub that returns an "unimplemented" result.
  // The Deno.Command shell helper above will be used by Plan 02 to:
  //   1. Write a temp env file to /tmp based on homelab.yaml.example + GPU_VENDOR=<vendor>
  //   2. Invoke: ${HOMELAB_BIN} config export --env-file <tmp> --format helm-addons --stdout
  //   3. Pipe stage-A output into `helm template addons charts/addons -f -`
  //   4. Repeat for helm-apps → charts/applications
  //   5. Write both stage-B outputs into _outDir
  //   6. Run `helm lint` and `kubeconform -strict` against each
  //   7. Run vendor-specific assertions (nvidia: byte-diff vs BASELINE_ROOT/nvidia/*.yaml,
  //      intel/none: grep-based shape checks)
  return await Promise.resolve({
    vendor,
    renderOk: false,
    lintOk: false,
    kubeconformOk: false,
    assertionsOk: false,
    errors: ["renderVendor not yet implemented (Plan 01 skeleton)"],
  });
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<number> {
  const args = parseArgs(Deno.args);

  if (args.help) {
    printHelp();
    return 0;
  }

  const targetVendors: Vendor[] = args.vendor ? [args.vendor] : ALL_VENDORS;

  log.info(`Toggle test harness — vendors: ${targetVendors.join(", ")}`);
  log.info(`Artifact root: ${ARTIFACT_ROOT}`);
  log.info(`Baseline root: ${BASELINE_ROOT}`);

  if (args.dryRun) {
    log.info("Dry-run mode — listing planned operations and exiting.");
    for (const v of targetVendors) {
      console.log(
        `  - render ${v} → ${ARTIFACT_ROOT}/${v}/{addons,applications}.yaml`,
      );
      console.log(`  - helm lint ${v}`);
      console.log(`  - kubeconform ${v}`);
      console.log(`  - assert ${v}`);
    }
    return 0;
  }

  if (args.regenBaseline) {
    log.warn(
      "Baseline regeneration not yet implemented (Plan 01 skeleton).",
    );
    log.warn(
      "For now, regenerate manually per tests/fixtures/toggle-baseline/README.md.",
    );
    return 0;
  }

  // Plan 02 wires the real loop here. Plan 01 just exits successfully so the
  // skeleton is invocable end-to-end.
  log.warn("Render/assert logic not yet implemented (Plan 01 skeleton).");
  log.warn("Run Plan 02 to enable the full toggle test.");

  // Demonstrate the stub is reachable without doing any real work.
  for (const v of targetVendors) {
    const result = await renderVendor(v, `${ARTIFACT_ROOT}/${v}`);
    log.warn(`  ${result.vendor}: ${result.errors.join("; ")}`);
  }

  // Best-effort cleanup so --keep-artifacts behaves correctly even from skeleton
  if (!args.keepArtifacts) {
    try {
      await Deno.remove(ARTIFACT_ROOT, { recursive: true });
    } catch {
      // ignore — may not exist
    }
  }

  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
