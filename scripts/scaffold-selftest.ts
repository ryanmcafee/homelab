#!/usr/bin/env bun

/**
 * scaffold-selftest.ts
 *
 * Proves that `homelab scaffold app` produces apps that pass level 0 (issue
 * #261 item 21). The repository is copied (`git ls-files`, working-tree
 * content, untracked-but-not-ignored files included) into a temporary
 * directory, the CLI is built once, and every case scaffolds its apps into its
 * own copy and runs `homelab verify all --level 0 --json` there. Nothing in the
 * real checkout is touched.
 *
 * A level-0 run of the unmodified copy is the baseline, so a tree that already
 * fails for unrelated reasons (someone else's in-progress edit) still gives a
 * verdict: a case fails only on checks that fail because of the scaffold —
 * a check that newly fails, or a failing check that gained findings. Checks
 * that failed before are listed separately as pre-existing.
 *
 * Network: none. The operator case registers a fresh API group
 * (selftest.example.com) that nothing renders a custom resource of, so level 0
 * needs no vendored schema for it (the scaffolder writes the
 * tests/schemas/sources.yaml entry; `task schemas:vendor` would fetch it).
 * kubeconform's core schemas come from its cache (~/.cache/homelab-kubeconform),
 * exactly as for `task verify`.
 *
 * Extra checks per case: `homelab config guard` (the PII guard pre-commit and CI
 * run) on the generated configuration/ and values-homelab.yaml files, and, when
 * the tool is installed, `chainsaw lint` on the generated e2e tests, `yamllint`
 * on the generated plain YAML and scripts/health-test.ts (argocd CLI) on the
 * generated health Lua.
 *
 * Usage:
 *   bun scripts/scaffold-selftest.ts
 *   task test:scaffold
 *   task test:scaffold -- --only helm,operator --keep
 *   task test:scaffold -- --bin bin/homelab       # reuse a built CLI
 *   task test:scaffold -- --dry-run               # print the plan, run nothing
 *
 * Exit codes: 0 = every case passes; 1 = a case failed; 2 = usage error.
 */

import type { Stats } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNotFound } from "./lib/errors.ts";

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
// Cases
// ============================================================================

/** One `homelab scaffold app` invocation. */
export interface ScaffoldApp {
  name: string;
  args: string[];
}

/** One isolated copy of the repository with one or more scaffolded apps. */
export interface SelftestCase {
  id: string;
  description: string;
  apps: ScaffoldApp[];
}

const OPERATOR: ScaffoldApp = {
  name: "selftest-operator",
  args: [
    "--pattern",
    "operator",
    "--chart-repo",
    "https://charts.example.com/selftest",
    "--chart-version",
    "1.0.0",
    "--crd-group",
    "selftest.example.com",
    "--crd-kinds",
    "Widget,Gadget",
    "--huge-crds",
  ],
};

const HELM_TRUECHARTS: ScaffoldApp = {
  name: "selftest-web",
  args: [
    "--pattern",
    "helm",
    "--chart-repo",
    "oci://oci.trueforge.org/truecharts",
    "--chart-version",
    "1.0.0",
    "--port",
    "8080",
    "--health-path",
    "/healthz",
    "--expect",
    "200,401",
  ],
};

const DEPS_MAIN_CONFIG: ScaffoldApp = {
  name: "selftest-stack",
  args: [
    "--pattern",
    "deps-main-config",
    "--chart-repo",
    "https://charts.example.com/selftest",
    "--chart-name",
    "stack",
    "--chart-version",
    "2.0.0",
    "--health-path",
    "/alive",
  ],
};

/** A plain https chart in the helm pattern's generic (`helm create`) layout. */
const HELM_GENERIC: ScaffoldApp = {
  name: "selftest-generic",
  args: [
    "--pattern",
    "helm",
    "--chart-repo",
    "https://charts.example.com/selftest",
    "--chart-name",
    "generic",
    "--chart-version",
    "0.3.1",
    "--namespace",
    "media",
  ],
};

/** An OCI registry with no repository Secret yet, in the addons tier. */
const HELM_OCI_ADDONS: ScaffoldApp = {
  name: "selftest-oci",
  args: [
    "--pattern",
    "helm",
    "--tier",
    "addons",
    "--chart-repo",
    "oci://ghcr.io/example/charts",
    "--chart-version",
    "0.1.0",
    "--wave",
    "11",
  ],
};

