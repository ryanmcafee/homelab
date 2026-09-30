#!/usr/bin/env bun

/**
 * fork-path-gate.ts
 *
 * Enforces the change-triggered half of fork-ability check 3a
 * (docs/contracts/fork-ability.md). The contract says check 3a runs "for any
 * change to bootstrap, secrets or identity"; until this gate existed that
 * sentence was prose, so a bootstrap regression was found by the weekly cron or
 * by a stranger, whichever came first.
 *
 * Run as a job in .github/workflows/verify.yml. It classifies the pull
 * request's changed files into two tiers and never boots a cluster:
 *
 *   Tier 1  the surface `.github/workflows/fork-path-cold.yml` actually
 *           executes (mise bootstrap, `task validate`, the localdev up/wait/
 *           report/down loop). A regression here is invisible to every static
 *           check — homelab#331, the `pipx:` backend pinned with no python/pipx
 *           pin, is the real-world instance. A Tier 1 hit FAILS unless it is
 *           discharged (below).
 *   Tier 2  genuinely "secrets or identity" under the contract, but the
 *           literal-leak class is already caught on every PR by level 0's
 *           render (checks 1 and 2), and for terragrunt/, talos/ and packer/
 *           by the config guard. Warn only: a sticky comment, never a
 *           failure.
 *
 * A Tier 1 hit is discharged by either of:
 *
 *   1. the PR body links a successful `fork-path-cold` run whose head SHA
 *      equals the PR head SHA, or
 *   2. the PR carries the label `fork-path: cold-run-waived` AND the body has a
 *      one-line reason.
 *
 * Route 2 is a deliberate, audited ten-second escape hatch. It is the point of
 * the gate: before it, nobody was ever recorded as having judged a bootstrap
 * change safe. After it, someone is — by name, in the pull request.
 *
 * Labels and the body are read from the REST API at run time, NOT from
 * $GITHUB_EVENT_PATH. That is deliberate: a workflow re-run replays the
 * ORIGINAL event payload, so an event-payload read would never see the label
 * the author just added, and "Re-run failed jobs" — the cheap way to discharge
 * without pushing a commit — could never turn the job green. The head SHA does
 * come from the event, because it identifies the commit these checks belong to
 * and must not drift under a re-run.
 *
 * Nothing here is specific to one operator, domain, cloud account or cluster:
 * the repository comes from GITHUB_REPOSITORY. The fork-ability contract
 * applies to the fork-ability gate itself.
 *
 * Usage:
 *   bun scripts/fork-path-gate.ts --base-sha <sha> --head-sha <sha> \
 *     [--pr <number>] [--repo <owner/name>] [--comment-file <path>]
 *
 * Exit codes: 0 = pass (or Tier 2 only); 1 = an undischarged Tier 1 hit;
 * 2 = argument or environment error.
 */

import { spawnSync } from "node:child_process";

/**
 * The label names the *act* — a cold run was waived — not the conclusion. A
 * label that asserts "not affected" can be wrong, permanently, and nothing ever
 * re-checks it; a waiver can only be unjustified, and the mandatory one-line
 * reason is what carries the justification.
 */
export const DISCHARGE_LABEL = "fork-path: cold-run-waived";
export const COLD_WORKFLOW_PATH = ".github/workflows/fork-path-cold.yml";

/**
 * Tier 1, minus Taskfile.yml which is conditional, and with readme.md
 * conditional on changes outside its badges region (see classify). This is
 * exactly the surface fork-path-cold.yml executes — not "everything
 * fork-related". terragrunt/, talos/, ansible/ and packer/ are real
 * fork-ability surface but check 3a executes none of them, and a gate that
 * demands a run which structurally cannot detect the regression is worse than
 * no gate.
 */
export const TIER1_PATHS = [
  "mise.toml",
  "localdev/**",
  "scripts/localdev-*.ts",
  "readme.md",
  "docs/tooling.md",
  "docs/local-development.md",
  COLD_WORKFLOW_PATH,
];

