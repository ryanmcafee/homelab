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
// ARTIFACT_ROOT is assigned at runtime from Deno.makeTempDir() to avoid
// predictable paths in /tmp (symlink-swap exposure). See initArtifactRoot().
let ARTIFACT_ROOT = "";
const BASELINE_ROOT = "tests/fixtures/toggle-baseline";
const HOMELAB_BIN = "./bin/homelab";
const ADDONS_CHART = "charts/addons";
const APPS_CHART = "charts/applications";
// KUBERNETES_VERSION is the schema version kubeconform validates against.
// Source of truth: the Talos cluster version currently deployed. Keep in sync
// with the Talos release used in terragrunt/modules/talos-cluster/. If the
// cluster is upgraded, bump this constant so the schema check reflects reality.
const KUBERNETES_VERSION = "1.30.0";

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
// Vendor result type
// ============================================================================
interface VendorResult {
  vendor: Vendor;
  renderOk: boolean;
  lintOk: boolean;
  kubeconformOk: boolean;
  assertionsOk: boolean;
  errors: string[];
}

// ============================================================================
// Filesystem helpers
// ============================================================================
async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

async function writeFile(path: string, content: string): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx >= 0) {
    // idx === 0 handles root-adjacent paths like "/rootfile.yaml";
    // idx > 0 handles nested paths like "out/dir/file.yaml".
    const dir = path.substring(0, idx) || "/";
    await ensureDir(dir);
  }
  await Deno.writeTextFile(path, content);
}

