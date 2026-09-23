#!/usr/bin/env bun

/**
 * claude-verify-hook.ts
 *
 * Claude Code PostToolUse hook (registered in .claude/settings.json for
 * Edit|Write|MultiEdit) that makes level-0 verification automatic for agents
 * (issue #261 item 22). After every edit to a file under `charts/` or
 * `configuration/` of the project it runs `homelab verify all --level 0 --json`
 * and feeds any failure straight back to the agent.
 *
 *   - stdin is the hook payload: {session_id, cwd, hook_event_name, tool_name,
 *     tool_input, tool_response}. Edited paths come from
 *     tool_input.file_path, tool_input.edits[].file_path and
 *     tool_input.notebook_path.
 *   - The project root is $CLAUDE_PROJECT_DIR (falls back to the payload cwd).
 *     Paths outside `charts/` and `configuration/` of that root: silent exit 0.
 *   - HOMELAB_VERIFY_HOOK=off (or 0/false/no) disables the hook: silent exit 0.
 *   - A lock file in the OS temp dir (one per project root) skips the run while
 *     another one is in flight; a lock older than 200 s is treated as stale.
 *   - Level 0 is built once (`go build -o <tmp>/.../homelab ./cmd/homelab`, which
 *     is what `go run` does, but leaves a process a timeout can actually kill)
 *     and run in the project root with a 150 s deadline for both steps.
 *   - Pass: exit 0, no output. Fail: exit 2 with a compact stderr summary
 *     (failing checks, detail, <= 5 findings each, <= 60 lines) that Claude
 *     Code shows to the agent. Level 0 not running at all (build error, crash,
 *     timeout) is also exit 2, with the reason.
 *
 * Usage:
 *   (automatic, from .claude/settings.json)
 *   echo '{"tool_name":"Edit","tool_input":{"file_path":"'$PWD'/charts/addons/values.yaml"}}' \
 *     | CLAUDE_PROJECT_DIR=$PWD bun scripts/claude-verify-hook.ts
 *   ... scripts/claude-verify-hook.ts --dry-run   # print the decision, run nothing
 *   ... scripts/claude-verify-hook.ts --help
 *
 * Exit codes: 0 = nothing to do or level 0 passed; 2 = level 0 failed or could
 * not run (stderr goes to the agent); 1 = internal error (never blocks a tool).
 */

import {
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAlreadyExists } from "./lib/errors.ts";
import {
  parseVerifyResult,
  type VerifyCheck,
  type VerifyResult,
} from "./verify-claim.ts";

// ============================================================================
// Logging (only for --dry-run and --help; the hook itself is silent on pass)
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

export const TIMEOUT_MS = 150_000;
export const STALE_LOCK_MS = 200_000;
export const WATCHED_DIRS = ["charts/", "configuration/"];

// ============================================================================
// Payload -> paths
// ============================================================================

/** collectEditedPaths returns every path the tool call touched, deduplicated. */
export function collectEditedPaths(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const input = (payload as Record<string, unknown>).tool_input;
  if (typeof input !== "object" || input === null) return [];
  const ti = input as Record<string, unknown>;
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v !== "" && !out.includes(v)) out.push(v);
  };
  add(ti.file_path);
  add(ti.notebook_path);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (typeof e === "object" && e !== null) {
        add((e as Record<string, unknown>).file_path);
      }
    }
  }
  return out;
}

/** normalizePath resolves `.`/`..` segments of a POSIX path (no filesystem access). */
export function normalizePath(p: string): string {
  const abs = p.startsWith("/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!abs) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return (abs ? "/" : "") + parts.join("/");
}

/**
 * relativeToRoot returns `path` relative to `root` (both resolved against
 * `cwd` when relative), or null when it is outside the root.
 */
export function relativeToRoot(
  path: string,
  root: string,
  cwd: string,
): string | null {
  const abs = normalizePath(path.startsWith("/") ? path : `${cwd}/${path}`);
  const r = normalizePath(root.startsWith("/") ? root : `${cwd}/${root}`);
  const prefix = r === "/" ? "/" : `${r}/`;
  if (!abs.startsWith(prefix)) return null;
  return abs.slice(prefix.length);
}

/** watchedPaths keeps the edited paths under charts/ or configuration/ of root, relative. */
export function watchedPaths(
  paths: string[],
  root: string,
  cwd: string,
): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const rel = relativeToRoot(p, root, cwd);
    if (rel !== null && WATCHED_DIRS.some((d) => rel.startsWith(d))) {
      out.push(rel);
    }
  }
  return out;
}

