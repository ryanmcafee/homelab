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
 *           render (checks 1 and 2). Warn only: a sticky comment, never a
 *           failure.
 *
 * A Tier 1 hit is discharged by either of:
 *
 *   1. the PR body links a successful `fork-path-cold` run whose head SHA
 *      equals the PR head SHA, or
 *   2. the PR carries the label `fork-path: not-affected` AND the body has a
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

export const DISCHARGE_LABEL = "fork-path: not-affected";
export const COLD_WORKFLOW_PATH = ".github/workflows/fork-path-cold.yml";

/**
 * Tier 1, minus Taskfile.yml which is conditional (see classify). This is
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
];

/** The one conditional entry: see taskfileDiffTouchesLocaldev. */
export const TASKFILE = "Taskfile.yml";

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
 * True when the Taskfile.yml diff adds or removes a line mentioning localdev.
 *
 * This is the measured narrowing the gate exists to make: 20 of the last 92
 * commits on main touch Taskfile.yml, but only 5 touch a line containing
 * `localdev`. A `paths:` glob cannot tell those apart; a diff test can, and it
 * is the difference between a gate that fires on 35% of pull requests and one
 * that fires on 51%.
 *
 * `+++ b/Taskfile.yml` / `--- a/Taskfile.yml` are headers, not content, and are
 * skipped — the path itself never counts as a hit.
 */
export function taskfileDiffTouchesLocaldev(diff: string): boolean {
  for (const line of (diff ?? "").split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line[0] !== "+" && line[0] !== "-") continue;
    if (/localdev/i.test(line)) return true;
  }
  return false;
}

export function classify(input: {
  files: readonly string[];
  taskfileDiff?: string;
}): Classification {
  const tier1: string[] = [];
  const tier2: string[] = [];
  const taskfileHits = taskfileDiffTouchesLocaldev(input.taskfileDiff ?? "");
  for (const file of input.files) {
    const path = file.trim();
    if (path === "") continue;
    if (path === TASKFILE) {
      if (taskfileHits) tier1.push(path);
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
 * Every Actions run URL in the body, in order, deduplicated. A run link in
 * another repository is returned too so the caller can reject it by name
 * rather than silently ignoring it.
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
      .replace(/fork-path:?\s*not-affected/i, "")
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
      `The \`${DISCHARGE_LABEL}\` label is present but the body has no one-line reason. Add a line mentioning \`fork-path\` that says why check 3a is not affected.`,
    );
  }

  return { verdict: "fail", dischargedBy: null, messages };
}

const TIER1_HELP = `
**How to clear this**

1. Run the cold fork path on this exact commit — the \`Fork path (cold, uncached)\`
   workflow has a **Run workflow** button (\`workflow_dispatch\`) — and paste the run
   URL into the pull request body. The run's head SHA must equal this pull
   request's head SHA. Cost: about 19 minutes, and it is the real check.
2. Or judge the change not to affect the cold path: add the label
   \`${DISCHARGE_LABEL}\` and put a one-line reason in the body, for example

   > fork-path: not-affected — reworded a comment in docs/tooling.md; no command changed.

   Then re-run this check: press **Re-run failed jobs** if you have Actions
   write, or simply **close and reopen** this pull request if you do not —
   \`reopened\` is one of the events \`verify.yml\` listens for. Either way the
   label and body are read live from the API, not from the original event
   payload, so the re-run sees them and **no new commit is needed**.

Route 2 is deliberate and audited. It is not a bypass to be embarrassed about —
it is the decision point this gate exists to create, and your name is on it.
`.trim();

export function renderComment(input: {
  classification: Classification;
  decision: Decision;
  headSha: string;
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
    out.push(
      "### Tier 2 (secrets / identity) — advisory ⚠️",
      "",
      "Changed here, so worth a second look against the fork-ability contract. **This does not fail the check**: the literal-leak class is already caught on every pull request by level 0's render against `configuration/environments/{localdev.yaml,homelab.yaml.example}` (checks 1 and 2).",
      "",
      ...tier2.map((f) => `- \`${f}\``),
      "",
    );
  }

  out.push(
    `<sub>Head SHA \`${input.headSha}\` · contract: [docs/contracts/fork-ability.md](docs/contracts/fork-ability.md) · gate: \`scripts/fork-path-gate.ts\`</sub>`,
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
  const taskfileDiff = files.includes(TASKFILE)
    ? git(["diff", "-U0", range, "--", TASKFILE])
    : "";
  const classification = classify({ files, taskfileDiff });

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

  const comment = renderComment({ classification, decision, headSha });
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
