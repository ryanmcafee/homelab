#!/usr/bin/env bun

/**
 * health-test.ts
 *
 * Fixture test runner for the ArgoCD resource health Lua scripts in
 * charts/bootstrap/files/health/.
 *
 * Every charts/bootstrap/files/health/<group>_<kind>.lua is the health check
 * ArgoCD runs for that resource kind (injected into argocd-cm as
 * `resource.customizations.health.<group>_<kind>` by
 * charts/bootstrap/templates/argocd.yaml and, in localdev, by
 * scripts/localdev-argocd.ts). For every fixture
 * tests/health/<group>_<kind>/<name>.yaml (a stripped-down resource whose
 * first line is `# expect: Healthy|Progressing|Degraded|Suspended` and whose
 * optional second line is `# message: <substring>`) this evaluates the Lua
 * with `argocd admin settings resource-overrides health` against a local
 * argocd-cm ConfigMap and asserts the status (and message substring) match.
 *
 * Coverage is enforced in both directions: a fixture directory without a
 * matching Lua file fails, and a Lua file without at least one fixture fails.
 *
 * Usage:
 *   bun scripts/health-test.ts
 *   bun scripts/health-test.ts --help
 *   bun scripts/health-test.ts --only onepassword.com_OnePasswordItem
 *   bun scripts/health-test.ts --argocd .tools/argocd
 *
 * Exit codes: 0 = all fixtures behave as expected; 1 = any mismatch; 2 = bad args.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Logging
// ============================================================================
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.log(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.log(`${green("OK")}    ${msg}`),
  warn: (msg: string) => console.log(`${yellow("WARN")}  ${msg}`),
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
};

// ============================================================================
// CLI args
// ============================================================================
interface Args {
  help: boolean;
  healthDir: string;
  fixturesDir: string;
  argocd: string;
  only: string | null;
}

// requireValue returns argv[i], failing with exit 2 if it's missing or is
// itself another flag — a bare value-taking flag with nothing after it is an
// argument error, not "use the default".
function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith("--")) {
    log.error(`${flag} requires a value`);
    process.exit(2);
  }
  return v;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    healthDir: "charts/bootstrap/files/health",
    fixturesDir: "tests/health",
    argocd: "argocd",
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--health-dir") {
      args.healthDir = requireValue(argv, ++i, "--health-dir");
    } else if (a.startsWith("--health-dir=")) {
      args.healthDir = a.slice("--health-dir=".length);
    } else if (a === "--fixtures-dir") {
      args.fixturesDir = requireValue(argv, ++i, "--fixtures-dir");
    } else if (a.startsWith("--fixtures-dir=")) {
      args.fixturesDir = a.slice("--fixtures-dir=".length);
    } else if (a === "--argocd") {
      args.argocd = requireValue(argv, ++i, "--argocd");
    } else if (a.startsWith("--argocd=")) {
      args.argocd = a.slice("--argocd=".length);
    } else if (a === "--only") {
      args.only = requireValue(argv, ++i, "--only");
    } else if (a.startsWith("--only=")) {
      args.only = a.slice("--only=".length);
    } else {
      log.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`health-test.ts — ArgoCD health Lua fixture test runner

Usage:
  bun scripts/health-test.ts [flags]

Flags:
  --help, -h               Show this help and exit 0
  --health-dir <dir>       Directory of <group>_<kind>.lua health scripts
                           (default: charts/bootstrap/files/health)
  --fixtures-dir <dir>     Directory of <group>_<kind>/<name>.yaml fixtures
                           (default: tests/health)
  --argocd <path>          argocd binary to invoke (default: argocd)
  --only <group_kind>      Run only this resource's fixtures, e.g.
                           --only onepassword.com_OnePasswordItem

Behavior:
  Writes every Lua file into a temporary argocd-cm ConfigMap manifest, then for
  each fixture runs
    argocd admin settings resource-overrides health <fixture> --argocd-cm-path <cm>
  and compares the STATUS line with the fixture's "# expect: <Status>" header
  (and, when present, checks the MESSAGE line contains "# message: <substring>").
  Every fixture directory must match a Lua file and every Lua file must have at
  least one fixture.

Exit codes:
  0  All fixtures matched their expectation
  1  Any fixture mismatched, coverage gap, or argocd could not be run
  2  Argument error
`);
}

// ============================================================================
// Pure helpers (unit-tested in health-test_test.ts)
// ============================================================================
export const HEALTH_STATUSES = [
  "Healthy",
  "Progressing",
  "Degraded",
  "Suspended",
] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface Expectation {
  status: HealthStatus;
  message: string | null;
}

/**
 * parseExpectation reads the fixture header: line 1 must be
 * `# expect: <Status>`; line 2 may be `# message: <substring>`.
 */
