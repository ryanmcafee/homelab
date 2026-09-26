#!/usr/bin/env bun

import { readFile } from "node:fs/promises";

/**
 * renovate-regen.ts
 *
 * Regenerate the committed artefacts a Renovate bump needs, then commit them
 * under the generic regeneration identity so Renovate keeps managing — and
 * rebasing — the branch.
 *
 * Why the identity is the whole point. `.github/renovate.json5` lists exactly
 * one address in `gitIgnoredAuthors`. A commit ahead of the base branch by
 * anybody else makes Renovate treat the branch as human-edited and stop
 * rebasing it, permanently; `rebaseWhen: 'behind-base-branch'` does not save
 * you, because Renovate never looks at the branch again. Measured on
 * 2026-09-26: of the five open `renovate/*` PRs, the two carrying only
 * Renovate's own commits were rebased to 0-behind within ~70 minutes of `main`
 * moving, and all three carrying a regeneration commit pushed under a personal
 * address had been stuck for up to two days (19, 19 and 10 commits behind).
 *
 * `.github/workflows/upgrade.yml` job `regenerate` does this in CI, but only
 * when the regeneration bot's GitHub App secrets exist. Without them the job
 * prints a notice and does nothing, and regeneration falls to whoever sweeps
 * the PR. This script is that path, using the same identity so the outcome is
 * the same one Renovate already trusts. A fork inherits it with no setup: the
 * address is a generic `users.noreply.github.com` bot address that lives in the
 * repository, not a personal one.
 *
 *   task renovate:regen                  regenerate, then commit as the bot
 *   task renovate:regen -- --check       identity parity only, no writes
 *   task renovate:regen -- --no-commit   regenerate, leave the tree dirty
 *   task renovate:regen -- --any-branch  escape hatch, see BYPASS below
 *   task renovate:deployed-major         read the deployed Renovate major from a
 *                                        PR body and fail if it crossed 44
 *                                        while this repo still runs the 43 regime
 *
 * BYPASS. The branch guard exists so the bot identity is never used to sign a
 * commit on a human PR (that would invite Renovate to force-push over real
 * work). For a genuine emergency on a branch that is not named `renovate/*` —
 * a bump branch renamed by hand, a fork whose PR branch has another prefix —
 * pass `--any-branch` and say why in the commit or PR body. The generated-only
 * guard has no bypass: if regeneration touched a non-generated file, that file
 * belongs in its own commit under its own author.
 */

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

export const WORKFLOW_PATH = ".github/workflows/upgrade.yml";
export const RENOVATE_CONFIG_PATH = ".github/renovate.json5";

/** The committed artefacts a bump regenerates. Anything else is not ours. */
export const GENERATED_PATHS = [
  "charts/addons/values-localdev.yaml",
  "charts/applications/values-localdev.yaml",
  "tests/schemas/",
  "tests/snapshots/",
  "readme.md",
  "docs/",
  ".github/homelab.svg",
];

/** The regeneration steps, in dependency order: values and schemas feed the
 * snapshots, so the snapshots are regenerated last. Same set, same order as
 * `upgrade.yml` job `regenerate`, plus `docs:check --fix`, which owns the
 * readme version badges and the addons table that a chart bump also moves. */
export const REGEN_STEPS: { desc: string; cmd: string[] }[] = [
  { desc: "localdev values", cmd: ["task", "config:export:localdev"] },
  { desc: "vendored CRD schemas", cmd: ["task", "schemas:vendor"] },
  {
    desc: "golden snapshots",
    cmd: ["task", "test:snapshot", "--", "--update"],
  },
  { desc: "generated doc regions", cmd: ["task", "docs:check", "--", "--fix"] },
];

export interface RegenIdentity {
  name: string;
  email: string;
}

/**
 * Read `REGEN_BOT_NAME` / `REGEN_BOT_EMAIL` out of upgrade.yml's `env:` block.
 * The workflow is the authority: it is what CI commits as when the bot is
 * configured, so a manual regeneration has to match it or the two paths
 * produce differently-authored commits for the same work.
 */