/**
 * The infrastructure trees check 3a never executes. The config guard reads them
 * for literal leaks; their Tier 2 note is for what no static check can see.
 */
export const TIER2_INFRA_PATHS = ["terragrunt/**", "talos/**", "packer/**"];

/** Tier 2 — warn only. */
export const TIER2_PATHS = [
  "configuration/environments/**",
  "charts/bootstrap/**",
  "charts/gitops/**",
  "charts/secrets/**",
  ".sops.yaml",
  "policy.sops.hujson",
  ".env.op",
  "docs/secrets.md",
  "docs/secrets-management.md",
  "docs/contracts/fork-ability.md",
  ...TIER2_INFRA_PATHS,
];

/** Conditional entries: see taskfileChangeReachesColdPath and readmeChangedOutsideBadges. */
export const TASKFILE = "Taskfile.yml";
export const README = "readme.md";

/**
 * The docs-check generated region holding the readme's version badges. Kept
 * literal rather than imported from docs-check.ts, whose YAML dependency would
 * need a `bun install` this job deliberately skips; a test pins the two equal.
 */
export const README_BADGES_BEGIN = "<!-- docs-check:begin badges -->";
export const README_BADGES_END = "<!-- docs-check:end badges -->";

export type Classification = { tier1: string[]; tier2: string[] };

/**
 * Translates the small glob dialect used above: `**` crosses directory
 * separators, `*` does not, everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * The tasks fork-path-cold.yml runs by name. `localdev:diagnose` runs on
 * failure, so a regression in it hides the evidence of every other one.
 */
export const COLD_PATH_TASKS = [
  "validate",
  "localdev:up",
  "localdev:wait",
  "localdev:report",
  "localdev:diagnose",
  "localdev:down",
];

type TaskSpan = { start: number; end: number; body: string[] };
type TaskfileLayout = {
  /** 1-based line numbers outside `tasks:`, which reach every task. */
  global: Set<number>;
  tasks: Map<string, TaskSpan>;
};

/**
 * Splits a Taskfile into its top-level sections and its tasks by indentation.
 *
 * A line scan rather than a YAML parse: the gate imports nothing outside the
 * standard library (see verify.yml), and go-task's own layout is fixed at two
 * spaces for a task name under `tasks:`.
 */
