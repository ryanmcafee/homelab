import { z } from "zod";
import type { AlertGroup } from "../alerts.ts";
import { must } from "../exec.ts";
import { checkPlan, type Triage, triageSchema } from "../prompt.ts";
import { configureGit } from "../workspace.ts";
import { alertGroupOf, type StageDeps } from "./context.ts";

const MAX_WHY_WORDS = 100;

function slugScope(group: AlertGroup): string {
  return group.alertname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30);
}

/** Conventional commit subject: the plan's, or a fallback naming the alert. */
export function commitSubject(
  plan: string | undefined,
  group: AlertGroup,
  feedback: "none" | "verify" | "ci",
): string {
  if (feedback === "ci") {
    return `fix(${slugScope(group)}): address the CI failure of the ${group.alertname} fix`;
  }
  const fromPlan = plan ? checkPlan(plan).commitMessage : undefined;
  return fromPlan ?? `fix(${slugScope(group)}): resolve ${group.alertname}`;
}

async function gitIdentity(deps: StageDeps): Promise<void> {
  await configureGit(
    deps.exec,
    { name: deps.config.GIT_USER_NAME, email: deps.config.GIT_USER_EMAIL },
    deps.config.GITHUB_TOKEN,
  );
}

/** Stage 5, deterministic: commit every change, out/changed. */
export async function commitStage(deps: StageDeps): Promise<boolean> {
  const { exec, work, config } = deps;
  const group = alertGroupOf(config);
  const git = (...args: string[]) =>
    must(exec, ["git", ...args], { cwd: work.repo });
  await gitIdentity(deps);
  await git("add", "-A");
  const staged = await exec(["git", "diff", "--cached", "--quiet"], {
    cwd: work.repo,
  });
  const changed = staged.code !== 0;
  if (changed) {
    const subject = commitSubject(
      work.readIfExists("plan.md"),
      group,
      config.FEEDBACK,
    );
    const scope = group.namespace ? ` (${group.namespace})` : "";
    await git(
      "commit",
      "--quiet",
      "-m",
      subject,
      "-m",
      `Alert: ${group.alertname}${scope}\nWorkflow: ${config.WORKFLOW_NAME}`,
    );
  }
  work.writeJson("commit.json", { changed });
  work.output("changed", changed);
  return changed;
}

function firstWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > max
    ? `${words.slice(0, max).join(" ")}...`
    : words.join(" ");
}

/** PR body: the why (<= 100 words), then the triage report and plan folded. */
export function prBody(opts: {
  group: AlertGroup;
  triage: Triage;
  plan: string;
  workflow: string;
  verifyPassed: boolean;
}): string {
  const why = checkPlan(opts.plan).why ?? opts.triage.summary;
  const scope = opts.group.namespace ? ` in \`${opts.group.namespace}\`` : "";
  const t = opts.triage;
  return [
    firstWords(why, MAX_WHY_WORDS),
    "",
    `Fixes alert \`${opts.group.alertname}\`${scope}. Workflow \`${opts.workflow}\`.`,
    ...(opts.verifyPassed
      ? []
      : [
          "",
          "**Draft: the repository checks still fail after the bounded fix attempts; see the workflow's verify.log.**",
        ]),
    "",
    "<details><summary>Triage report</summary>",
    "",
    `**Summary:** ${t.summary}`,
    "",
    `**Probable root cause (${t.confidence} confidence):** ${t.rootCause}`,
    "",
    "**Evidence:**",
    ...t.evidence.map((e) => `- ${e}`),
    "",
    `**Recommended fix:** ${t.recommendedFix}`,
    "",
    "</details>",
    "",
    "<details><summary>Plan</summary>",
    "",
    opts.plan.trim(),
    "",
    "</details>",
    "",
  ].join("\n");
}

const prListSchema = z.array(
  z.object({ number: z.number(), url: z.string(), isDraft: z.boolean() }),
);

export const prRecordSchema = z.object({
  number: z.number(),
  url: z.string(),
  draft: z.boolean(),
  created: z.boolean(),
  needsHuman: z.boolean().default(false),
});

export type PrRecord = z.infer<typeof prRecordSchema>;

export function prNumberFromUrl(url: string): number {
  const match = /\/pull\/(\d+)/.exec(url);
  if (!match?.[1]) throw new Error(`gh pr create printed no PR URL: ${url}`);
  return Number(match[1]);
}

