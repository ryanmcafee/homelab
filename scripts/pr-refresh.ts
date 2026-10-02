#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REGEN_STEPS } from "./renovate-regen.ts";

/**
 * pr-refresh.ts
 *
 * Bring a stale PR branch up to date with its base: merge the base in, resolve
 * the conflicts that are not real disagreements, regenerate what the merge made
 * stale, prove level 0 still passes, and commit the merge.
 *
 * Why. Measured on 2026-10-02: 29 of 86 open PRs conflicted with their base,
 * and a handful of files carried most of it -- docs/runbooks/verification.md
 * (7 PRs), readme.md and .github/homelab.svg (6 each), the bugs.md and
 * issues.md logs and the golden snapshots (4 each). Almost none of those were
 * disagreements: concurrent PRs appended an entry at the same spot, or both
 * moved a count that docs:check computes anyway.
 *
 * What it resolves, and how:
 *   union files       .gitattributes `merge=union` (the append-only logs and
 *                     the verification runbook). The merge runs with the BASE
 *                     branch's attributes (`git --attr-source`): a PR cut
 *                     before .gitattributes existed would otherwise merge
 *                     without them. Every file the union rule resolved is
 *                     listed for review, because two edits to the same line
 *                     come out as two lines instead of a conflict.
 *   generated files   tests/snapshots/, tests/schemas/, the values-localdev
 *                     files: take the base side, then regenerate.
 *   count-only hunks  readme.md, .github/homelab.svg, docs/applications.md,
 *                     docs/networking.md: a hunk whose sides differ only in
 *                     numbers docs:check owns, or that sits inside a
 *                     docs-check region, takes the base side and docs:check
 *                     --fix rewrites it. The SVG suite counter is not fixable,
 *                     so a file docs:check still reports afterwards is retried
 *                     with the PR side, and the run stops if neither is true.
 *   anything else     left conflicted for a human; rerun with --continue.
 *
 * Never on renovate/* branches: a commit there by anybody but the regeneration
 * bot makes Renovate stop rebasing the branch (renovate-regen.ts). Use the
 * rebase checkbox on the PR instead.
 *
 * GitHub's merge button and "Update branch" ignore merge attributes, so a PR
 * can still read "conflicts" on github.com that this script resolves locally.
 *
 *   task pr:refresh                           merge origin/main into this branch
 *   task pr:refresh -- --base origin/feat/x   a stacked PR: merge its own base
 *   task pr:refresh -- --dry-run              classify the conflicts, write nothing
 *   task pr:refresh -- --continue             after resolving the rest by hand
 *   task pr:refresh -- --push                 push the branch after committing
 *   task pr:refresh -- --no-verify            commit even when level 0 fails
 *   task pr:refresh -- --no-fetch             do not fetch the base first
 */

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/** Fully generated: any conflict takes the base side and is regenerated. */
export const GENERATED_CONFLICT_PATHS = [
  "tests/snapshots/",
  "tests/schemas/",
  "charts/addons/values-localdev.yaml",
  "charts/applications/values-localdev.yaml",
];

/** Partly generated: docs:check owns some of their numbers and regions. */
export const COUNT_FILES = [
  "readme.md",
  ".github/homelab.svg",
  "docs/applications.md",
  "docs/networking.md",
];

/** git's well-known empty tree: as an attribute source it means "no attributes". */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The numbers docs:check owns (docs-check.ts expectedLiterals). A line
 * matching a `line` pattern is generated whole -- the SVG suite counter: one
 * keyframe, one animation class and one text element per suite, rewritten
 * together whenever the suite count moves -- so its content never blocks a
 * resolution. Elsewhere only the digits inside a `phrase` match are owned, so
 * a hand-written number on the same line still does.
 */