export function hookDisabled(value: string | undefined): boolean {
  return (
    value !== undefined &&
    ["off", "0", "false", "no"].includes(value.trim().toLowerCase())
  );
}

// ============================================================================
// Lock
// ============================================================================

/** fnv1a is a stable, dependency-free 32-bit hash used to key temp files by project root. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function tempDir(): string {
  return (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "") || "/tmp";
}

/** The three filesystem operations the lock needs (injectable for tests). */
export interface LockFs {
  /** Create `path` with `data`; throws an EEXIST error when it exists. */
  createNew(path: string, data: string): void;
  /** Modification time in ms, or null when the file does not exist. */
  mtimeMs(path: string): number | null;
  remove(path: string): void;
}

export const realLockFs: LockFs = {
  createNew: (path, data) => writeFileSync(path, data, { flag: "wx" }),
  mtimeMs: (path) => {
    try {
      return statSync(path).mtime?.getTime() ?? null;
    } catch {
      return null;
    }
  },
  remove: (path) => rmSync(path),
};

/**
 * tryAcquireLock creates `path` exclusively. When it already exists and is
 * younger than `staleMs` another run is in flight: returns false. An older lock
 * (a killed run) is replaced.
 */
export function tryAcquireLock(
  path: string,
  nowMs: number,
  staleMs = STALE_LOCK_MS,
  fs: LockFs = realLockFs,
): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.createNew(path, `${process.pid} ${nowMs}\n`);
      return true;
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      const mtime = fs.mtimeMs(path);
      if (mtime === null) continue; // removed between the two calls: retry
      if (nowMs - mtime < staleMs) return false;
      try {
        fs.remove(path);
      } catch {
        // someone else replaced it; the retry decides
      }
    }
  }
  return false;
}

export function releaseLock(path: string, fs: LockFs = realLockFs): void {
  try {
    fs.remove(path);
  } catch {
    // already gone
  }
}

// ============================================================================
// Failure summary
// ============================================================================
export interface SummaryOptions {
  maxLines: number;
  maxFindings: number;
  maxLineLength: number;
}

const DEFAULT_SUMMARY: SummaryOptions = {
  maxLines: 60,
  maxFindings: 5,
  maxLineLength: 240,
};

function clip(s: string, n: number): string {
  const one = s.replaceAll("\n", " ").replaceAll("\t", " ");
  return one.length > n ? `${one.slice(0, n - 3)}...` : one;
}

/** hintsFor returns the fix hints that apply to the failing checks. */
export function hintsFor(failing: VerifyCheck[]): string[] {
  const hints: string[] = [];
  if (failing.some((c) => c.name.startsWith("snapshot/"))) {
    hints.push(
      "Hint: snapshot/* drift after an INTENDED render change is fixed with `task test:snapshot -- --update` (review the diff, then commit it); unintended drift means the edit changed more than you meant.",
    );
  }
  if (failing.some((c) => c.name === "render/localdev/_committed-values")) {
    hints.push(
      "Hint: render/localdev/_committed-values -> run `task config:export:localdev` (never hand-edit charts/*/values-localdev.yaml).",
    );
  }
  if (
    failing.some(
      (c) =>
        c.name.startsWith("kubeconform/") &&
        (c.findings ?? []).some((f) => f.includes("could not find schema")),
    )
  ) {
    hints.push(
      "Hint: `could not find schema` -> add the kind to tests/schemas/sources.yaml and run `task schemas:vendor`.",
    );
  }
  return hints;
}

/**
 * summarizeFailure renders the stderr text the agent sees: header, every
 * failing check with its detail and up to maxFindings findings, the hints, all
 * within maxLines lines.
 */