async function ensureLabel(deps: StageDeps, label: string, color: string) {
  await must(deps.exec, [
    "gh",
    "label",
    "create",
    label,
    "--repo",
    deps.config.REPO_SLUG,
    "--color",
    color,
    "--force",
  ]);
}

/**
 * Stage 6, deterministic: force-with-lease push of the branch, then create the
 * PR or update the open one for the same branch. Draft + needs-human label
 * when verify never passed.
 */
export async function prStage(deps: StageDeps): Promise<PrRecord> {
  const { exec, work, config } = deps;
  if (!config.BRANCH) throw new Error("BRANCH is not set");
  if (!config.GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is not set: add a fine-grained PAT (contents and pull requests read/write) to the triage-agent 1Password item",
    );
  }
  const group = alertGroupOf(config);
  const gh = (...args: string[]) => must(exec, ["gh", ...args]);
  const repo = ["--repo", config.REPO_SLUG];
  await gitIdentity(deps);

  await must(
    exec,
    [
      "git",
      "push",
      "--force-with-lease",
      "origin",
      `HEAD:refs/heads/${config.BRANCH}`,
    ],
    { cwd: work.repo },
  );

  const verifyPassed = z
    .object({ passed: z.boolean() })
    .parse(work.readJson("verify.json")).passed;
  const body = prBody({
    group,
    triage: triageSchema.parse(work.readJson("triage.json")),
    plan: work.read("plan.md"),
    workflow: config.WORKFLOW_NAME,
    verifyPassed,
  });
  work.write("pr-body.md", body);
  const bodyFile = work.path("pr-body.md");

  const open = prListSchema.parse(
    JSON.parse(
      await gh(
        "pr",
        "list",
        ...repo,
        "--head",
        config.BRANCH,
        "--state",
        "open",
        "--json",
        "number,url,isDraft",
      ),
    ),
  )[0];

  await ensureLabel(deps, config.PR_LABEL, "5319e7");
  let record: PrRecord;
  if (open) {
    await gh(
      "pr",
      "edit",
      String(open.number),
      ...repo,
      "--body-file",
      bodyFile,
    );
    record = {
      number: open.number,
      url: open.url,
      draft: open.isDraft,
      created: false,
      needsHuman: false,
    };
  } else {
    const url = (
      await gh(
        "pr",
        "create",
        ...repo,
        "--base",
        config.BASE_BRANCH,
        "--head",
        config.BRANCH,
        "--title",
        commitSubject(work.read("plan.md"), group, "none"),
        "--body-file",
        bodyFile,
        "--label",
        config.PR_LABEL,
        ...(verifyPassed ? [] : ["--draft"]),
      )
    ).trim();
    record = {
      number: prNumberFromUrl(url),
      url,
      draft: !verifyPassed,
      created: true,
      needsHuman: false,
    };
  }

  if (!verifyPassed) {
    if (!record.draft)
      await gh("pr", "ready", String(record.number), ...repo, "--undo");
    await markNeedsHuman(deps, record.number);
    record = { ...record, draft: true, needsHuman: true };
  }
  work.writeJson("pr.json", record);
  work.output("pr-number", record.number);
  work.output("pr-url", record.url);
  work.output("draft", record.draft);
  deps.logger.info(
    record,
    open ? "pull request updated" : "pull request opened",
  );
  return record;
}

async function markNeedsHuman(deps: StageDeps, number: number): Promise<void> {
  await ensureLabel(deps, deps.config.NEEDS_HUMAN_LABEL, "d93f0b");
  await must(deps.exec, [
    "gh",
    "pr",
    "edit",
    String(number),
    "--repo",
    deps.config.REPO_SLUG,
    "--add-label",
    deps.config.NEEDS_HUMAN_LABEL,
  ]);
}

/** Stage 7b, deterministic: CI stayed red after the fix loop. */
export async function needsHumanStage(deps: StageDeps): Promise<void> {
  const record = prRecordSchema.parse(deps.work.readJson("pr.json"));
  if (!record.draft) {
    await must(deps.exec, [
      "gh",
      "pr",
      "ready",
      String(record.number),
      "--repo",
      deps.config.REPO_SLUG,
      "--undo",
    ]);
  }
  await markNeedsHuman(deps, record.number);
  deps.work.writeJson("pr.json", { ...record, draft: true, needsHuman: true });
}