const OWNED: Record<string, { line: RegExp[]; phrase: RegExp[] }> = {
  "readme.md": {
    line: [],
    phrase: [
      /\b\d+ addons\b/g,
      /\b\d+ applications\b/g,
      /\b\d+ Applications synced from your working tree\b/g,
      /\b\d+ ArgoCD Applications\b/g,
      /\b\d+ chainsaw suites\b/g,
    ],
  },
  ".github/homelab.svg": {
    line: [
      /@keyframes c\d+\{/,
      /e2e suite counter/,
      /\.c\d+\{animation:c\d+ /,
      /<text class="c\d+"/,
    ],
    phrase: [/addons · \d+/g, /applications · \d+/g, /\d+ apps synced/g],
  },
};

const REGION_BEGIN = /<!-- docs-check:begin [\w-]+ -->/;
const REGION_END = /<!-- docs-check:end [\w-]+ -->/;

const inList = (path: string, list: string[]) =>
  list.some((g) => (g.endsWith("/") ? path.startsWith(g) : path === g));

export type ConflictClass = "generated" | "counts" | "manual";

export function classifyPath(path: string): ConflictClass {
  if (inList(path, GENERATED_CONFLICT_PATHS)) return "generated";
  if (inList(path, COUNT_FILES)) return "counts";
  return "manual";
}

/** Replaces the numbers docs:check owns with `#`; leaves every other byte. */
export function maskOwned(path: string, line: string): string {
  const owned = OWNED[path];
  if (!owned) return line;
  if (owned.line.some((re) => re.test(line))) {
    return line.replace(/\d+(\.\d+)?/g, "#");
  }
  let out = line;
  for (const re of owned.phrase) {
    out = out.replace(re, (m) => m.replace(/\d+/g, "#"));
  }
  return out;
}

export interface Hunk {
  ours: string[];
  theirs: string[];
  /** Inside a `docs-check:begin/end` region, which --fix replaces whole. */
  inRegion: boolean;
  /** A region marker inside the hunk: never resolved automatically. */
  touchesMarker: boolean;
}

export type Segment = string | Hunk;

/**
 * Splits a conflicted file into context lines and hunks. Understands the
 * `merge` and `diff3`/`zdiff3` styles (the base section is dropped). Returns
 * null when the markers do not pair up.
 */
export function parseConflicts(text: string): Segment[] | null {
  const segments: Segment[] = [];
  let hunk: Hunk | null = null;
  let part: "ours" | "base" | "theirs" = "ours";
  let inRegion = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("<<<<<<< ") || line === "<<<<<<<") {
      if (hunk) return null;
      hunk = { ours: [], theirs: [], inRegion, touchesMarker: false };
      part = "ours";
    } else if (hunk && (line.startsWith("||||||| ") || line === "|||||||")) {
      part = "base";
    } else if (hunk && line === "=======") {
      part = "theirs";
    } else if (line.startsWith(">>>>>>> ") || line === ">>>>>>>") {
      if (!hunk || part !== "theirs") return null;
      segments.push(hunk);
      hunk = null;
    } else if (hunk) {
      if (REGION_BEGIN.test(line) || REGION_END.test(line)) {
        hunk.touchesMarker = true;
      }
      if (part === "ours") hunk.ours.push(line);
      else if (part === "theirs") hunk.theirs.push(line);
    } else {
      if (REGION_BEGIN.test(line)) inRegion = true;
      if (REGION_END.test(line)) inRegion = false;
      segments.push(line);
    }
  }
  return hunk ? null : segments;
}