export const CASES: SelftestCase[] = [
  {
    id: "operator",
    description: "operator pattern (cloudnative-pg shape) with two CRD kinds",
    apps: [OPERATOR],
  },
  {
    id: "helm",
    description: "helm pattern (sonarr shape), TrueCharts OCI",
    apps: [HELM_TRUECHARTS],
  },
  {
    id: "deps-main-config",
    description: "deps-main-config pattern (traefik-external shape)",
    apps: [DEPS_MAIN_CONFIG],
  },
  {
    id: "combined",
    description:
      "all patterns in one tree, plus a generic https chart in an existing namespace and a new OCI registry in addons",
    apps: [
      OPERATOR,
      HELM_TRUECHARTS,
      DEPS_MAIN_CONFIG,
      HELM_GENERIC,
      HELM_OCI_ADDONS,
    ],
  },
];

// ============================================================================
// Result classification (pure)
// ============================================================================

export type Status = "pass" | "fail" | "skip";

/** internal/verify/types.go Check. */
export interface Check {
  name: string;
  status: Status;
  duration_ms?: number;
  detail?: string;
  findings?: string[];
}

/** internal/verify/types.go Result. */
export interface VerifyResult {
  level: number;
  pass: boolean;
  checks: Check[];
  duration_ms?: number;
}

export interface Worsened {
  check: Check;
  added: string[];
}

export interface Classification {
  /** Failing now, not failing in the baseline: caused by the scaffold. */
  newFailures: Check[];
  /** Failing in both runs, with findings the baseline did not have. */
  worsened: Worsened[];
  /** Failing in both runs with nothing new: not the scaffold's doing. */
  preExisting: Check[];
  /** Failing in the baseline, passing (or gone) now. */
  fixed: string[];
}

/** Compare a run after scaffolding with the baseline run of the same tree. */
export function classify(baseline: Check[], after: Check[]): Classification {
  const base = new Map(baseline.map((c) => [c.name, c]));
  const now = new Map(after.map((c) => [c.name, c]));
  const out: Classification = {
    newFailures: [],
    worsened: [],
    preExisting: [],
    fixed: [],
  };
  for (const c of after) {
    if (c.status !== "fail") continue;
    const b = base.get(c.name);
    if (!b || b.status !== "fail") {
      out.newFailures.push(c);
      continue;
    }
    const known = new Set(b.findings ?? []);
    const added = (c.findings ?? []).filter((f) => !known.has(f));
    if (added.length > 0) out.worsened.push({ check: c, added });
    else out.preExisting.push(c);
  }
  for (const b of baseline) {
    if (b.status !== "fail") continue;
    const c = now.get(b.name);
    if (!c || c.status !== "fail") out.fixed.push(b.name);
  }
  return out;
}

/** Extra (non-level-0) check outcome. */
export interface ExtraCheck {
  name: string;
  status: Status;
  detail: string;
}

export interface CaseResult {
  id: string;
  description: string;
  dir: string;
  scaffoldErrors: string[];
  verifyError?: string;
  classification?: Classification;
  extras: ExtraCheck[];
}

/** A case passes when every scaffold ran, level 0 ran, nothing got worse. */
export function casePassed(r: CaseResult): boolean {
  if (r.scaffoldErrors.length > 0 || r.verifyError) return false;
  if (!r.classification) return false;
  if (r.extras.some((e) => e.status === "fail")) return false;
  return (
    r.classification.newFailures.length === 0 &&
    r.classification.worsened.length === 0
  );
}

/**
 * Extract the JSON result from `homelab verify all --json` stdout. The CLI
 * prints only the object, but a wrapper (task) may add lines around it.
 */
export function parseVerifyOutput(stdout: string): VerifyResult {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("no JSON object in homelab verify output");
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  if (!parsed || !Array.isArray(parsed.checks)) {
    throw new Error("homelab verify output has no checks[]");
  }
  return parsed as VerifyResult;
}