export function parseTaskfile(text: string): TaskfileLayout {
  const global = new Set<number>();
  const tasks = new Map<string, TaskSpan>();
  let inTasks = false;
  let current: TaskSpan | null = null;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^[^\s#]/.test(line)) {
      inTasks = /^tasks:\s*(#.*)?$/.test(line);
      current = null;
      global.add(n);
      return;
    }
    if (!inTasks) {
      global.add(n);
      return;
    }
    const name = /^ {2}([^\s#'"]\S*):\s*(#.*)?$/.exec(line)?.[1];
    if (name) {
      current = { start: n, end: n, body: [] };
      tasks.set(name, current);
      return;
    }
    if (/^ {0,2}#/.test(line)) {
      current = null;
      return;
    }
    if (current && line.trim() !== "") {
      current.end = n;
      current.body.push(line);
    }
  });
  return { global, tasks };
}

/**
 * Task names a task body calls: `task: x`, `deps: [x, y]`, a `deps:` block
 * list, and a shell `task x`. Over-matching only widens Tier 1, never hides a
 * change, so prose that happens to name a task is accepted.
 */
function referencedTasks(
  body: string[],
  known: Map<string, TaskSpan>,
): string[] {
  const refs = new Set<string>();
  let inDeps = false;
  for (const line of body) {
    const indent = line.length - line.trimStart().length;
    if (inDeps && indent <= 4) inDeps = false;
    const inline = /^\s*deps:\s*\[(.*)\]/.exec(line);
    if (inline) {
      for (const d of inline[1].split(",")) refs.add(d.trim());
    } else if (/^\s*deps:\s*$/.test(line)) {
      inDeps = true;
    } else if (inDeps) {
      const item = /^\s*-\s+([^\s{]+)\s*$/.exec(line);
      if (item) refs.add(item[1]);
    }
    for (const m of line.matchAll(/\btask:?\s+([A-Za-z0-9_:.-]+)/g))
      refs.add(m[1]);
  }
  return [...refs].filter((r) => known.has(r));
}

/** The cold entry points and every task they reach through calls or deps. */
export function coldPathTaskClosure(text: string): Set<string> {
  const { tasks } = parseTaskfile(text);
  const seen = new Set<string>();
  const queue = COLD_PATH_TASKS.filter((t) => tasks.has(t));
  while (queue.length > 0) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const span = tasks.get(name);
    if (span) queue.push(...referencedTasks(span.body, tasks));
  }
  return seen;
}

/** Changed line numbers from a unified diff: removed in the base, added in the head. */
export function changedTaskfileLines(diff: string): {
  base: number[];
  head: number[];
} {
  const base: number[] = [];
  const head: number[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of (diff ?? "").split(/\r?\n/)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (oldLine === 0 && newLine === 0) continue;
    if (line.startsWith("-")) base.push(oldLine++);
    else if (line.startsWith("+")) head.push(newLine++);
    else if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }
  return { base, head };
}

function reaches(lines: number[], text: string): boolean {
  const layout = parseTaskfile(text);
  const cold = coldPathTaskClosure(text);
  return lines.some((n) => {
    if (layout.global.has(n)) return true;
    for (const name of cold) {
      const span = layout.tasks.get(name);
      if (span && n >= span.start && n <= span.end) return true;
    }
    return false;
  });
}

export type TaskfileChange = {
  diff: string;
  baseText: string;
  headText: string;
};

/**
 * True when a Taskfile.yml change lands in a task fork-path-cold.yml runs, in
 * a task one of those reaches, or outside `tasks:` (vars and env reach every
 * task). Removed lines are placed in the base, added lines in the head.
 *
 * This is the narrowing that keeps the gate readable: most Taskfile changes
 * cannot reach the cold path, and a `paths:` glob cannot tell them apart. It
 * replaced a rule that matched the substring `localdev`, which fired on
 * `test:alerts` for naming `values-localdev.yaml` and missed a change to
 * `validate`, the first command the cold workflow runs.
 */
export function taskfileChangeReachesColdPath(change: TaskfileChange): boolean {
  const { base, head } = changedTaskfileLines(change.diff);
  return reaches(base, change.baseText) || reaches(head, change.headText);
}

/** The readme with the badges region body removed; the markers themselves stay. */
export function stripReadmeBadges(text: string): string {
  const begin = text.indexOf(README_BADGES_BEGIN);
  if (begin === -1) return text;
  const bodyStart = begin + README_BADGES_BEGIN.length;
  const end = text.indexOf(README_BADGES_END, bodyStart);
  if (end === -1) return text;
  return text.slice(0, bodyStart) + text.slice(end);
}

/**
 * True when readme.md changed anywhere outside the docs-check `badges` region.
 *
 * A version badge is regenerated from configuration/versions.yaml by
 * `docs:check -- --fix`, including by the Renovate regeneration bot, which can
 * neither link a cold run nor apply the waiver label. The badges are not a
 * command fork-path-cold.yml types, so a badge-only diff is not Tier 1. A file
 * added or deleted (null side), or a moved marker, still counts: the stripped
 * texts then differ.
 */
export function readmeChangedOutsideBadges(
  before: string | null,
  after: string | null,
): boolean {
  if (before === null || after === null) return true;
  return stripReadmeBadges(before) !== stripReadmeBadges(after);
}

export function classify(input: {
  files: readonly string[];
  taskfile?: TaskfileChange;
  /** Both sides of readme.md; absent means unknown, which stays Tier 1. */
  readme?: { before: string | null; after: string | null };
}): Classification {
  const tier1: string[] = [];
  const tier2: string[] = [];
  // Nothing to place the change with means nothing proves it misses the cold
  // path, so an unjudgeable Taskfile change is Tier 1.
  const taskfileHits =
    !input.taskfile ||
    input.taskfile.headText.trim() === "" ||
    taskfileChangeReachesColdPath(input.taskfile);
  const readmeHits = input.readme
    ? readmeChangedOutsideBadges(input.readme.before, input.readme.after)
    : true;
  for (const file of input.files) {
    const path = file.trim();
    if (path === "") continue;
    if (path === TASKFILE) {
      if (taskfileHits) tier1.push(path);
      continue;
    }
    if (path === README) {
      if (readmeHits) tier1.push(path);
      continue;
    }
    if (matchesAny(path, TIER1_PATHS)) {
      tier1.push(path);
      continue;
    }
    if (matchesAny(path, TIER2_PATHS)) tier2.push(path);
  }
  return { tier1: tier1.sort(), tier2: tier2.sort() };
}

export type RunLink = { owner: string; repo: string; runId: number };

/**
 * Every Actions run URL in the body, in order, deduplicated.
 *
 * A run in another repository is returned, and `decide` accepts it. That is
 * deliberate, not an oversight: a contributor working from a fork cannot
 * dispatch a workflow here, and the only discharge route open to them is a
 * `fork-path-cold` run in their own fork. The head SHA still has to match, and
 * a SHA is what the run proves — the owner of the runner that produced it is
 * not part of the claim. Do not "fix" this into an owner check; there is a test
 * pinning cross-repo acceptance.
 */
export function extractRunLinks(body: string): RunLink[] {
  const re =
    /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)/g;
  const seen = new Set<string>();
  const out: RunLink[] = [];
  for (const m of (body ?? "").matchAll(re)) {
    const key = `${m[1]}/${m[2]}#${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner: m[1], repo: m[2], runId: Number(m[3]) });
  }
  return out;
}

export function hasDischargeLabel(labels: readonly string[]): boolean {
  return labels.some(
    (l) => l.trim().toLowerCase() === DISCHARGE_LABEL.toLowerCase(),
  );
}

/**
 * The label text as it appears written in a body line, for stripping: the
 * literal label, tolerant of the space after the colon. Derived from
 * DISCHARGE_LABEL so a rename cannot leave the stripper matching the old name.
 */
const DISCHARGE_LABEL_RE = new RegExp(
  DISCHARGE_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(
    /:\s+/,
    ":?\\s*",
  ),
  "i",
);

/**
 * The one-line reason route 2 requires. A line mentioning `fork-path` that
 * still carries at least 15 non-space characters once list markers, emphasis,
 * the label text itself and any bare URL are stripped. URLs are stripped first
 * so that a line which is only a run link cannot masquerade as a reason.
 */
export function extractDischargeReason(body: string): string | null {
  for (const raw of (body ?? "").split(/\r?\n/)) {
    if (!/fork-path/i.test(raw)) continue;
    const stripped = raw
      .replace(/https?:\/\/\S+/g, "")
      .replace(/^[\s>*\-+]*/, "")
      .replace(/[*`_]/g, "")
      .replace(DISCHARGE_LABEL_RE, "")
      .replace(/^[\s:—–|-]+/, "")
      .trim();
    if (stripped.replace(/\s/g, "").length >= 15) return stripped;
  }
  return null;
}