function multiset(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

function sameKeys(a: Map<string, number>, b: Map<string, number>): boolean {
  return a.size === b.size && [...a.keys()].every((k) => b.has(k));
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  return sameKeys(a, b) && [...a].every(([k, n]) => b.get(k) === n);
}

/**
 * True when the two sides of a hunk differ only in what docs:check owns.
 * Whole generated lines (the SVG suite counter) are ignored; lines with an
 * owned phrase compare as sets once masked; every other line must appear the
 * same number of times on each side.
 */
export function isCountOnly(path: string, h: Hunk): boolean {
  if (h.touchesMarker) return false;
  if (h.inRegion && path.endsWith(".md")) return true;
  const owned = OWNED[path];
  if (!owned) return false;
  const split = (lines: string[]) => {
    const phrase: string[] = [];
    const plain: string[] = [];
    for (const l of lines) {
      if (owned.line.some((re) => re.test(l))) continue;
      const m = maskOwned(path, l);
      (m === l ? plain : phrase).push(m);
    }
    return { phrase: multiset(phrase), plain: multiset(plain) };
  };
  const a = split(h.ours);
  const b = split(h.theirs);
  return sameKeys(a.phrase, b.phrase) && sameCounts(a.plain, b.plain);
}

/**
 * Resolves every hunk to one side when all of them are count-only; null when
 * any hunk carries a real change (or the markers are malformed).
 * `theirs` is the base branch: the merge runs on the PR branch.
 */
export function resolveCountConflicts(
  path: string,
  text: string,
  side: "ours" | "theirs",
): string | null {
  const segments = parseConflicts(text);
  if (!segments) return null;
  const out: string[] = [];
  for (const s of segments) {
    if (typeof s === "string") out.push(s);
    else if (!isCountOnly(path, s)) return null;
    else out.push(...s[side]);
  }
  return out.join("\n");
}

/**
 * A union merge keeps one copy of the blank line both sides share, so two
 * entries appended at the same spot come out with the second heading glued to
 * the first entry's last line. Restores the blank line before every Markdown
 * heading, outside code fences; a file that already has them is unchanged.
 */
export function spaceHeadings(text: string): string {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const prev = out[out.length - 1];
    if (!fence && /^#{1,6} /.test(line) && prev !== undefined && prev.trim()) {
      out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Paths a `.gitattributes` text merges with `merge=union`. */
export function parseUnionPaths(gitattributes: string): string[] {
  return gitattributes
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/))
    .filter(([, ...attrs]) => attrs.includes("merge=union"))
    .map(([path]) => path);
}

/** `git --attr-source` arrived in git 2.40. */
export function gitSupportsAttrSource(versionOutput: string): boolean {
  const m = versionOutput.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 40);
}