// ============================================================================
// Build the homelab CLI binary if missing
// ============================================================================
async function ensureHomelabBinary(): Promise<void> {
  try {
    const stat = await Deno.stat(HOMELAB_BIN);
    if (stat.isFile) return;
  } catch (err) {
    // Only treat "missing file" as build-required. Rethrow permission or
    // I/O errors so we fail loudly instead of silently shelling out to go build.
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  log.info(`Building ${HOMELAB_BIN} ...`);
  const r = await run(["go", "build", "-o", HOMELAB_BIN, "./cmd/homelab"]);
  if (r.code !== 0) {
    throw new Error(`go build failed:\n${r.stderr}`);
  }
}

// ============================================================================
// Generate a temp env file with GPU_VENDOR overridden
// ============================================================================
async function writeVendorEnvFile(
  vendor: Vendor,
  outDir: string,
): Promise<string> {
  // Use homelab.yaml.example as the base (it has all the keys defaults.yaml
  // leaves unset, e.g. TRUENAS_IP, NFS_SHARE_ALLOW), then override GPU_VENDOR.
  const examplePath = "configuration/environments/homelab.yaml.example";
  const base = await Deno.readTextFile(examplePath);
  // Replace the GPU_VENDOR line with the target vendor.
  const overridden = base.replace(
    /^GPU_VENDOR:.*$/m,
    `GPU_VENDOR: "${vendor}"`,
  );
  // Defensive: if homelab.yaml.example didn't have a GPU_VENDOR line, append one.
  const final = /^GPU_VENDOR:/m.test(overridden)
    ? overridden
    : `${overridden}\nGPU_VENDOR: "${vendor}"\n`;
  const envPath = `${outDir}/env.yaml`;
  await writeFile(envPath, final);
  return envPath;
}

// ============================================================================
// Render: homelab config export → helm template
// ============================================================================
async function renderChart(
  envFile: string,
  format: "helm-addons" | "helm-apps",
  chartPath: string,
  releaseName: string,
  outYamlPath: string,
  outValuesPath: string,
): Promise<void> {
  // STAGE A: produce the values yaml via the homelab CLI
  const valuesResult = await run([
    HOMELAB_BIN,
    "config",
    "export",
    "--env-file",
    envFile,
    "--format",
    format,
    "--stdout",
  ]);
  if (valuesResult.code !== 0) {
    throw new Error(
      `homelab config export ${format} failed (${envFile}):\n${valuesResult.stderr}`,
    );
  }
  await writeFile(outValuesPath, valuesResult.stdout);

  // STAGE B: helm template using the captured values file
  const templateResult = await run([
    "helm",
    "template",
    releaseName,
    chartPath,
    "-f",
    outValuesPath,
  ]);
  if (templateResult.code !== 0) {
    throw new Error(
      `helm template ${chartPath} failed:\n${templateResult.stderr}`,
    );
  }
  await writeFile(outYamlPath, templateResult.stdout);
}

// ============================================================================
// helm lint per vendor (uses generated values file)
// ============================================================================
async function lintVendor(
  vendor: Vendor,
  outDir: string,
): Promise<{ ok: boolean; err?: string }> {
  const addonsValues = `${outDir}/addons-values.yaml`;
  const appsValues = `${outDir}/apps-values.yaml`;

  const a = await run(["helm", "lint", ADDONS_CHART, "-f", addonsValues]);
  if (a.code !== 0) {
    return {
      ok: false,
      err:
        `helm lint ${ADDONS_CHART} failed for ${vendor}:\n${a.stdout}\n${a.stderr}`,
    };
  }
  const b = await run(["helm", "lint", APPS_CHART, "-f", appsValues]);
  if (b.code !== 0) {
    return {
      ok: false,
      err:
        `helm lint ${APPS_CHART} failed for ${vendor}:\n${b.stdout}\n${b.stderr}`,
    };
  }
  return { ok: true };
}

// ============================================================================
// kubeconform per vendor (validates rendered manifests)
// ============================================================================
async function kubeconformVendor(
  vendor: Vendor,
  outDir: string,
): Promise<{ ok: boolean; err?: string }> {
  const addonsRendered = `${outDir}/addons.yaml`;
  const appsRendered = `${outDir}/applications.yaml`;
  const args = [
    "-strict",
    "-summary",
    "-ignore-missing-schemas",
    "-kubernetes-version",
    KUBERNETES_VERSION,
  ];
  const a = await run(["kubeconform", ...args, addonsRendered]);
  if (a.code !== 0) {
    return {
      ok: false,
      err:
        `kubeconform addons failed for ${vendor}:\n${a.stdout}\n${a.stderr}`,
    };
  }
  const b = await run(["kubeconform", ...args, appsRendered]);
  if (b.code !== 0) {
    return {
      ok: false,
      err:
        `kubeconform applications failed for ${vendor}:\n${b.stdout}\n${b.stderr}`,
    };
  }
  return { ok: true };
}

// ============================================================================
// renderVendor: full render + lint + kubeconform pipeline for a single vendor
// ============================================================================
async function renderVendor(
  vendor: Vendor,
  outDir: string,
): Promise<VendorResult> {
  const result: VendorResult = {
    vendor,
    renderOk: false,
    lintOk: false,
    kubeconformOk: false,
    assertionsOk: false,
    errors: [],
  };

  try {
    await ensureDir(outDir);
    const envFile = await writeVendorEnvFile(vendor, outDir);

    await renderChart(
      envFile,
      "helm-addons",
      ADDONS_CHART,
      "addons",
      `${outDir}/addons.yaml`,
      `${outDir}/addons-values.yaml`,
    );
    await renderChart(
      envFile,
      "helm-apps",
      APPS_CHART,
      "applications",
      `${outDir}/applications.yaml`,
      `${outDir}/apps-values.yaml`,
    );
    result.renderOk = true;
  } catch (err) {
    result.errors.push(
      `render: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const lintR = await lintVendor(vendor, outDir);
  result.lintOk = lintR.ok;
  if (!lintR.ok && lintR.err) result.errors.push(lintR.err);

  const kcR = await kubeconformVendor(vendor, outDir);
  result.kubeconformOk = kcR.ok;
  if (!kcR.ok && kcR.err) result.errors.push(kcR.err);

  return result;
}

// ============================================================================
// Assertion helpers
// ============================================================================
interface AssertionFailure {
  rule: string;
  detail: string;
}

function mustNotContain(
  label: string,
  haystack: string,
  needle: string,
  failures: AssertionFailure[],
): void {
  if (haystack.includes(needle)) {
    failures.push({
      rule: `${label} MUST NOT contain "${needle}"`,
      detail: `found at byte offset ${haystack.indexOf(needle)}`,
    });
  }
}

function mustContain(
  label: string,
  haystack: string,
  needle: string,
  failures: AssertionFailure[],
): void {
  if (!haystack.includes(needle)) {
    failures.push({
      rule: `${label} MUST contain "${needle}"`,
      detail: `not found`,
    });
  }
}

function assertNone(addonsYaml: string, appsYaml: string): AssertionFailure[] {
  const f: AssertionFailure[] = [];
  // No GPU operator Applications
  mustNotContain("addons[none]", addonsYaml, "name: nvidia-gpu-operator", f);
  mustNotContain(
    "addons[none]",
    addonsYaml,
    "name: intel-gpu-device-plugin",
    f,
  );
  // No Plex GPU bits
  mustNotContain("apps[none]", appsYaml, "runtimeClassName: nvidia", f);
  mustNotContain("apps[none]", appsYaml, "nvidia.com/gpu", f);
  mustNotContain("apps[none]", appsYaml, "gpu.intel.com/xe", f);
  mustNotContain("apps[none]", appsYaml, "mountPath: /dev/dri", f);
  mustNotContain("apps[none]", appsYaml, "path: /dev/dri", f);
  return f;
}

async function assertNvidia(
  addonsYaml: string,
  appsYaml: string,
  outDir: string,
): Promise<AssertionFailure[]> {
  const f: AssertionFailure[] = [];
  const baselineAddons = await Deno.readTextFile(
    `${BASELINE_ROOT}/nvidia/addons.yaml`,
  );
  const baselineApps = await Deno.readTextFile(
    `${BASELINE_ROOT}/nvidia/applications.yaml`,
  );

  if (addonsYaml !== baselineAddons) {
    f.push({
      rule: "addons[nvidia] MUST be byte-identical to baseline",
      detail: await unifiedDiff(
        `${BASELINE_ROOT}/nvidia/addons.yaml`,
        `${outDir}/addons.yaml`,
      ),
    });
  }
  if (appsYaml !== baselineApps) {
    f.push({
      rule: "apps[nvidia] MUST be byte-identical to baseline",
      detail: await unifiedDiff(
        `${BASELINE_ROOT}/nvidia/applications.yaml`,
        `${outDir}/applications.yaml`,
      ),
    });
  }
  return f;
}

function assertIntel(addonsYaml: string, appsYaml: string): AssertionFailure[] {
  const f: AssertionFailure[] = [];
  // Intel GPU operator Application present
  mustContain("addons[intel]", addonsYaml, "name: intel-gpu-device-plugin", f);
  mustContain("addons[intel]", addonsYaml, "kind: Application", f);
  // NVIDIA operator Application absent
  mustNotContain("addons[intel]", addonsYaml, "name: nvidia-gpu-operator", f);
  // Plex Intel bits
  mustContain("apps[intel]", appsYaml, "gpu.intel.com/xe", f);
  mustContain("apps[intel]", appsYaml, "path: /dev/dri", f);
  mustContain("apps[intel]", appsYaml, "mountPath: /dev/dri", f);
  // Plex must NOT have NVIDIA bits
  mustNotContain("apps[intel]", appsYaml, "runtimeClassName: nvidia", f);
  mustNotContain("apps[intel]", appsYaml, "nvidia.com/gpu", f);
  return f;
}

async function unifiedDiff(
  expectedPath: string,
  actualPath: string,
): Promise<string> {
  const r = await run(["diff", "-u", expectedPath, actualPath]);
  // diff exits 1 when files differ — that's the expected case here
  return r.stdout || r.stderr || "(no diff output)";
}

async function runAssertions(
  vendor: Vendor,
  outDir: string,
): Promise<AssertionFailure[]> {
  const addonsYaml = await Deno.readTextFile(`${outDir}/addons.yaml`);
  const appsYaml = await Deno.readTextFile(`${outDir}/applications.yaml`);
  switch (vendor) {
    case "none":
      return assertNone(addonsYaml, appsYaml);
    case "nvidia":
      return await assertNvidia(addonsYaml, appsYaml, outDir);
    case "intel":
      return assertIntel(addonsYaml, appsYaml);
  }
}

// ============================================================================
// Results table
// ============================================================================
function printResultsTable(results: VendorResult[]): void {
  console.log("");
  console.log("Toggle Test Results");
  console.log("====================");
  console.log("Vendor   Render  Lint    Kubeconform  Assertions");
  console.log("------   ------  ----    -----------  ----------");
  for (const r of results) {
    const cell = (ok: boolean) => (ok ? green("PASS") : red("FAIL"));
    const pad = (s: string, n: number) =>
      s + " ".repeat(Math.max(0, n - stripAnsi(s).length));
    console.log(
      `${pad(r.vendor, 9)}${pad(cell(r.renderOk), 8)}${pad(cell(r.lintOk), 8)}${
        pad(cell(r.kubeconformOk), 13)
      }${cell(r.assertionsOk)}`,
    );
  }
  console.log("");
  for (const r of results) {
    if (r.errors.length === 0) continue;
    console.log(red(`--- ${r.vendor} errors ---`));
    for (const e of r.errors) console.log(e);
    console.log("");
  }
}

// Strip ANSI color codes for padding calculation (ensures aligned columns)
function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ============================================================================
// Regen baseline
// ============================================================================
async function regenBaseline(): Promise<number> {
  log.info(
    "Regenerating tests/fixtures/toggle-baseline/nvidia/ from current code",
  );
  await ensureHomelabBinary();
  const tmpDir = `${ARTIFACT_ROOT}/regen-nvidia`;
  await ensureDir(tmpDir);
  const r = await renderVendor("nvidia", tmpDir);
  // Gate baseline overwrites on ALL pre-flight checks (render + lint + kubeconform).
  // Without this, a broken render (schema regression, CRD typo, sync-wave mistake)
  // would silently become the new baseline and compare broken-vs-broken on the next
  // toggle-test run, masking the regression indefinitely.
  if (!r.renderOk || !r.lintOk || !r.kubeconformOk) {
    log.error("Regen pre-flight failed; refusing to overwrite baseline:");
    for (const e of r.errors) console.error(e);
    return 1;
  }
  await Deno.copyFile(
    `${tmpDir}/addons.yaml`,
    `${BASELINE_ROOT}/nvidia/addons.yaml`,
  );
  await Deno.copyFile(
    `${tmpDir}/applications.yaml`,
    `${BASELINE_ROOT}/nvidia/applications.yaml`,
  );
  log.ok(`Baseline regenerated at ${BASELINE_ROOT}/nvidia/`);
  log.warn(
    "Review the diff with `git diff tests/fixtures/toggle-baseline/` before committing.",
  );
  return 0;
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

  if (args.regenBaseline) {
    return await regenBaseline();
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

  await ensureHomelabBinary();

  // Clean previous artifacts
  try {
    await Deno.remove(ARTIFACT_ROOT, { recursive: true });
  } catch {
    // ignore
  }
  await ensureDir(ARTIFACT_ROOT);

  // Render all three vendors in parallel
  const renderResults = await Promise.all(
    targetVendors.map((v) => renderVendor(v, `${ARTIFACT_ROOT}/${v}`)),
  );

  // Run assertions per vendor (sequential — they read files but are cheap)
  for (const r of renderResults) {
    if (!r.renderOk) {
      r.assertionsOk = false;
      continue;
    }
    const failures = await runAssertions(
      r.vendor,
      `${ARTIFACT_ROOT}/${r.vendor}`,
    );
    r.assertionsOk = failures.length === 0;
    if (failures.length > 0) {
      for (const f of failures) {
        r.errors.push(`assertion: ${f.rule}\n${f.detail}`);
      }
    }
  }

  printResultsTable(renderResults);

  const allOk = renderResults.every(
    (r) => r.renderOk && r.lintOk && r.kubeconformOk && r.assertionsOk,
  );

  if (!args.keepArtifacts) {
    try {
      await Deno.remove(ARTIFACT_ROOT, { recursive: true });
    } catch {
      // ignore
    }
  } else {
    log.info(`Artifacts retained at ${ARTIFACT_ROOT}`);
  }

  if (allOk) {
    log.ok("All toggle states pass (TGL-01..TGL-04)");
    return 0;
  }
  log.error("One or more toggle states failed — see table above");
  return 1;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