export type RunFact = {
  runId: number;
  owner: string;
  repo: string;
  /** e.g. ".github/workflows/fork-path-cold.yml"; null when unresolvable. */
  workflowPath: string | null;
  /** "success", "failure", … or null while still running. */
  conclusion: string | null;
  headSha: string | null;
  /** Set when the run could not be read at all. */
  error?: string;
};

export type Decision = {
  verdict: "pass" | "fail";
  dischargedBy: "run" | "label" | null;
  /** Human-readable lines, most important first. */
  messages: string[];
};

/**
 * The whole verdict, as a pure function of facts already gathered. Every I/O
 * path in main() funnels into here so the decision is unit-testable without a
 * network, a clone or a pull request.
 */
export function decide(input: {
  classification: Classification;
  headSha: string;
  labels: readonly string[];
  body: string;
  runs: readonly RunFact[];
}): Decision {
  const { tier1 } = input.classification;
  if (tier1.length === 0) {
    return { verdict: "pass", dischargedBy: null, messages: [] };
  }

  const messages: string[] = [];

  // Route 1: a successful cold run at this exact head SHA.
  for (const run of input.runs) {
    if (
      run.workflowPath === COLD_WORKFLOW_PATH &&
      run.conclusion === "success" &&
      run.headSha === input.headSha
    ) {
      return {
        verdict: "pass",
        dischargedBy: "run",
        messages: [
          `Discharged by run ${run.runId}: \`fork-path-cold\` succeeded at ${input.headSha}.`,
        ],
      };
    }
  }

  // Say precisely why each linked run did not discharge. "You linked a run and
  // it still failed" with no reason is the failure mode that trains people to
  // ignore the gate.
  for (const run of input.runs) {
    if (run.error) {
      messages.push(`Run ${run.runId} could not be read: ${run.error}.`);
    } else if (run.workflowPath !== COLD_WORKFLOW_PATH) {
      messages.push(
        `Run ${run.runId} is \`${run.workflowPath ?? "unknown"}\`, not \`${COLD_WORKFLOW_PATH}\`.`,
      );
    } else if (run.headSha !== input.headSha) {
      messages.push(
        `Run ${run.runId} ran on head SHA \`${run.headSha ?? "unknown"}\`, but this pull request's head is \`${input.headSha}\`. A cold run proves the tree it ran on, not this one.`,
      );
    } else if (run.conclusion !== "success") {
      messages.push(
        `Run ${run.runId} concluded \`${run.conclusion ?? "in progress"}\`, not \`success\`.`,
      );
    }
  }

  // Route 2: label plus a one-line reason.
  const labelled = hasDischargeLabel(input.labels);
  const reason = extractDischargeReason(input.body);
  if (labelled && reason) {
    return {
      verdict: "pass",
      dischargedBy: "label",
      messages: [`Discharged by \`${DISCHARGE_LABEL}\`: ${reason}`],
    };
  }
  if (labelled && !reason) {
    messages.push(
      `The \`${DISCHARGE_LABEL}\` label is present but the body has no one-line reason. Add a line mentioning \`fork-path\` that says why the cold run can be waived.`,
    );
  }
  // The converse, and the one an outside contributor will actually produce:
  // the body is the only half of route 2 they can write. Without this they get
  // the generic help and no clue which half is missing.
  if (!labelled && reason) {
    messages.push(
      `A one-line reason is present but the \`${DISCHARGE_LABEL}\` label is not. Labelling needs write access to this repository — if you are contributing from a fork, say so in the pull request and a maintainer will apply it.`,
    );
  }

  return { verdict: "fail", dischargedBy: null, messages };
}

