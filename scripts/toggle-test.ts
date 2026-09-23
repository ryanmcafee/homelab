#!/usr/bin/env bun

/**
 * toggle-test.ts
 *
 * GPU vendor abstraction toggle test harness.
 *
 * Renders charts/addons + charts/applications three times (GPU_VENDOR=none|nvidia|intel)
 * and asserts each rendered output matches its expected shape (TGL-01..TGL-04).
 *
 * - GPU_VENDOR=none   → no GPU operator Applications, no Plex GPU block
 * - GPU_VENDOR=nvidia → byte-identical to the golden snapshots at
 *                       tests/snapshots/homelab/{addons,applications}.yaml
 *                       (homelab.yaml.example, which this snapshot was
 *                       rendered from, sets GPU_VENDOR: nvidia). A mismatch
 *                       means either a real regression or that the snapshots
 *                       are stale — run `task test:snapshot -- --update` and
 *                       review the diff before trusting either explanation.
 * - GPU_VENDOR=intel  → intel-gpu-device-plugin Application present, Plex has
 *                       /dev/dri mounted, no runtimeClassName. Plex does NOT
 *                       yet request the gpu.intel.com/xe resource — that
 *                       limit is intentionally omitted (see
 *                       configuration/templates/helm-apps.tmpl) until the
 *                       device plugin advertises it in node allocatable.
 *
 * All three renders are validated against `helm lint` and `kubeconform -strict`.
 *
 * Usage:
 *   task gpu:toggle-test                       # full run
 *   bun scripts/toggle-test.ts --help
 *   bun scripts/toggle-test.ts --dry-run
 *   bun scripts/toggle-test.ts --vendor=intel
 *   bun scripts/toggle-test.ts --keep-artifacts
 *
 * Exit codes: 0 = all assertions pass; 1 = any failure.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNotFound } from "./lib/errors.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

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
// ARTIFACT_ROOT is assigned at runtime from mkdtemp() to avoid
// predictable paths in /tmp (symlink-swap exposure). See initArtifactRoot().
let ARTIFACT_ROOT = "";
// SNAPSHOT_DIR holds the golden, byte-exact renders produced by
// `task test:snapshot -- --update` (see internal/verify/snapshot.go). The
// nvidia toggle state is asserted against SNAPSHOT_DIR/{addons,applications}.yaml
// instead of a separate fixture, so there is exactly one source of truth for
// "what does a homelab render look like" — this test's own render must match
// internal/verify/render.go's invocation exactly (release name, --include-crds,
// -f order) for that comparison to be meaningful. See renderChart() below.
const SNAPSHOT_DIR = "tests/snapshots/homelab";
const HOMELAB_BIN = "./bin/homelab";
const ADDONS_CHART = "charts/addons";
const APPS_CHART = "charts/applications";
// KUBERNETES_VERSION is the schema version kubeconform validates against.
// Source of truth: configuration/versions.yaml's tools.kubernetes (the single
// centralized version registry — see readKubernetesVersion() below). Loaded at
// runtime so this test never drifts from the version the rest of the project
// already tracks; bumping tools.kubernetes there is sufficient to keep this
// check in sync.
let KUBERNETES_VERSION = "";

// VERSIONS_YAML_PATH is the centralized version registry read by
// readKubernetesVersion().
const VERSIONS_YAML_PATH = "configuration/versions.yaml";

// ============================================================================
// Version registry
// ============================================================================
// Reads tools.kubernetes from configuration/versions.yaml and strips any
// leading "v" (the registry stores tags like "v1.36.1"; kubeconform's
// -kubernetes-version flag expects a bare "1.36.1").
async function readKubernetesVersion(): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(VERSIONS_YAML_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read ${VERSIONS_YAML_PATH} to determine kubeconform's -kubernetes-version: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const parsed = parseYaml(raw) as { tools?: { kubernetes?: string } } | null;
  const version = parsed?.tools?.kubernetes;
  if (!version) {
    throw new Error(
      `${VERSIONS_YAML_PATH} is missing tools.kubernetes — cannot determine kubeconform's -kubernetes-version`,
    );
  }
  return version.replace(/^v/, "");
}

// ============================================================================
// CLI args
// ============================================================================
interface Args {
  help: boolean;
  dryRun: boolean;
  keepArtifacts: boolean;
  vendor: Vendor | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    dryRun: false,
    keepArtifacts: false,
    vendor: null,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--keep-artifacts") args.keepArtifacts = true;
    else if (a.startsWith("--vendor=")) {
      const v = a.slice("--vendor=".length);
      if (v !== "none" && v !== "nvidia" && v !== "intel") {
        log.error(`Invalid --vendor value: ${v} (must be none|nvidia|intel)`);
        process.exit(2);
      }
      args.vendor = v as Vendor;
    } else {
      log.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`toggle-test.ts — GPU vendor abstraction toggle test harness

Usage:
  task gpu:toggle-test
  bun scripts/toggle-test.ts [flags]

Flags:
  --help, -h         Show this help and exit 0
  --dry-run          Print the planned vendor matrix and exit 0 (no rendering)
  --vendor=<v>       Run only one vendor (none|nvidia|intel); default: all three
  --keep-artifacts   Do not delete the artifact temp dir on exit

  On a GPU_VENDOR=nvidia mismatch against the golden snapshots, run
  \`task test:snapshot -- --update\` and review the diff — see
  tests/snapshots/README.md.

Constants:
  ARTIFACT_ROOT  = <allocated at runtime via mkdtemp>
  SNAPSHOT_DIR   = ${SNAPSHOT_DIR}
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
  const p = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, code };
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
  await mkdir(path, { recursive: true });
}

async function writeFile(path: string, content: string): Promise<void> {
  const idx = path.lastIndexOf("/");
  if (idx >= 0) {
    // idx === 0 handles root-adjacent paths like "/rootfile.yaml";
    // idx > 0 handles nested paths like "out/dir/file.yaml".
    const dir = path.substring(0, idx) || "/";
    await ensureDir(dir);
  }
  await fsWriteFile(path, content);
}

// ============================================================================
// Build the homelab CLI binary if missing
// ============================================================================
async function ensureHomelabBinary(): Promise<void> {
  try {
    const stat = await fsStat(HOMELAB_BIN);
    if (stat.isFile()) return;
  } catch (err) {
    // Only treat "missing file" as build-required. Rethrow permission or
    // I/O errors so we fail loudly instead of silently shelling out to go build.
    if (!isNotFound(err)) throw err;
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
  const base = await readFile(examplePath, "utf8");
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

  // STAGE B: helm template using the captured values file. Flags and -f
  // order deliberately mirror internal/verify/render.go's renderChart()
  // exactly (release name = chart dir name, --include-crds, base
  // values.yaml before the config-export-generated file) — the nvidia
  // toggle state is asserted byte-for-byte against the golden snapshots
  // that render produces, so any divergence here would either produce
  // false failures or mask real ones.
  const templateResult = await run([
    "helm",
    "template",
    releaseName,
    chartPath,
    "--include-crds",
    "-f",
    `${chartPath}/values.yaml`,
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

  // Same -f set as renderChart()/render.go's lintChart(): base values.yaml
  // plus the config-export-generated file, in that order.
  const a = await run([
    "helm",
    "lint",
    ADDONS_CHART,
    "-f",
    `${ADDONS_CHART}/values.yaml`,
    "-f",
    addonsValues,
  ]);
  if (a.code !== 0) {
    return {
      ok: false,
      err: `helm lint ${ADDONS_CHART} failed for ${vendor}:\n${a.stdout}\n${a.stderr}`,
    };
  }
  const b = await run([
    "helm",
    "lint",
    APPS_CHART,
    "-f",
    `${APPS_CHART}/values.yaml`,
    "-f",
    appsValues,
  ]);
  if (b.code !== 0) {
    return {
      ok: false,
      err: `helm lint ${APPS_CHART} failed for ${vendor}:\n${b.stdout}\n${b.stderr}`,
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
    "-schema-location",
    "default",
    "-schema-location",
    "tests/schemas/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json",
    "-kubernetes-version",
    KUBERNETES_VERSION,
  ];
  const a = await run(["kubeconform", ...args, addonsRendered]);
  if (a.code !== 0) {
    return {
      ok: false,
      err: `kubeconform addons failed for ${vendor}:\n${a.stdout}\n${a.stderr}`,
    };
  }
  const b = await run(["kubeconform", ...args, appsRendered]);
  if (b.code !== 0) {
    return {
      ok: false,
      err: `kubeconform applications failed for ${vendor}:\n${b.stdout}\n${b.stderr}`,
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

// stripFullCommentLines drops lines whose first non-whitespace character is
// "#" (whole-line YAML comments) before a substring search, so a
// human-readable note in the rendered chart (e.g. "# ...gpu.intel.com/xe...")
// can't produce a false-positive "must not contain" failure, and so a
// "must contain" check can't be satisfied by that same boilerplate comment
// while the real field it's meant to guard is silently missing. Trailing
// inline comments on an otherwise live line (`key: value # note`) are
// deliberately left alone — only lines that are comments in their entirety
// are removed.
//
// Known limitation: this is a plain line-prefix filter, not a YAML/Helm
// parser, so it also strips "#"-prefixed lines that appear inside a block
// scalar (`|`/`>`) value — e.g. an inline shell script or config file
// embedded via `helm.values` where a leading "#" starts what is actually a
// comment *inside that embedded content*, not a YAML comment on the chart
// itself. That's the intended behavior for genuine YAML comments in the
// rendered chart, but it means a needle that only ever appears as a
// comment line *inside* such embedded content would be invisible to these
// assertions too. None of the current mustContain/mustNotContain needles in
// this file target embedded-script content, so this doesn't affect today's
// checks — but keep it in mind before asserting on rendered block-scalar
// bodies.
function stripFullCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function mustNotContain(
  label: string,
  haystack: string,
  needle: string,
  failures: AssertionFailure[],
): void {
  const codeOnly = stripFullCommentLines(haystack);
  if (codeOnly.includes(needle)) {
    failures.push({
      rule: `${label} MUST NOT contain "${needle}"`,
      detail: `found at byte offset ${codeOnly.indexOf(needle)}`,
    });
  }
}

function mustContain(
  label: string,
  haystack: string,
  needle: string,
  failures: AssertionFailure[],
): void {
  const codeOnly = stripFullCommentLines(haystack);
  if (!codeOnly.includes(needle)) {
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

// SNAPSHOT_MISMATCH_HINT is appended to a failing nvidia assertion's detail.
// A mismatch means either a real regression, or that the golden snapshots
// are stale relative to current source — `task test:snapshot -- --update`
// regenerates them (from the same env.EnvFile / helm invocation this test
// mirrors), and the resulting diff is a reviewable, committed change, same
// as the (now-removed) --regen-baseline flow used to be for the old fixture.
const SNAPSHOT_MISMATCH_HINT = "run: task test:snapshot -- --update";

async function assertNvidia(
  addonsYaml: string,
  appsYaml: string,
  outDir: string,
): Promise<AssertionFailure[]> {
  const f: AssertionFailure[] = [];
  const snapshotAddonsPath = `${SNAPSHOT_DIR}/addons.yaml`;
  const snapshotAppsPath = `${SNAPSHOT_DIR}/applications.yaml`;
  const snapshotAddons = await readFile(snapshotAddonsPath, "utf8");
  const snapshotApps = await readFile(snapshotAppsPath, "utf8");

  if (addonsYaml !== snapshotAddons) {
    f.push({
      rule: "addons[nvidia] MUST be byte-identical to the golden snapshot",
      detail: `${await unifiedDiff(
        snapshotAddonsPath,
        `${outDir}/addons.yaml`,
      )}\n${SNAPSHOT_MISMATCH_HINT}`,
    });
  }
  if (appsYaml !== snapshotApps) {
    f.push({
      rule: "apps[nvidia] MUST be byte-identical to the golden snapshot",
      detail: `${await unifiedDiff(
        snapshotAppsPath,
        `${outDir}/applications.yaml`,
      )}\n${SNAPSHOT_MISMATCH_HINT}`,
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
  // Plex Intel bits. No mustContain(..., "gpu.intel.com/xe", ...) here: per
  // configuration/templates/helm-apps.tmpl (see the "NOTE: gpu.intel.com/xe
  // resource limit intentionally NOT set yet" comment there) and
  // charts/applications/values.yaml, that resource limit is deliberately
  // omitted until the intel-gpu-device-plugin actually advertises
  // gpu.intel.com/xe in node allocatable on this cluster — asserting on it
  // would either false-pass against a stray comment (as it did before) or
  // permanently fail against the intentional current design. Plex instead
  // uses a hostPath /dev/dri mount, which the two checks below do cover.
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
  const addonsYaml = await readFile(`${outDir}/addons.yaml`, "utf8");
  const appsYaml = await readFile(`${outDir}/applications.yaml`, "utf8");
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
      `${pad(r.vendor, 9)}${pad(cell(r.renderOk), 8)}${pad(cell(r.lintOk), 8)}${pad(
        cell(r.kubeconformOk),
        13,
      )}${cell(r.assertionsOk)}`,
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour escapes
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return 0;
  }

  KUBERNETES_VERSION = await readKubernetesVersion();
  log.info(
    `Kubernetes schema version (from ${VERSIONS_YAML_PATH}): ${KUBERNETES_VERSION}`,
  );

  // Allocate a non-predictable artifact root via mkdtemp to avoid
  // the hardcoded /tmp/gpu-toggle-test path (symlink-swap exposure on
  // multi-user systems). mkdtemp creates the directory fresh, so no
  // pre-run cleanup of a previous tree is needed.
  ARTIFACT_ROOT = await mkdtemp(join(tmpdir(), "gpu-toggle-test-"));

  const targetVendors: Vendor[] = args.vendor ? [args.vendor] : ALL_VENDORS;

  log.info(`Toggle test harness — vendors: ${targetVendors.join(", ")}`);
  log.info(`Artifact root: ${ARTIFACT_ROOT}`);
  log.info(`Snapshot dir: ${SNAPSHOT_DIR}`);

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
      await rm(ARTIFACT_ROOT, { recursive: true });
    } catch (err) {
      // Don't fail the whole run for post-run cleanup hiccups, but DO surface
      // them — silently ignoring causes disk accumulation under /tmp.
      // NotFound is fine (someone else already cleaned up); anything else is a warning.
      if (!isNotFound(err)) {
        log.warn(
          `post-run cleanup of ${ARTIFACT_ROOT} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
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
    process.exit(await main());
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