/** Paths the scaffolder reported as created ("[OK] created  <path>"). */
export function createdPaths(stdout: string): string[] {
  const out: string[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour escapes
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  for (const line of clean.split("\n")) {
    const m = /\bcreated\s+(\S+)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Every path the scaffolder reported as created or modified. */
export function changedPaths(stdout: string): string[] {
  const out: string[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour escapes
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  for (const line of clean.split("\n")) {
    const m = /\b(?:created|modified)\s+(\S+)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Files the PII guard scans by default (everything under configuration/ and
 * every values-homelab.yaml of a chart), which pre-commit and CI run on every
 * change.
 */
export function guardTargets(paths: string[]): string[] {
  return paths.filter(
    (p) =>
      p.startsWith("configuration/") ||
      /^charts\/[^/]+\/values-homelab\.yaml$/.test(p),
  );
}

/** Created files yamllint should check: plain YAML outside Helm templates. */
export function yamllintTargets(paths: string[]): string[] {
  return paths.filter(
    (p) =>
      /\.ya?ml$/.test(p) &&
      !/^charts\/[^/]+\/templates\//.test(p) &&
      !p.startsWith("tests/snapshots/"),
  );
}

/** Health Lua stems (<group>_<Kind>) among created files. */
export function healthStems(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const m = /^charts\/bootstrap\/files\/health\/(.+)\.lua$/.exec(p);
    if (m) out.push(m[1]);
  }
  return out.sort();
}

/** chainsaw test files among created files. */
export function e2eTests(paths: string[]): string[] {
  return paths.filter((p) =>
    /^tests\/e2e\/[^/]+\/chainsaw-test\.yaml$/.test(p),
  );
}

const MAX_FINDINGS = 8;

/** Human-readable report of every case. */
export function renderSummary(results: CaseResult[]): string {
  const lines: string[] = [];
  lines.push("Scaffolder self-test (homelab scaffold app -> level 0)");
  lines.push("");
  for (const r of results) {
    const verdict = casePassed(r) ? "PASS" : "FAIL";
    lines.push(`[${verdict}] ${r.id}: ${r.description}`);
    for (const e of r.scaffoldErrors) lines.push(`  scaffold failed: ${e}`);
    if (r.verifyError) lines.push(`  level 0 did not run: ${r.verifyError}`);
    const c = r.classification;
    if (c) {
      lines.push(
        `  caused by the scaffold: ${
          c.newFailures.length + c.worsened.length
        } | pre-existing failures: ${c.preExisting.length} | fixed by the regenerate: ${c.fixed.length}`,
      );
      for (const f of c.newFailures) {
        lines.push(`  NEW  ${f.name}: ${f.detail ?? ""}`);
        for (const x of (f.findings ?? []).slice(0, MAX_FINDINGS)) {
          lines.push(`         ${x}`);
        }
      }
      for (const w of c.worsened) {
        lines.push(
          `  MORE ${w.check.name}: ${w.added.length} finding(s) the baseline did not have`,
        );
        for (const x of w.added.slice(0, MAX_FINDINGS)) {
          lines.push(`         ${x}`);
        }
      }
      for (const p of c.preExisting) {
        lines.push(`  pre-existing (ignored) ${p.name}`);
      }
    }
    for (const e of r.extras) {
      lines.push(
        `  ${e.status.padEnd(4)} ${e.name}${e.detail ? `: ${e.detail}` : ""}`,
      );
    }
  }
  const failed = results.filter((r) => !casePassed(r)).map((r) => r.id);
  lines.push("");
  lines.push(
    failed.length === 0
      ? `All ${results.length} case(s) pass level 0.`
      : `${failed.length} of ${results.length} case(s) failed: ${failed.join(
          ", ",
        )}`,
  );
  return lines.join("\n");
}

// ============================================================================
// CLI args
// ============================================================================

export interface Args {
  help: boolean;
  keep: boolean;
  dryRun: boolean;
  only: string[];
  bin: string | null;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    keep: false,
    dryRun: false,
    only: [],
    bin: null,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--keep") args.keep = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--only") args.only.push(...splitList(value(++i, a)));
    else if (a.startsWith("--only=")) {
      args.only.push(...splitList(a.slice("--only=".length)));
    } else if (a === "--bin") args.bin = value(++i, a);
    else if (a.startsWith("--bin=")) args.bin = a.slice("--bin=".length);
    else throw new UsageError(`unknown argument ${a}`);
  }
  const ids = CASES.map((c) => c.id);
  for (const o of args.only) {
    if (!ids.includes(o)) {
      throw new UsageError(`unknown case ${o} (want one of ${ids.join(", ")})`);
    }
  }
  return args;
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

const HELP = `scaffold-selftest.ts: prove homelab scaffold app output passes level 0

Copies the repository (git ls-files, working-tree content) to a temporary
directory, builds the homelab CLI, and for every case scaffolds its apps into a
fresh copy and runs homelab verify all --level 0 --json there. A baseline run of
the unmodified copy separates failures the scaffold causes from pre-existing ones.

Cases:
${CASES.map((c) => `  ${c.id.padEnd(17)} ${c.description}`).join("\n")}

Options:
  --only <case,...>  Run only these cases
  --keep             Keep the temporary copies and print their paths
  --bin <path>       Use this homelab binary instead of building one
  --dry-run          Print the cases and commands; copy, build and run nothing
  -h, --help         Show this help

Exit codes: 0 every case passes, 1 a case failed, 2 usage error.`;

// ============================================================================
// Side effects
// ============================================================================

/**
 * Extra environment for every child process. main() trusts the temporary
 * copies for mise: its shims (helm, kubeconform, go, ...) refuse to run in a
 * directory whose mise.toml is not trusted, which would fail every render.
 */
const childEnv: Record<string, string> = { NO_COLOR: "1" };

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<RunResult> {
  try {
    const p = Bun.spawn([cmd, ...args], {
      cwd,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...childEnv },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    if (isNotFound(e)) {
      return { code: 127, stdout: "", stderr: `${cmd}: not found` };
    }
    throw e;
  }
}

async function which(tool: string): Promise<boolean> {
  const r = await run(tool, ["--help"], process.cwd());
  return r.code !== 127;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Copy the working tree's tracked + untracked-unignored files to dest. */
async function copyRepo(root: string, dest: string): Promise<number> {
  const r = await run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    root,
  );
  if (r.code !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
  let n = 0;
  const made = new Set<string>();
  for (const rel of r.stdout.split("\0")) {
    if (rel === "") continue;
    const src = `${root}/${rel}`;
    let info: Stats;
    try {
      info = await lstat(src);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (!info.isFile()) continue;
    const target = `${dest}/${rel}`;
    const dir = dirname(target);
    if (!made.has(dir)) {
      await mkdir(dir, { recursive: true });
      made.add(dir);
    }
    await copyFile(src, target);
    n++;
  }
  return n;
}

/** Recursively copy a directory tree of regular files. */
async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const from = `${src}/${e.name}`;
    const to = `${dest}/${e.name}`;
    if (e.isDirectory()) await copyTree(from, to);
    else if (e.isFile()) await copyFile(from, to);
  }
}

async function verifyLevel0(bin: string, dir: string): Promise<VerifyResult> {
  const r = await run(bin, ["verify", "all", "--level", "0", "--json"], dir);
  // Exit 1 is a normal "some check failed" result; the JSON is still there.
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(
      `homelab verify exited ${r.code}: ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return parseVerifyOutput(r.stdout);
}

async function extraChecks(
  bin: string,
  dir: string,
  created: string[],
  changed: string[],
): Promise<ExtraCheck[]> {
  const out: ExtraCheck[] = [];

  // The PII guard runs in pre-commit and CI; generated values and templates
  // must pass it (shape rules; the copy has no real homelab.yaml).
  const guarded = guardTargets(changed);
  if (guarded.length > 0) {
    const r = await run(
      bin,
      ["config", "guard", "--set", "homelab", ...guarded],
      dir,
    );
    out.push({
      name: `config guard (${guarded.length} files)`,
      status: r.code === 0 ? "pass" : "fail",
      detail:
        r.code === 0
          ? ""
          : (r.stdout + r.stderr).trim().split("\n").slice(-6).join(" | "),
    });
  }

  const tests = e2eTests(created);
  if (!(await which("chainsaw"))) {
    out.push({
      name: "chainsaw lint",
      status: "skip",
      detail: "chainsaw not installed",
    });
  } else {
    for (const t of tests) {
      const r = await run("chainsaw", ["lint", "test", "-f", t], dir);
      out.push({
        name: `chainsaw lint ${t}`,
        status: r.code === 0 ? "pass" : "fail",
        detail:
          r.code === 0
            ? ""
            : (r.stdout + r.stderr).trim().split("\n").slice(-5).join(" | "),
      });
    }
  }

  const yml = yamllintTargets(created);
  if (!(await which("yamllint"))) {
    out.push({
      name: "yamllint",
      status: "skip",
      detail: "yamllint not installed",
    });
  } else if (yml.length > 0) {
    const r = await run(
      "yamllint",
      ["-c", ".yamllint", "-f", "parsable", ...yml],
      dir,
    );
    // Warnings (line length, document start) do not fail yamllint; errors do.
    out.push({
      name: `yamllint (${yml.length} files)`,
      status: r.code === 0 ? "pass" : "fail",
      detail:
        r.code === 0 ? "" : r.stdout.trim().split("\n").slice(0, 5).join(" | "),
    });
  }

  const stems = healthStems(created);
  if (stems.length > 0) {
    if (!(await which("argocd"))) {
      out.push({
        name: "health Lua",
        status: "skip",
        detail: "argocd CLI not installed",
      });
    } else {
      for (const stem of stems) {
        const r = await run(
          process.execPath,
          ["scripts/health-test.ts", "--only", stem],
          dir,
        );
        out.push({
          name: `health ${stem}`,
          status: r.code === 0 ? "pass" : "fail",
          detail:
            r.code === 0
              ? ""
              : (r.stdout + r.stderr).trim().split("\n").slice(-5).join(" | "),
        });
      }
    }
  }
  return out;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      log.error(e.message);
      console.error(HELP);
      return 2;
    }
    throw e;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const cases =
    args.only.length > 0
      ? CASES.filter((c) => args.only.includes(c.id))
      : CASES;

  if (args.dryRun) {
    log.info("dry run: nothing is copied, built or run");
    for (const c of cases) {
      console.log(`${c.id}: ${c.description}`);
      for (const a of c.apps) {
        console.log(`  homelab scaffold app ${a.name} ${a.args.join(" ")}`);
      }
      console.log("  homelab verify all --level 0 --json");
    }
    return 0;
  }

  const root = (
    await run("git", ["rev-parse", "--show-toplevel"], process.cwd())
  ).stdout.trim();
  if (!root) {
    log.error("not inside a git checkout");
    return 1;
  }
  const tmp = await mkdtemp(join(tmpdir(), "homelab-scaffold-selftest-"));
  childEnv.MISE_TRUSTED_CONFIG_PATHS = [
    tmp,
    process.env.MISE_TRUSTED_CONFIG_PATHS,
  ]
    .filter((x) => x)
    .join(":");
  try {
    const base = `${tmp}/base`;
    const n = await copyRepo(root, base);
    log.info(`copied ${n} files to ${base}`);

    let bin = args.bin;
    if (!bin) {
      bin = `${tmp}/homelab`;
      const b = await run("go", ["build", "-o", bin, "./cmd/homelab"], root);
      if (b.code !== 0) {
        log.error(`go build failed:\n${b.stderr}`);
        return 1;
      }
      log.ok("built the homelab CLI");
    } else if (!bin.startsWith("/")) {
      bin = `${root}/${bin}`;
    }

    const baseline = await verifyLevel0(bin, base);
    const baseFails = baseline.checks.filter((c) => c.status === "fail").length;
    if (baseFails > 0) {
      log.warn(
        `baseline: ${baseFails} check(s) already fail in the unmodified tree; judged separately`,
      );
    } else {
      log.ok(`baseline: ${baseline.checks.length} checks pass`);
    }

    const results: CaseResult[] = [];
    for (const c of cases) {
      const dir = `${tmp}/${c.id}`;
      await copyTree(base, dir);
      const r: CaseResult = {
        id: c.id,
        description: c.description,
        dir,
        scaffoldErrors: [],
        extras: [],
      };
      const created: string[] = [];
      const changed: string[] = [];
      for (const a of c.apps) {
        const s = await run(bin, ["scaffold", "app", a.name, ...a.args], dir);
        if (s.code !== 0) {
          r.scaffoldErrors.push(
            `${a.name} (exit ${s.code}): ${(s.stderr + s.stdout)
              .trim()
              .split("\n")
              .slice(-12)
              .join(" | ")}`,
          );
        }
        created.push(...createdPaths(s.stdout));
        changed.push(...changedPaths(s.stdout));
      }
      try {
        const after = await verifyLevel0(bin, dir);
        r.classification = classify(baseline.checks, after.checks);
      } catch (e) {
        r.verifyError = e instanceof Error ? e.message : String(e);
      }
      r.extras = await extraChecks(bin, dir, created, changed);
      (casePassed(r) ? log.ok : log.error)(`case ${c.id}`);
      results.push(r);
    }

    console.log("");
    console.log(renderSummary(results));
    if (args.keep) {
      log.info(
        `kept ${tmp} (base/ is the unmodified copy; one directory per case)`,
      );
    }
    return results.every(casePassed) ? 0 : 1;
  } finally {
    if (!args.keep) await rm(tmp, { recursive: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