const TIER1_HELP = `
**How to clear this**

1. Run the cold fork path on this exact commit — the \`Fork path (cold, uncached)\`
   workflow has a **Run workflow** button (\`workflow_dispatch\`) — and paste the run
   URL into the pull request body. The run's head SHA must equal this pull
   request's head SHA. Cost: about 20 minutes, and it is the real check.

   Working from a fork? Dispatch it in **your** fork and link that run: a run in
   another repository is accepted, because the head SHA is what the run proves.
   You may have to enable Actions in your fork first.
2. Or waive the cold run: add the label \`${DISCHARGE_LABEL}\` and put a one-line
   reason in the body, for example

   > ${DISCHARGE_LABEL} — reworded a comment in docs/tooling.md; no command changed.

   Then re-run this check: press **Re-run failed jobs** if you have Actions
   write, or simply **close and reopen** this pull request if you do not —
   \`reopened\` is one of the events \`verify.yml\` listens for. Either way the
   label and body are read live from the API, not from the original event
   payload, so the re-run sees them and **no new commit is needed**.

**Contributing from a fork?** You cannot add a label or re-run a job here, and
that is expected — route 2 is a maintainer's recorded judgement, not yours.
Either link a \`fork-path-cold\` run from your own fork at this head SHA (route 1,
which does work from a fork), or just say in the pull request that you believe
the cold path is unaffected and why. A maintainer will apply the label. You are
not blocked on anything you have to learn about this repository first.
`.trim();