export function summarizeFailure(
  result: VerifyResult,
  edited: string[],
  opts: SummaryOptions = DEFAULT_SUMMARY,
): string {
  const failing = result.checks.filter((c) => c.status === "fail");
  const secs =
    result.duration_ms !== undefined
      ? `, ${(result.duration_ms / 1000).toFixed(1)} s`
      : "";
  const files =
    edited.slice(0, 3).join(", ") +
    (edited.length > 3 ? ` (+${edited.length - 3} more)` : "");
  const header = [
    clip(
      `Level 0 verification FAILED after editing ${files} (${failing.length} of ${result.checks.length} checks failed${secs}).`,
      opts.maxLineLength,
    ),
    "Fix every finding before continuing; `task verify:text` prints the full report. Failing checks:",
    "",
  ];
  const hints = hintsFor(failing).map((h) => clip(h, opts.maxLineLength * 2));
  const tail = hints.length > 0 ? ["", ...hints] : [];
  // Reserve one line for a "... more checks" note.
  const budget = opts.maxLines - header.length - tail.length - 1;
  const body: string[] = [];
  let shown = 0;
  for (const c of failing) {
    const block = [
      clip(
        `FAIL ${c.name}${c.detail ? `: ${c.detail}` : ""}`,
        opts.maxLineLength,
      ),
    ];
    const f = c.findings ?? [];
    for (const line of f.slice(0, opts.maxFindings)) {
      block.push(clip(`  - ${line}`, opts.maxLineLength));
    }
    if (f.length > opts.maxFindings) {
      block.push(`  - ... ${f.length - opts.maxFindings} more finding(s)`);
    }
    if (body.length + block.length > budget) {
      // Always show at least the first check's name.
      if (shown === 0) body.push(block[0]);
      break;
    }
    body.push(...block);
    shown++;
  }
  const hidden = failing.length - Math.max(shown, body.length > 0 ? 1 : 0);
  if (hidden > 0) {
    body.push(`... ${hidden} more failing check(s): run \`task verify:text\``);
  }
  if (failing.length === 0) {
    body.push(
      "(no check has status fail, but `pass` is false; run `task verify:text`)",
    );
  }
  return [...header, ...body, ...tail].join("\n");
}

// ============================================================================
// Running level 0
// ============================================================================
export type RunOutcome =
  | { kind: "result"; result: VerifyResult }
  | { kind: "error"; message: string };

function tailLines(s: string, n: number): string {
  const lines = s.trimEnd().split("\n");
  return lines.slice(-n).join("\n");
}