export function parseExpectation(text: string): Expectation {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const m = first.match(/^#\s*expect:\s*(\S+)\s*$/);
  if (!m) {
    throw new Error(
      `first line must be "# expect: <Status>", got ${JSON.stringify(first)}`,
    );
  }
  const status = m[1];
  if (!(HEALTH_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `"# expect: ${status}" is not one of ${HEALTH_STATUSES.join("|")}`,
    );
  }
  const second = lines[1] ?? "";
  const mm = second.match(/^#\s*message:\s*(.*?)\s*$/);
  let message: string | null = null;
  if (mm) {
    if (mm[1] === "") {
      throw new Error(`"# message:" header needs a non-empty substring`);
    }
    message = mm[1];
  }
  return { status: status as HealthStatus, message };
}

export interface HealthOutput {
  status: string;
  message: string;
}

/**
 * parseHealthOutput parses the stdout of
 * `argocd admin settings resource-overrides health`, which (argocd v3.5.2) is
 * exactly:
 *
 *   STATUS: Healthy
 *   MESSAGE: Secret synced
 *
 * MESSAGE is present but empty when the Lua sets hs.message = "".
 */
export function parseHealthOutput(text: string): HealthOutput {
  let status: string | null = null;
  let message = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const s = line.match(/^STATUS:\s*(.*?)\s*$/);
    if (s) {
      status = s[1];
      continue;
    }
    const m = line.match(/^MESSAGE:\s*(.*?)\s*$/);
    if (m) message = m[1];
  }
  if (status === null || status === "") {
    throw new Error(
      `no "STATUS: <status>" line in output ${JSON.stringify(text)}`,
    );
  }
  return { status, message };
}

/** healthKey maps `onepassword.com_OnePasswordItem.lua` to its argocd-cm key. */
export function healthKey(luaFileName: string): string {
  const base = luaFileName.split("/").pop() ?? luaFileName;
  if (!base.endsWith(".lua")) {
    throw new Error(`${luaFileName}: health scripts must end in .lua`);
  }
  return `resource.customizations.health.${base.slice(0, -".lua".length)}`;
}

/**
 * fixtureGroupKind derives `<group>_<kind>` from a fixture's apiVersion/kind so
 * a fixture placed in the wrong directory is caught instead of silently
 * exercising a different Lua (or ArgoCD's built-in check). Core-group kinds
 * (apiVersion: v1) map to just `<kind>`, matching ArgoCD's key format.
 */
export function fixtureGroupKind(text: string): string {
  const apiVersion = text.match(
    /^apiVersion:\s*["']?([^\s"']+)["']?\s*$/m,
  )?.[1];
  const kind = text.match(/^kind:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
  if (!apiVersion || !kind) {
    throw new Error("fixture needs top-level apiVersion and kind");
  }
  const slash = apiVersion.indexOf("/");
  const group = slash === -1 ? "" : apiVersion.slice(0, slash);
  return group === "" ? kind : `${group}_${kind}`;
}

/**
 * buildConfigMap renders the argocd-cm manifest that
 * `--argocd-cm-path` reads. JSON is valid YAML and sidesteps re-indenting
 * multi-line Lua into a block scalar.
 */
export function buildConfigMap(data: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  return (
    JSON.stringify(
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "argocd-cm", namespace: "argocd" },
        data: sorted,
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * argocdErrorSummary distils argocd's stderr into one line. The CLI logs JSON
 * lines (`{"level":"fatal","msg":"..."}`) and the last one carries the reason
 * — typically a Lua runtime error such as
 * `attempt to index a non-table object(nil) with key 'phase'`.
 */
export function argocdErrorSummary(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return "(no stderr)";
  const last = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(last) as { level?: string; msg?: string };
    if (typeof parsed.msg === "string" && parsed.msg !== "") {
      return parsed.level ? `${parsed.level}: ${parsed.msg}` : parsed.msg;
    }
  } catch {
    // not JSON: fall through to the raw line
  }
  return last;
}

export interface Verdict {
  ok: boolean;
  detail: string;
}

/** judge compares what the Lua produced with what the fixture header expects. */
export function judge(expect: Expectation, actual: HealthOutput): Verdict {
  if (actual.status !== expect.status) {
    return {
      ok: false,
      detail: `expected ${expect.status}, got ${actual.status} (message: ${JSON.stringify(
        actual.message,
      )})`,
    };
  }
  if (expect.message !== null && !actual.message.includes(expect.message)) {
    return {
      ok: false,
      detail: `status ${actual.status} as expected, but message ${JSON.stringify(
        actual.message,
      )} does not contain ${JSON.stringify(expect.message)}`,
    };
  }
  return { ok: true, detail: "" };
}

export interface Coverage {
  /** group_kind names present in both the health dir and the fixtures dir */
  covered: string[];
  /** Lua files with no fixture directory (or an empty one) */
  luaWithoutFixtures: string[];
  /** fixture directories with no Lua file */
  fixturesWithoutLua: string[];
}

/**
 * coverage cross-checks Lua names against fixture directory names. `fixtures`
 * maps a directory name to its fixture file count.
 */
export function coverage(
  luaNames: string[],
  fixtures: Record<string, number>,
): Coverage {
  const luaSet = new Set(luaNames);
  const covered: string[] = [];
  const luaWithoutFixtures: string[] = [];
  const fixturesWithoutLua: string[] = [];
  for (const name of [...luaSet].sort()) {
    if ((fixtures[name] ?? 0) > 0) covered.push(name);
    else luaWithoutFixtures.push(name);
  }
  for (const name of Object.keys(fixtures).sort()) {
    if (!luaSet.has(name)) fixturesWithoutLua.push(name);
  }
  return { covered, luaWithoutFixtures, fixturesWithoutLua };
}

// ============================================================================
// Discovery
// ============================================================================
async function listLuaFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".lua")) out.push(entry.name);
  }
  out.sort();
  return out;
}