export function branchGuardError(branch: string, base: string): string | null {
  if (branch === "HEAD") {
    return "pr-refresh/branch: HEAD is detached; check out the PR branch first.";
  }
  if (branch.startsWith("renovate/")) {
    return [
      `pr-refresh/renovate: ${branch} is Renovate's.`,
      "  A merge commit by anybody but the regeneration bot makes Renovate treat the",
      "  branch as human-edited and stop rebasing it for good (renovate-regen.ts).",
      "  Tick the rebase checkbox in the PR body instead; Renovate rebases it.",
    ].join("\n");
  }
  if (branch === base.replace(/^[^/]+\//, "") || branch === base) {
    return `pr-refresh/branch: ${branch} is the base itself; check out the PR branch.`;
  }
  return null;
}

export interface Args {
  base: string;
  dryRun: boolean;
  cont: boolean;
  push: boolean;
  fetch: boolean;
  verify: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    base: "origin/main",
    dryRun: false,
    cont: false,
    push: false,
    fetch: true,
    verify: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--base") a.base = argv[++i] ?? "";
    else if (x.startsWith("--base=")) a.base = x.slice("--base=".length);
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--continue") a.cont = true;
    else if (x === "--push") a.push = true;
    else if (x === "--no-fetch") a.fetch = false;
    else if (x === "--no-verify") a.verify = false;
    else if (x === "--help" || x === "-h") a.help = true;
    else throw new Error(`unknown argument: ${x}`);
  }
  if (!a.base) throw new Error("--base needs a ref");
  if (a.dryRun && a.cont) throw new Error("--dry-run and --continue conflict");
  return a;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function exec(
  cmd: string[],
  opts: { cwd?: string; quiet?: boolean } = {},
): Promise<Result> {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: "ignore",
    stdout: opts.quiet === false ? "inherit" : "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    p.stdout ? new Response(p.stdout).text() : Promise.resolve(""),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

async function must(cmd: string[], cwd?: string): Promise<string> {
  const r = await exec(cmd, { cwd });
  if (r.code !== 0) {
    throw new Error(`Command failed: ${cmd.join(" ")}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

const git = (cwd: string, ...args: string[]) => must(["git", ...args], cwd);

/** Via rev-parse, not a path: in a worktree `.git` is a file. */
async function merging(cwd: string): Promise<boolean> {
  const r = await exec(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    cwd,
  });
  return r.code === 0;
}

async function unmergedPaths(cwd: string): Promise<string[]> {
  const out = await must(
    ["git", "diff", "--name-only", "--diff-filter=U", "-z"],
    cwd,
  );
  return [...new Set(out.split("\0").filter(Boolean))];
}

/** The union paths the base branch declares. */
async function baseUnionPaths(cwd: string, base: string): Promise<string[]> {
  const r = await exec(["git", "show", `${base}:.gitattributes`], { cwd });
  return r.code === 0 ? parseUnionPaths(r.stdout) : [];
}

/**
 * Files that conflict between `ours` and `theirs` under the given attribute
 * source (`git merge-tree`, no worktree change).
 */
export async function wouldConflict(
  cwd: string,
  ours: string,
  theirs: string,
  attrSource: string,
): Promise<{ tree: string; paths: string[] }> {
  const r = await exec(
    [
      "git",
      `--attr-source=${attrSource}`,
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      ours,
      theirs,
    ],
    { cwd },
  );
  if (r.code > 1) throw new Error(`git merge-tree failed:\n${r.stderr}`);
  const [tree, ...paths] = r.stdout.trim().split("\n").filter(Boolean);
  return { tree, paths: r.code === 1 ? [...new Set(paths)] : [] };
}

/** Union files the merge resolved that a plain merge would have conflicted on. */
export async function unionResolved(
  cwd: string,
  ours: string,
  theirs: string,
  unionPaths: string[],
): Promise<string[]> {
  if (unionPaths.length === 0) return [];
  const plain = await wouldConflict(cwd, ours, theirs, EMPTY_TREE);
  return plain.paths.filter((p) => unionPaths.includes(p));
}

export interface MergeOutcome {
  upToDate: boolean;
  generated: string[];
  /** Count files resolved to the base side, with their conflicted text. */
  counts: Map<string, string>;
  manual: string[];
}

/**
 * Merges `base` into the checked-out branch with the base's attributes and
 * resolves every conflict that is not a disagreement. Leaves the merge
 * uncommitted; `manual` lists what a human still has to resolve.
 */
export async function mergeAndResolve(
  cwd: string,
  base: string,
): Promise<MergeOutcome> {
  const out: MergeOutcome = {
    upToDate: false,
    generated: [],
    counts: new Map(),
    manual: [],
  };
  const merge = await exec(
    [
      "git",
      `--attr-source=${base}`,
      "merge",
      "--no-ff",
      "--no-commit",
      "--no-edit",
      base,
    ],
    { cwd },
  );
  if (merge.code === 0) {
    out.upToDate = !(await merging(cwd));
    return out;
  }
  const unmerged = await unmergedPaths(cwd);
  if (unmerged.length === 0) {
    throw new Error(`git merge failed:\n${merge.stderr}${merge.stdout}`);
  }
  for (const path of unmerged) {
    const kind = classifyPath(path);
    if (kind === "generated") {
      const hasBase = await exec(["git", "cat-file", "-e", `${base}:${path}`], {
        cwd,
      });
      if (hasBase.code === 0) {
        await git(cwd, "checkout", "--theirs", "--", path);
        await git(cwd, "add", "--", path);
      } else {
        await git(cwd, "rm", "--quiet", "--", path);
      }
      out.generated.push(path);
      continue;
    }
    if (kind === "counts" && existsSync(join(cwd, path))) {
      const text = await readFile(join(cwd, path), "utf8");
      const resolved = resolveCountConflicts(path, text, "theirs");
      if (resolved !== null) {
        await writeFile(join(cwd, path), resolved);
        await git(cwd, "add", "--", path);
        out.counts.set(path, text);
        continue;
      }
    }
    out.manual.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Regeneration
// ---------------------------------------------------------------------------

interface DocsDrift {
  file: string;
  what: string;
  fixable: boolean;
}

async function docsFix(): Promise<DocsDrift[]> {
  const r = await exec(["bun", "scripts/docs-check.ts", "--fix", "--json"]);
  if (r.code === 0) return [];
  try {
    // --fix prints "fixed <file>" lines ahead of the JSON report.
    const json = r.stdout.slice(r.stdout.search(/^\{/m));
    return (JSON.parse(json) as { drift: DocsDrift[] }).drift;
  } catch {
    throw new Error(`docs-check failed:\n${r.stderr}${r.stdout}`);
  }
}

/**
 * Runs renovate-regen's REGEN_STEPS (schemas only when a schema conflicted:
 * vendoring reads the GitHub API), with docs:check in place of its step so a
 * count file docs:check cannot fix is retried with the PR side.
 */
async function regenerate(
  outcome: MergeOutcome,
  cwd: string,
): Promise<string | null> {
  const schemas = outcome.generated.some((p) => p.startsWith("tests/schemas/"));
  for (const step of REGEN_STEPS) {
    if (step.cmd.includes("schemas:vendor") && !schemas) continue;
    if (step.cmd.includes("docs:check")) {
      console.log(cyan(`==> ${step.desc}: bun scripts/docs-check.ts --fix`));
      let drift = await docsFix();
      const retry = drift
        .map((d) => d.file)
        .filter((f, i, all) => all.indexOf(f) === i && outcome.counts.has(f));
      for (const f of retry) {
        const ours = resolveCountConflicts(
          f,
          outcome.counts.get(f) ?? "",
          "ours",
        );
        if (ours === null) continue;
        console.log(
          yellow(`    ${f}: base side is not true here, using the PR side`),
        );
        await writeFile(join(cwd, f), ours);
      }
      if (retry.length) drift = await docsFix();
      if (drift.length) {
        return [
          "pr-refresh/docs-check: docs:check still reports drift --fix cannot repair:",
          ...drift.map((d) => `  ${d.file}: ${d.what}`),
          "  Fix it by hand (the SVG suite counter is regenerated by hand), then",
          "  task pr:refresh -- --continue",
        ].join("\n");
      }
      continue;
    }
    console.log(cyan(`==> ${step.desc}: ${step.cmd.join(" ")}`));
    const r = await exec(step.cmd, { cwd, quiet: false });
    if (r.code !== 0)
      return `pr-refresh/regen: ${step.desc} failed\n${r.stderr}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HELP = `usage: task pr:refresh -- [--base <ref>] [--dry-run | --continue] [--push] [--no-fetch] [--no-verify]

Merge the base branch (default origin/main) into the checked-out PR branch,
resolve the conflicts that are not disagreements, regenerate, run level 0 and
commit. See the header of scripts/pr-refresh.ts.`;

function printUnion(paths: string[]) {
  if (paths.length === 0) return;
  console.log(
    yellow(
      "[REVIEW] merge=union kept both sides of these; check no line was edited on both:",
    ),
  );
  for (const p of paths)
    console.log(`      ${p}   (git diff HEAD^1 HEAD -- ${p})`);
}

async function dryRun(cwd: string, base: string): Promise<void> {
  const union = await baseUnionPaths(cwd, base);
  const merged = await wouldConflict(cwd, "HEAD", base, base);
  if (merged.paths.length === 0) {
    console.log(`${green("[OK]")} merges cleanly with ${base}`);
  }
  for (const path of merged.paths) {
    let kind: ConflictClass = classifyPath(path);
    if (kind === "counts") {
      const text = await exec(["git", "show", `${merged.tree}:${path}`], {
        cwd,
      });
      if (resolveCountConflicts(path, text.stdout, "theirs") === null) {
        kind = "manual";
      }
    }
    const label =
      kind === "manual" ? red("manual   ") : green(kind.padEnd(9, " "));
    console.log(`  ${label} ${path}`);
  }
  printUnion(await unionResolved(cwd, "HEAD", base, union));
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(Bun.argv.slice(2));
  } catch (e) {
    console.error(red(`pr-refresh: ${(e as Error).message}`));
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const cwd = process.cwd();
  const version = await git(cwd, "--version");
  if (!gitSupportsAttrSource(version)) {
    console.error(
      red(
        `pr-refresh/git: ${version} lacks --attr-source; git 2.40+ is needed.`,
      ),
    );
    return 1;
  }
  const branch = await git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
  const guard = branchGuardError(branch, args.base);
  if (guard) {
    console.error(red(guard));
    return 1;
  }
  const inMerge = await merging(cwd);

  let outcome: MergeOutcome = {
    upToDate: false,
    generated: [],
    counts: new Map(),
    manual: [],
  };
  if (args.cont) {
    if (!inMerge) {
      console.error(red("pr-refresh/continue: no merge in progress."));
      return 1;
    }
    const left = await unmergedPaths(cwd);
    if (left.length) {
      console.error(red("pr-refresh/continue: still unmerged:"));
      for (const p of left) console.error(`      ${p}`);
      return 1;
    }
  } else {
    if (inMerge) {
      console.error(
        red(
          "pr-refresh: a merge is already in progress; finish it and pass --continue, or git merge --abort.",
        ),
      );
      return 1;
    }
    const dirty = await git(
      cwd,
      "status",
      "--porcelain",
      "--untracked-files=no",
    );
    if (dirty) {
      console.error(
        red(`pr-refresh/clean-tree: commit or stash first:\n${dirty}`),
      );
      return 1;
    }
    const remote = args.base.match(/^([^/]+)\/(.+)$/);
    if (args.fetch && remote) {
      console.log(cyan(`==> git fetch ${remote[1]} ${remote[2]}`));
      await git(cwd, "fetch", "--quiet", remote[1], remote[2]);
    }
    if (args.dryRun) {
      await dryRun(cwd, args.base);
      return 0;
    }
    console.log(cyan(`==> merging ${args.base} into ${branch}`));
    outcome = await mergeAndResolve(cwd, args.base);
    if (outcome.upToDate) {
      console.log(`${green("[OK]")} ${branch} already contains ${args.base}`);
      return 0;
    }
    for (const p of outcome.generated) {
      console.log(`${green("[OK]")} generated, regenerating: ${p}`);
    }
    for (const p of outcome.counts.keys()) {
      console.log(`${green("[OK]")} count-only conflicts: ${p}`);
    }
    if (outcome.manual.length) {
      console.error(red("[MANUAL] real conflicts, resolve and git add them:"));
      for (const p of outcome.manual) console.error(`      ${p}`);
      console.error(
        cyan("then: task pr:refresh -- --continue (or git merge --abort)"),
      );
      return 1;
    }
  }

  const regenError = await regenerate(outcome, cwd);
  if (regenError) {
    // Stage what regeneration wrote: `git merge --abort` refuses a dirty
    // worktree, and --continue picks the staged state up as it is.
    await git(cwd, "add", "-u");
    console.error(red(regenError));
    console.error(cyan("or give up: git merge --abort"));
    return 1;
  }
  const union = await unionResolved(
    cwd,
    "HEAD",
    "MERGE_HEAD",
    await baseUnionPaths(cwd, "MERGE_HEAD"),
  );
  for (const p of union.filter((f) => f.endsWith(".md"))) {
    const text = await readFile(join(cwd, p), "utf8");
    const spaced = spaceHeadings(text);
    if (spaced !== text) await writeFile(join(cwd, p), spaced);
  }
  await git(cwd, "add", "-u");
  await git(
    cwd,
    "add",
    "-A",
    "--",
    ...GENERATED_CONFLICT_PATHS.filter((p) => existsSync(join(cwd, p))),
  );
  const markers = await exec(
    ["git", "grep", "--cached", "-l", "-E", "^(<<<<<<<|>>>>>>>) "],
    { cwd },
  );
  if (markers.stdout.trim()) {
    console.error(
      red(`pr-refresh/markers: conflict markers remain:\n${markers.stdout}`),
    );
    return 1;
  }

  if (args.verify) {
    console.log(cyan("==> level 0: task verify:text"));
    const r = await exec(["task", "verify:text"], { cwd, quiet: false });
    if (r.code !== 0) {
      console.error(
        red(
          "pr-refresh/level-0: level 0 fails on the merge result; the merge is staged, not committed.\n" +
            "  Fix it and rerun with --continue, or --no-verify when the failure predates the merge.",
        ),
      );
      return 1;
    }
  }

  await git(cwd, "commit", "--no-edit", "--quiet");
  const head = await git(cwd, "rev-parse", "--short", "HEAD");
  console.log(`${green("[OK]")} merged ${args.base} into ${branch} at ${head}`);
  printUnion(union);

  if (args.push) {
    console.log(cyan(`==> git push origin HEAD:${branch}`));
    await git(cwd, "push", "--quiet", "origin", `HEAD:${branch}`);
    console.log(`${green("[OK]")} pushed ${branch}`);
  }
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(red(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    });
}