export function parseRegenIdentity(workflowYaml: string): RegenIdentity {
  const read = (key: string): string => {
    const m = workflowYaml.match(
      new RegExp(`^\\s*${key}:\\s*(?:'([^']*)'|"([^"]*)"|([^\\s#]+))`, "m"),
    );
    const value = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
    if (!value) {
      throw new Error(
        `${WORKFLOW_PATH} does not define ${key}; the regeneration identity has no source of truth.`,
      );
    }
    return value;
  };
  return { name: read("REGEN_BOT_NAME"), email: read("REGEN_BOT_EMAIL") };
}

/**
 * Extract the string literals of renovate.json5's `gitIgnoredAuthors` array.
 * Hand-parsed rather than JSON5-parsed: the file is JSON5 with comments and
 * this script must not pull in a parser just to read one array.
 */
export function parseGitIgnoredAuthors(json5: string): string[] {
  const start = json5.search(/^\s*gitIgnoredAuthors\s*:\s*\[/m);
  if (start === -1) {
    throw new Error(
      `${RENOVATE_CONFIG_PATH} has no gitIgnoredAuthors array; every regeneration commit would orphan its branch.`,
    );
  }
  const open = json5.indexOf("[", start);
  const close = json5.indexOf("]", open);
  if (close === -1) {
    throw new Error(
      `${RENOVATE_CONFIG_PATH}: gitIgnoredAuthors array is not closed.`,
    );
  }
  const body = json5
    .slice(open + 1, close)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
}

/**
 * Fail closed when the workflow identity is not one Renovate ignores. This is
 * the gate: three files have to agree (the workflow's env, renovate.json5's
 * gitIgnoredAuthors, and this script's commits), and until now nothing checked
 * that they did. Drift here is silent and its only symptom is a branch that
 * quietly stops being rebased.
 */
export function identityParityError(
  identity: RegenIdentity,
  ignoredAuthors: string[],
): string | null {
  if (ignoredAuthors.includes(identity.email)) return null;
  return [
    "renovate-regen/identity-parity: the regeneration identity is not ignored by Renovate.",
    `  ${WORKFLOW_PATH} REGEN_BOT_EMAIL:           ${identity.email}`,
    `  ${RENOVATE_CONFIG_PATH} gitIgnoredAuthors: ${ignoredAuthors.join(", ") || "(empty)"}`,
    "  A commit by an author Renovate does not ignore makes Renovate treat the branch as",
    "  human-edited and stop rebasing it. Add the address to gitIgnoredAuthors, or point",
    "  REGEN_BOT_EMAIL at one already listed. Never add a personal address: a fork's",
    "  regeneration commits carry the forker's address, so a personal entry only ever",
    "  works on one repository.",
  ].join("\n");
}

/** The bot identity signs generated files only, on a Renovate branch only. */
export function branchGuardError(
  branch: string,
  anyBranch: boolean,
): string | null {
  if (anyBranch || branch.startsWith("renovate/")) return null;
  return [
    `renovate-regen/branch-scope: ${branch} is not a renovate/* branch.`,
    "  Committing as the regeneration bot here would tell Renovate it may force-push over",
    "  this branch. Regenerate and commit under your own author instead, or pass",
    "  --any-branch with a documented reason.",
  ].join("\n");
}

/**
 * The Renovate major at which `isBranchModified()` starts reading the committer.
 *
 * Measured against the published sources, not assumed — the assumption is what
 * produced two wrong diagnoses on this branch:
 *
 * - `43.163.0` `lib/util/git/index.ts`: `git.log(['origin/base..origin/branch'])`
 *   and `committedAuthors.add(commit.author_email)`. `%ae` only, and
 *   `gitIgnoredAuthors` is matched with `Set.delete(literal)`.
 * - `44.0.0` and later: the same log requests `{ author_email: '%ae',
 *   committer_email: '%ce' }` and adds both, then subtracts `gitIgnoredAuthors`
 *   through `matchRegexOrGlobList` plus the platform's `noreply@github.com`.
 *   Upstream `ff2a83d9` (2026-05-07) landed it, `2239c753` reverted it a day
 *   later, `8e6a7fc2` (2026-07-18) re-landed it; glob support is `65ee1f18`.
 *
 * Read the deployed version from the base64 `renovate-debug` comment at the foot
 * of any Renovate PR body. This repository was on 43.110.14 on 2026-09-26, and
 * the Dependency Dashboard's "PR Edited (Blocked)" section confirmed the
 * behaviour independently: branches whose only foreign address was the committer
 * were listed as Open.
 */
export const COMMITTER_READ_FROM_MAJOR = 44;

/**
 * Whether the deployed Renovate reads `%ce`. `RENOVATE_MAJOR` lets CI and the
 * runbook pin it explicitly; absent that we assume the pre-44 behaviour, which
 * is the one measured here, and the committer finding stays advisory.
 */
export function committerIsRead(
  renovateMajor: number | null | undefined,
): boolean {
  return (renovateMajor ?? 0) >= COMMITTER_READ_FROM_MAJOR;
}

export interface CommitIdentityFindings {
  /** Orphans the branch on every Renovate version. Fails the command. */
  error: string | null;
  /** Orphans the branch only from Renovate 44. Advisory before then. */
  warning: string | null;
}

/**
 * Renovate appends `<!--renovate-debug:<base64 JSON>-->` to the foot of every PR
 * body it writes. It is the only in-band source of the *deployed* version found:
 * the chart's image tag lives in the cluster, `renovate/config-validation` does
 * not print a version, and the Dependency Dashboard names the versions it wants
 * to install rather than the one installing them. The JSON carries
 * `createdInVer` (the version that opened the PR) and `updatedInVer` (the
 * version that last touched it) — `updatedInVer` is the deployed one.
 */
const RENOVATE_DEBUG_RE = /<!--\s*renovate-debug:([A-Za-z0-9+/=]+?)\s*-->/g;

export interface DeployedRenovate {
  /** The full version string as Renovate wrote it, e.g. `43.110.14`. */
  version: string;
  major: number;
  /** Which key it came from. `updatedInVer` is the deployed version. */
  field: "updatedInVer" | "createdInVer";
}

/**
 * The outcome of trying to read the deployed version. `absent` and `unreadable`
 * are distinct from `read` on purpose: this check exists because a version was
 * assumed rather than measured, so "I could not measure it" must not collapse
 * into "it is fine". Both fail the gate.
 */
export type DeployedRenovateRead =
  | { kind: "read"; deployed: DeployedRenovate; blobs: number }
  | { kind: "unreadable"; blobs: number }
  | { kind: "absent"; blobs: 0 };

function decodeDebugBlob(base64: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(base64, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the highest deployed major advertised by any `renovate-debug` blob in the
 * supplied PR bodies.
 *
 * Highest, not first: a PR body is only rewritten when Renovate next touches
 * that PR, so a branch Renovate has abandoned keeps advertising the version that
 * abandoned it. Taking the maximum means one stale body cannot mask a live
 * upgrade — the direction that matters, because the failure being guarded here is
 * running the 43.x regime under a 44.x deployment.
 */
export function readDeployedRenovate(prBodies: string[]): DeployedRenovateRead {
  let blobs = 0;
  let best: DeployedRenovate | null = null;
  for (const body of prBodies) {
    for (const match of body.matchAll(RENOVATE_DEBUG_RE)) {
      blobs += 1;
      const debug = decodeDebugBlob(match[1] ?? "");
      if (!debug) continue;
      for (const field of ["updatedInVer", "createdInVer"] as const) {
        const raw = debug[field];
        if (typeof raw !== "string") continue;
        const major = /^(\d+)\./.exec(raw);
        if (!major) continue;
        const candidate: DeployedRenovate = {
          version: raw,
          major: Number(major[1]),
          field,
        };
        // Prefer a higher major; at the same major prefer updatedInVer, which is
        // the version that last ran rather than the one that opened the PR.
        if (
          !best ||
          candidate.major > best.major ||
          (candidate.major === best.major &&
            candidate.field === "updatedInVer" &&
            best.field === "createdInVer")
        ) {
          best = candidate;
        }
      }
    }
  }
  if (best) return { kind: "read", deployed: best, blobs };
  if (blobs > 0) return { kind: "unreadable", blobs };
  return { kind: "absent", blobs: 0 };
}

const DEPLOYED_MAJOR_RULE = "renovate-regen/deployed-major";

const HOW_TO_FLIP = [
  `  Flip the regime: run \`task renovate:regen -- --committer-strict\`, or set RENOVATE_MAJOR in`,
  "  the environment, and regenerate through the API form in docs/runbooks/verification.md —",
  "  on a runner whose credential wrapper pins the committer it is the only form that lands it.",
];

/**
 * Fail when the deployed Renovate reads the committer but this repository is
 * still driving the pre-44 regime, where a committer mismatch is only a warning.
 *
 * This is the whole point of the check: the 43 → 44 boundary is invisible from
 * inside the repository, the upgrade arrives on Renovate's own schedule through
 * a rate-limited image bump, and the symptom on the far side of it is a branch
 * that silently stops being rebased — under a `strict` base branch, a permanent
 * merge block no agent can undo. So read the boundary instead of remembering it.
 *
 * The inverse (configured for 44, deployed on 43) is a warning, not an error:
 * being stricter than the deployment costs a correct commit nothing.
 */
export function deployedMajorFindings(
  read: DeployedRenovateRead,
  options: { committerIsRead: boolean },
): CommitIdentityFindings {
  if (read.kind === "absent") {
    return {
      error: [
        `${DEPLOYED_MAJOR_RULE}: no renovate-debug blob in the supplied PR body/bodies, so the`,
        "  deployed Renovate version could not be read.",
        "  Renovate appends `<!--renovate-debug:...-->` to every PR body it writes, and that blob",
        "  is the only in-band source of the deployed version. Its absence means either the input",
        "  is not a Renovate PR body, or Renovate is no longer writing these PRs — both of which",
        "  leave the 43/44 committer boundary unmeasured, which is the state this gate exists to",
        "  end. Pass the body of an open renovate/* PR.",
      ].join("\n"),
      warning: null,
    };
  }
  if (read.kind === "unreadable") {
    return {
      error: [
        `${DEPLOYED_MAJOR_RULE}: found ${read.blobs} renovate-debug blob(s) but none carried a`,
        "  readable createdInVer/updatedInVer.",
        "  The blob format changed, or the body was mangled in transit. Fail closed: an unreadable",
        "  version is not evidence of a pre-44 deployment. Decode it by hand",
        "  (`base64 -d` the comment payload) and pin RENOVATE_MAJOR until this parser is updated.",
      ].join("\n"),
      warning: null,
    };
  }
  const { deployed } = read;
  if (deployed.major >= COMMITTER_READ_FROM_MAJOR && !options.committerIsRead) {
    return {
      error: [
        `${DEPLOYED_MAJOR_RULE}: deployed Renovate is ${deployed.version} (${deployed.field}),`,
        `  but this repository is still configured for the pre-${COMMITTER_READ_FROM_MAJOR} regime.`,
        `  From Renovate ${COMMITTER_READ_FROM_MAJOR}, isBranchModified() reads the committer (%ce) as`,
        "  well as the author (%ae) of every commit ahead of the base branch. A rebase re-commits",
        "  every commit and so rewrites every committer, so under this deployment any rebase of a",
        "  renovate/* branch under a foreign identity orphans it while changing no bytes — and a",
        "  committer mismatch is an orphaning event, not the warning this repository still treats",
        "  it as.",
        ...HOW_TO_FLIP,
      ].join("\n"),
      warning: null,
    };
  }
  if (deployed.major < COMMITTER_READ_FROM_MAJOR && options.committerIsRead) {
    return {
      error: null,
      warning: [
        `${DEPLOYED_MAJOR_RULE}: deployed Renovate is ${deployed.version}, which reads only the`,
        `  author, but the committer is being enforced as if it were ${COMMITTER_READ_FROM_MAJOR}.x.`,
        "  Harmless — stricter than the deployment — but it will reject a commit the deployed",
        "  Renovate would have kept managing. Drop --committer-strict/RENOVATE_MAJOR to match.",
      ].join("\n"),
    };
  }
  return { error: null, warning: null };
}

/**
 * A wrong **author** takes the branch out of Renovate's hands on every version,
 * so it is an error. A wrong **committer** does so only from
 * {@link COMMITTER_READ_FROM_MAJOR}; before that it is a warning, because on the
 * deployed 43.x the commit is genuinely Renovate-managed and failing it would
 * reject the tool's own correct output. On this runner the committer is *always*
 * wrong — the credential wrapper strips and re-sets `GIT_COMMITTER_EMAIL`, and
 * measurement says `--author` lands while every committer form does not — so
 * erroring on it would make `renovate:regen` unrunnable by its intended actor.
 */
export function commitIdentityFindings(
  identity: RegenIdentity,
  authorEmail: string,
  committerEmail: string,
  options: { committerIsRead: boolean },
): CommitIdentityFindings {
  const remedy = [
    "  On an ordinary machine amend it:",
    `    git -c user.name="${identity.name}" -c user.email="${identity.email}" \\`,
    `      commit --amend --no-edit --author="${identity.name} <${identity.email}>"`,
    "  If the committer is still wrong after that, a credential wrapper is pinning it and no git",
    "  invocation can win. Commit through the API instead, which takes both as explicit fields:",
    "    gh api -X PUT repos/{owner}/{repo}/contents/{path} -f branch=... -f content=... \\",
    `      -f 'author[email]=${identity.email}' -f 'committer[email]=${identity.email}'`,
  ];
  const authorWrong = authorEmail !== identity.email;
  const committerWrong = committerEmail !== identity.email;
  const wrong: string[] = [];
  if (authorWrong) wrong.push(`  author: ${authorEmail}`);
  const error =
    authorWrong || (committerWrong && options.committerIsRead)
      ? [
          "renovate-regen/commit-identity: the commit does not carry the regeneration identity.",
          ...wrong,
          ...(committerWrong && options.committerIsRead
            ? [`  committer: ${committerEmail}`]
            : []),
          `  (expected ${identity.email})`,
          `  Renovate reads the author${options.committerIsRead ? " AND the committer" : ""} of every commit ahead of`,
          "  the base branch, so this commit takes the branch out of Renovate's hands.",
          ...remedy,
        ].join("\n")
      : null;
  const warning =
    committerWrong && !options.committerIsRead
      ? [
          `renovate-regen/commit-identity: committer is ${committerEmail}, not ${identity.email}.`,
          `  Harmless on the deployed Renovate 43.x, which reads only the author. From Renovate`,
          `  ${COMMITTER_READ_FROM_MAJOR} this orphans the branch, so fix it before that upgrade lands.`,
          ...remedy,
        ].join("\n")
      : null;
  return { error, warning };
}

export function generatedOnlyError(changed: string[]): string | null {
  const foreign = changed.filter(
    (p) =>
      !GENERATED_PATHS.some((g) =>
        g.endsWith("/") ? p.startsWith(g) : p === g,
      ),
  );
  if (foreign.length === 0) return null;
  return [
    "renovate-regen/generated-only: regeneration changed files that are not generated artefacts.",
    ...foreign.map((p) => `  ${p}`),
    "  These must not land in a bot-authored commit: Renovate is allowed to force-push over",
    "  that author, so a real change hidden in one can be silently destroyed on the next",
    "  rebase. Commit them separately under your own author (that keeps the branch out of",
    "  Renovate's hands, which for a real change is the correct outcome).",
  ].join("\n");
}

async function run(cmd: string[], quiet = false): Promise<string> {
  const p = Bun.spawn(cmd, {
    stdin: "inherit",
    stdout: quiet ? "pipe" : "inherit",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0)
    throw new Error(`Command failed: ${cmd.join(" ")}\n${stderr}`);
  return stdout.trim();
}

async function capture(cmd: string[]): Promise<string> {
  return run(cmd, true);
}

/**
 * `--deployed-major` mode: read the deployed Renovate version out of one or more
 * Renovate PR bodies and fail if it has crossed the committer boundary while this
 * repository is still driving the pre-44 regime.
 *
 * Bodies come in on stdin or as file paths so the check is offline and testable;
 * the caller supplies them, e.g.
 *
 *   gh pr list --json headRefName,body \
 *     --jq '.[] | select(.headRefName|startswith("renovate/")) | .body' \
 *     | bun scripts/renovate-regen.ts --deployed-major
 */
async function deployedMajorCommand(args: string[]): Promise<void> {
  const paths = args.filter((a) => !a.startsWith("-"));
  const bodies = paths.length
    ? await Promise.all(paths.map((p) => readFile(p, "utf8")))
    : [await Bun.stdin.text()];
  const read = readDeployedRenovate(bodies);
  const committerRead =
    args.includes("--committer-strict") ||
    committerIsRead(Number.parseInt(Bun.env.RENOVATE_MAJOR ?? "", 10) || null);
  const { error, warning } = deployedMajorFindings(read, {
    committerIsRead: committerRead,
  });
  if (error) {
    console.error(red(error));
    process.exit(1);
  }
  if (warning) console.warn(yellow(warning));
  if (read.kind === "read") {
    console.log(
      `${green("[OK]")} deployed Renovate ${cyan(read.deployed.version)} (${read.deployed.field}, ${read.blobs} blob(s)); committer is ${committerRead ? cyan("read — enforced") : cyan("ignored — advisory")}`,
    );
  }
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.includes("--deployed-major")) {
    await deployedMajorCommand(args);
    return;
  }
  const checkOnly = args.includes("--check");
  const noCommit = args.includes("--no-commit");
  const anyBranch = args.includes("--any-branch");
  // `RENOVATE_MAJOR` is the honest input (read it out of a PR's renovate-debug
  // blob); `--committer-strict` is the manual override for a dry run.
  const committerRead =
    args.includes("--committer-strict") ||
    committerIsRead(Number.parseInt(Bun.env.RENOVATE_MAJOR ?? "", 10) || null);

  const [workflowYaml, renovateConfig] = await Promise.all([
    readFile(WORKFLOW_PATH, "utf8"),
    readFile(RENOVATE_CONFIG_PATH, "utf8"),
  ]);
  const identity = parseRegenIdentity(workflowYaml);
  const ignoredAuthors = parseGitIgnoredAuthors(renovateConfig);

  const parity = identityParityError(identity, ignoredAuthors);
  if (parity) {
    console.error(red(parity));
    process.exit(1);
  }
  console.log(
    `${green("[OK]")} regeneration identity ${cyan(`${identity.name} <${identity.email}>`)} is in ${RENOVATE_CONFIG_PATH} gitIgnoredAuthors`,
  );
  if (checkOnly) return;

  const branch = await capture(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  const branchError = branchGuardError(branch, anyBranch);
  if (branchError) {
    console.error(red(branchError));
    process.exit(1);
  }
  if (anyBranch && !branch.startsWith("renovate/")) {
    console.log(
      yellow(`[BYPASS] --any-branch: committing as the bot on ${branch}`),
    );
  }

  const dirty = await capture(["git", "status", "--porcelain"]);
  if (dirty) {
    console.error(
      red(
        "renovate-regen/clean-tree: the working tree is dirty. Regeneration output has to be\n" +
          "  the only thing in the commit, so commit or stash your changes first.\n" +
          dirty,
      ),
    );
    process.exit(1);
  }

  for (const step of REGEN_STEPS) {
    console.log(cyan(`==> ${step.desc}: ${step.cmd.join(" ")}`));
    await run(step.cmd);
  }

  const changed = (await capture(["git", "status", "--porcelain"]))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  if (changed.length === 0) {
    console.log(
      `${green("[OK]")} nothing to regenerate; the branch is already current`,
    );
    return;
  }

  const foreignError = generatedOnlyError(changed);
  if (foreignError) {
    console.error(red(foreignError));
    process.exit(1);
  }
  console.log(`${green("[OK]")} ${changed.length} generated file(s) changed:`);
  for (const p of changed) console.log(`      ${p}`);
  if (noCommit) {
    console.log(yellow("--no-commit: leaving the tree dirty"));
    return;
  }

  await run(["git", "add", "--", ...changed]);
  // Both forms, deliberately. `-c user.*` is what sets the *committer*, which
  // Renovate reads as well as the author; `--author` is the only form that
  // survives a wrapper pinning GIT_AUTHOR_EMAIL. Neither alone is sufficient,
  // and where the committer is pinned too, commitIdentityError() says so.
  await run([
    "git",
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
    "commit",
    "--author",
    `${identity.name} <${identity.email}>`,
    "-m",
    "chore(deps): regenerate snapshots, schemas and localdev values",
    "-m",
    `Generated by scripts/renovate-regen.ts on ${branch}. Author and committer are ${identity.email} so Renovate keeps rebasing this branch (.github/renovate.json5 gitIgnoredAuthors).`,
  ]);
  const [authored, committed] = (
    await capture(["git", "log", "-1", "--format=%ae%n%ce"])
  ).split("\n");
  const { error: identityError, warning: identityWarning } =
    commitIdentityFindings(identity, authored ?? "", committed ?? "", {
      committerIsRead: committerRead,
    });
  if (identityError) {
    console.error(red(identityError));
    process.exit(1);
  }
  if (identityWarning) console.warn(yellow(identityWarning));
  console.log(
    `${green("[OK]")} committed ${await capture(["git", "rev-parse", "--short", "HEAD"])} as ${cyan(authored ?? "")} (author${identityWarning ? "" : " and committer"})`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