async function listFixtureDirs(dir: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files: string[] = [];
    for (const f of await readdir(`${dir}/${entry.name}`, {
      withFileTypes: true,
    })) {
      if (f.isFile() && f.name.endsWith(".yaml") && !f.name.startsWith("_")) {
        files.push(f.name);
      }
    }
    files.sort();
    out[entry.name] = files;
  }
  return out;
}

// ============================================================================
// argocd invocation
// ============================================================================
async function runArgocdHealth(
  argocdBin: string,
  fixturePath: string,
  cmPath: string,
): Promise<HealthOutput> {
  const argv = [
    argocdBin,
    "admin",
    "settings",
    "resource-overrides",
    "health",
    fixturePath,
    "--argocd-cm-path",
    cmPath,
  ];
  let stdoutText: string;
  let stderrText: string;
  let code: number;
  try {
    const p = Bun.spawn(argv, {
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    [stdoutText, stderrText, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
  } catch (err) {
    throw new Error(
      `could not run ${argocdBin}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (code !== 0) {
    throw new Error(
      `argocd exited ${code}: ${argocdErrorSummary(stderrText || stdoutText)}`,
    );
  }
  return parseHealthOutput(stdoutText);
}

// ============================================================================
// Test cases
// ============================================================================
interface CaseResult {
  name: string;
  expect: string;
  actual: string;
  ok: boolean;
  detail: string;
}

async function runCase(
  args: Args,
  groupKind: string,
  fixtureFile: string,
  cmPath: string,
): Promise<CaseResult> {
  const name = `${groupKind}/${fixtureFile}`;
  const path = `${args.fixturesDir}/${groupKind}/${fixtureFile}`;
  let expectText = "?";
  try {
    const text = await readFile(path, "utf8");
    const expect = parseExpectation(text);
    expectText =
      expect.message === null
        ? expect.status
        : `${expect.status} ~ "${expect.message}"`;
    const actualGroupKind = fixtureGroupKind(text);
    if (actualGroupKind !== groupKind) {
      return {
        name,
        expect: expectText,
        actual: "-",
        ok: false,
        detail: `fixture is a ${actualGroupKind} but lives under ${groupKind}/ — it would not exercise ${groupKind}.lua`,
      };
    }
    const actual = await runArgocdHealth(args.argocd, path, cmPath);
    const verdict = judge(expect, actual);
    return {
      name,
      expect: expectText,
      actual: actual.status,
      ok: verdict.ok,
      detail: verdict.detail,
    };
  } catch (err) {
    return {
      name,
      expect: expectText,
      actual: "-",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
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

  let luaFiles: string[];
  try {
    luaFiles = await listLuaFiles(args.healthDir);
  } catch (err) {
    log.error(
      `cannot read --health-dir ${args.healthDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }
  if (luaFiles.length === 0) {
    log.error(`no *.lua health scripts in ${args.healthDir}`);
    return 1;
  }
  let fixtureDirs: Record<string, string[]>;
  try {
    fixtureDirs = await listFixtureDirs(args.fixturesDir);
  } catch (err) {
    log.error(
      `cannot read --fixtures-dir ${args.fixturesDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 1;
  }

  const luaNames = luaFiles.map((f) => f.slice(0, -".lua".length));
  const counts: Record<string, number> = {};
  for (const [d, files] of Object.entries(fixtureDirs)) {
    counts[d] = files.length;
  }
  const cov = coverage(luaNames, counts);

  let failed = 0;
  for (const name of cov.fixturesWithoutLua) {
    log.error(
      `${args.fixturesDir}/${name}/ has no matching ${args.healthDir}/${name}.lua`,
    );
    failed++;
  }
  for (const name of cov.luaWithoutFixtures) {
    log.error(
      `${args.healthDir}/${name}.lua has no fixtures in ${args.fixturesDir}/${name}/ (need at least one)`,
    );
    failed++;
  }

  let selected = cov.covered;
  if (args.only !== null) {
    if (!luaNames.includes(args.only)) {
      log.error(
        `--only ${args.only}: no such health script (have: ${luaNames.join(
          ", ",
        )})`,
      );
      return 1;
    }
    selected = selected.filter((n) => n === args.only);
  }

  // One ConfigMap carrying every Lua: the CLI picks the key for the fixture's
  // group/kind exactly as the controller would, so a fixture in the wrong
  // directory is caught by fixtureGroupKind, not masked by a narrowed map.
  const data: Record<string, string> = {};
  for (const f of luaFiles) {
    data[healthKey(f)] = await readFile(`${args.healthDir}/${f}`, "utf8");
  }
  const tmpDir = await mkdtemp(join(tmpdir(), "health-test-"));
  const cmPath = `${tmpDir}/argocd-cm.yaml`;
  await writeFile(cmPath, buildConfigMap(data));

  log.info(
    `${luaFiles.length} health script(s) in ${args.healthDir}, evaluating with ${args.argocd}`,
  );

  const cases: { groupKind: string; file: string }[] = [];
  for (const groupKind of selected) {
    for (const file of fixtureDirs[groupKind]) cases.push({ groupKind, file });
  }

  let results: CaseResult[];
  try {
    results = await runPool(cases, 8, (c) =>
      runCase(args, c.groupKind, c.file, cmPath),
    );
  } finally {
    await rm(tmpDir, { recursive: true });
  }

  for (const r of results) {
    if (r.ok) {
      log.ok(`${r.name} → ${r.actual}`);
    } else {
      log.error(`${r.name}: ${r.detail}`);
      failed++;
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log("");
  if (failed === 0) {
    log.ok(
      `${passed}/${results.length} fixture(s) passed across ${selected.length} health script(s)`,
    );
    return 0;
  }
  log.error(
    `${results.length - passed} fixture failure(s), ${
      cov.fixturesWithoutLua.length + cov.luaWithoutFixtures.length
    } coverage gap(s); ${passed}/${results.length} passed`,
  );
  return 1;
}

if (import.meta.main) {
  process.exit(await main());
}