function childEnv(): Record<string, string> {
  const home = process.env.HOME ?? "";
  const shims = `${home}/.local/share/mise/shims`;
  const path = process.env.PATH ?? "";
  let hasShims = false;
  try {
    hasShims = home !== "" && statSync(shims).isDirectory();
  } catch {
    hasShims = false;
  }
  // Hooks run from a non-interactive shell that may miss the mise shims
  // (go, helm, kubeconform, conftest, pluto are mise-managed).
  return hasShims && !path.split(":").includes(shims)
    ? { PATH: `${shims}:${path}` }
    : {};
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  deadline: number,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const remaining = Math.max(1, deadline - Date.now());
  const signal = AbortSignal.timeout(remaining);
  try {
    const p = Bun.spawn([cmd, ...args], {
      cwd,
      env: { ...process.env, ...childEnv() },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr, timedOut: signal.aborted };
  } catch (e) {
    if (signal.aborted) {
      return { code: -1, stdout: "", stderr: "", timedOut: true };
    }
    throw e;
  }
}

export async function runLevel0(
  root: string,
  binDir: string,
  timeoutMs = TIMEOUT_MS,
): Promise<RunOutcome> {
  const deadline = Date.now() + timeoutMs;
  const bin = `${binDir}/homelab`;
  mkdirSync(binDir, { recursive: true });
  let build: Awaited<ReturnType<typeof runCommand>>;
  try {
    build = await runCommand(
      "go",
      ["build", "-o", bin, "./cmd/homelab"],
      root,
      deadline,
    );
  } catch (e) {
    return {
      kind: "error",
      message: `cannot run go (${
        (e as Error).message
      }); is mise installed (\`mise install\`)?`,
    };
  }
  if (build.timedOut) {
    return {
      kind: "error",
      message: `go build did not finish within ${timeoutMs / 1000} s`,
    };
  }
  if (build.code !== 0) {
    return {
      kind: "error",
      message: `go build ./cmd/homelab failed:\n${tailLines(build.stderr, 20)}`,
    };
  }
  const run = await runCommand(
    bin,
    ["verify", "all", "--level", "0", "--json"],
    root,
    deadline,
  );
  if (run.timedOut) {
    return {
      kind: "error",
      message: `level 0 did not finish within ${
        timeoutMs / 1000
      } s; run \`task verify:text\``,
    };
  }
  try {
    return { kind: "result", result: parseVerifyResult(run.stdout) };
  } catch (e) {
    return {
      kind: "error",
      message: `level 0 exited ${run.code} without a JSON result (${
        (e as Error).message
      }):\n${tailLines(run.stderr, 20)}`,
    };
  }
}

// ============================================================================
// Main
// ============================================================================
const HELP = `claude-verify-hook.ts: Claude Code PostToolUse hook running level-0 verification

Reads the hook payload on stdin. Runs \`homelab verify all --level 0 --json\` in
$CLAUDE_PROJECT_DIR when the edited file is under charts/ or configuration/.
Silent on pass (exit 0); exit 2 with a failure summary on stderr otherwise.

Options:
  --dry-run   Print the decision (root, matched paths, lock), run nothing.
  --help, -h  This help.

Environment:
  CLAUDE_PROJECT_DIR     project root (set by Claude Code; default: payload cwd)
  HOMELAB_VERIFY_HOOK    off|0|false|no disables the hook`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const unknown = argv.filter((a) => !["--dry-run"].includes(a));
  if (unknown.length > 0) {
    log.error(`unknown argument: ${unknown[0]}`);
    return 1; // never 2: that would be read as verification feedback
  }

  if (hookDisabled(process.env.HOMELAB_VERIFY_HOOK)) {
    if (dryRun) {
      log.info("HOMELAB_VERIFY_HOOK disables the hook; nothing to do");
    }
    return 0;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await Bun.stdin.text());
  } catch (e) {
    // A malformed payload is not a verification failure; never disturb the agent for it.
    console.error(
      `claude-verify-hook: ignoring unreadable hook payload (${
        (e as Error).message
      })`,
    );
    return 0;
  }
  const payloadCwd = (payload as Record<string, unknown>)?.cwd;
  const cwd =
    typeof payloadCwd === "string" && payloadCwd !== ""
      ? payloadCwd
      : process.cwd();
  const root = process.env.CLAUDE_PROJECT_DIR || cwd;

  const edited = collectEditedPaths(payload);
  let watched = watchedPaths(edited, root, cwd);
  if (watched.length === 0 && edited.length > 0) {
    // Symlinked roots (macOS /tmp -> /private/tmp): compare real paths too.
    try {
      const realRoot = realpathSync(root);
      const real = edited.flatMap((p) => {
        try {
          return [realpathSync(p.startsWith("/") ? p : `${cwd}/${p}`)];
        } catch {
          return [];
        }
      });
      watched = watchedPaths(real, realRoot, cwd);
    } catch {
      // root does not exist: nothing to verify
    }
  }
  if (watched.length === 0) {
    if (dryRun) {
      log.info(
        `no edited path under ${WATCHED_DIRS.join(
          " or ",
        )} of ${root}; nothing to do`,
      );
    }
    return 0;
  }

  const key = fnv1a(root);
  const lock = `${tempDir()}/homelab-verify-hook-${key}.lock`;
  const binDir = `${tempDir()}/homelab-verify-hook-${key}`;
  if (dryRun) {
    log.info(`root: ${root}`);
    log.info(`matched: ${watched.join(", ")}`);
    log.info(`lock: ${lock}`);
    log.info(
      `would run: go build -o ${binDir}/homelab ./cmd/homelab && ${binDir}/homelab verify all --level 0 --json`,
    );
    return 0;
  }

  if (!tryAcquireLock(lock, Date.now())) return 0; // another run is verifying the same tree
  try {
    const outcome = await runLevel0(root, binDir);
    if (outcome.kind === "error") {
      console.error(
        `Level 0 verification could not run after editing ${watched.join(
          ", ",
        )}: ${outcome.message}`,
      );
      return 2;
    }
    if (outcome.result.pass) return 0;
    console.error(summarizeFailure(outcome.result, watched));
    return 2;
  } finally {
    releaseLock(lock);
  }
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (e) {
    log.error(`claude-verify-hook: ${(e as Error).message}`);
    process.exit(1);
  }
}