export const CONTRACT_PATH = "docs/contracts/fork-ability.md";

/**
 * A blob URL for a repository file, pinned to the commit being judged.
 *
 * A *relative* link is only rewritten to a repo path when GitHub renders a
 * file. In a comment body the href is emitted verbatim and the browser resolves
 * it against the pull-request page, which lands a logged-out reader on a login
 * page — so the runbook's single pointer to the normative document is worse
 * than absent. Server and repository come from the environment, so a fork links
 * its own copy, and pinning to the head SHA shows the contract as it stood on
 * the commit the gate is judging.
 */
export function blobUrl(input: {
  serverUrl: string;
  repoSlug: string;
  sha: string;
  path: string;
}): string {
  const server = (input.serverUrl || "https://github.com").replace(/\/+$/, "");
  if (!input.repoSlug) return input.path;
  return `${server}/${input.repoSlug}/blob/${input.sha}/${input.path}`;
}

export function renderComment(input: {
  classification: Classification;
  decision: Decision;
  headSha: string;
  serverUrl?: string;
  repoSlug?: string;
}): string | null {
  const { tier1, tier2 } = input.classification;
  if (tier1.length === 0 && tier2.length === 0) return null;
  const out: string[] = ["## Fork-ability check 3a — changed-path gate", ""];

  if (tier1.length > 0) {
    const ok = input.decision.verdict === "pass";
    out.push(
      ok
        ? "### Tier 1 (cold fork path) — discharged ✅"
        : "### Tier 1 (cold fork path) — action required ❌",
      "",
      "These files are executed by `.github/workflows/fork-path-cold.yml`, so a regression in them is invisible to every static check:",
      "",
      ...tier1.map((f) => `- \`${f}\``),
      "",
    );
    if (input.decision.messages.length > 0) {
      out.push(...input.decision.messages.map((m) => `> ${m}`), "");
    }
    if (!ok) out.push(TIER1_HELP, "");
  }

  if (tier2.length > 0) {
    const infra = tier2.filter((f) => matchesAny(f, TIER2_INFRA_PATHS));
    out.push(
      "### Tier 2 (secrets / identity) — advisory ⚠️",
      "",
      "Changed here, so worth a second look against the fork-ability contract. **This does not fail the check**.",
      "",
    );
    if (infra.length < tier2.length) {
      out.push(
        "For the configuration and secrets surface, the literal-leak class is already caught on every pull request by level 0's render against `configuration/environments/{localdev.yaml,homelab.yaml.example}` (checks 1 and 2).",
        "",
      );
    }
    if (infra.length > 0) {
      out.push(
        "`terragrunt/`, `talos/` and `packer/` are never executed by check 3a. The config guard (`task config:guard`) reads them for literal operator values; no static check can see what a fork must supply that these files assume. Check the change for undeclared hardware prerequisites, a fixed cluster topology shape, and secret-store or identity-provider assumptions.",
        "",
      );
    }
    out.push(...tier2.map((f) => `- \`${f}\``), "");
  }

  const contractUrl = blobUrl({
    serverUrl: input.serverUrl ?? "",
    repoSlug: input.repoSlug ?? "",
    sha: input.headSha,
    path: CONTRACT_PATH,
  });
  out.push(
    `<sub>Head SHA \`${input.headSha}\` · contract: [${CONTRACT_PATH}](${contractUrl}) · gate: \`scripts/fork-path-gate.ts\`</sub>`,
  );
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${r.status}): ${(r.stderr ?? "").trim()}`,
    );
  }
  return r.stdout ?? "";
}

/** A blob at `rev:path`, or null when that side of the diff has no such file. */
function gitShowOrNull(spec: string): string | null {
  const r = spawnSync("git", ["show", spec], { encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : null;
}

async function api(
  path: string,
  token: string,
  apiBase: string,
): Promise<unknown> {
  const res = await fetch(`${apiBase}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function main(): Promise<number> {
  const baseSha = arg("base-sha");
  const headSha = arg("head-sha");
  if (!baseSha || !headSha) {
    console.error("usage: fork-path-gate.ts --base-sha <sha> --head-sha <sha>");
    return 2;
  }

  const repoSlug = arg("repo") ?? process.env.GITHUB_REPOSITORY ?? "";
  const [owner, repo] = repoSlug.split("/");
  const prNumber = Number(arg("pr") ?? process.env.PR_NUMBER ?? "0");
  const token = process.env.GITHUB_TOKEN ?? "";
  const apiBase = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const commentFile = arg("comment-file") ?? "fork-path-gate-comment.md";

  // The changed set, against the merge base with the target branch.
  const range = `${baseSha}...${headSha}`;
  const files = git(["diff", "--name-only", range]).split("\n");
  const mergeBase = git(["merge-base", baseSha, headSha]).trim();
  const taskfile = files.includes(TASKFILE)
    ? {
        diff: git(["diff", "-U0", range, "--", TASKFILE]),
        baseText: gitShowOrNull(`${mergeBase}:${TASKFILE}`) ?? "",
        headText: gitShowOrNull(`${headSha}:${TASKFILE}`) ?? "",
      }
    : undefined;
  const readme = files.includes(README)
    ? {
        before: gitShowOrNull(`${mergeBase}:${README}`),
        after: gitShowOrNull(`${headSha}:${README}`),
      }
    : undefined;
  const classification = classify({ files, taskfile, readme });

  // Labels and body live on the API, not the replayed event payload.
  let labels: string[] = [];
  let body = "";
  if (classification.tier1.length > 0 && owner && repo && prNumber > 0) {
    const pr = (await api(
      `/repos/${owner}/${repo}/pulls/${prNumber}`,
      token,
      apiBase,
    )) as { body?: string | null; labels?: { name: string }[] };
    body = pr.body ?? "";
    labels = (pr.labels ?? []).map((l) => l.name);
  }

  const runs: RunFact[] = [];
  for (const link of extractRunLinks(body)) {
    try {
      const run = (await api(
        `/repos/${link.owner}/${link.repo}/actions/runs/${link.runId}`,
        token,
        apiBase,
      )) as { path?: string; conclusion?: string | null; head_sha?: string };
      runs.push({
        runId: link.runId,
        owner: link.owner,
        repo: link.repo,
        workflowPath: run.path ?? null,
        conclusion: run.conclusion ?? null,
        headSha: run.head_sha ?? null,
      });
    } catch (e) {
      runs.push({
        runId: link.runId,
        owner: link.owner,
        repo: link.repo,
        workflowPath: null,
        conclusion: null,
        headSha: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const decision = decide({
    classification,
    headSha,
    labels,
    body,
    runs,
  });

  const comment = renderComment({
    classification,
    decision,
    headSha,
    serverUrl: process.env.GITHUB_SERVER_URL ?? "",
    repoSlug,
  });
  if (comment) await Bun.write(commentFile, `${comment}\n`);

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    await Bun.write(
      summary,
      `${comment ?? "## Fork-ability check 3a — changed-path gate\n\nNo Tier 1 or Tier 2 path changed."}\n`,
    );
  }

  console.log(`tier1: ${classification.tier1.join(", ") || "(none)"}`);
  console.log(`tier2: ${classification.tier2.join(", ") || "(none)"}`);
  for (const m of decision.messages) console.log(m);

  if (decision.verdict === "fail") {
    console.log(
      `::error title=Fork-ability check 3a::${classification.tier1.length} Tier 1 path(s) changed with no cold fork-path run at ${headSha} and no '${DISCHARGE_LABEL}' label with a reason. See the job summary.`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
