/**
 * ci-fail-fast.ts
 *
 * Checks that every job of a pull_request-triggered workflow ends with the
 * fail-fast step (.github/actions/cancel-pr-ci-on-failure), which cancels the
 * PR head's other in-flight runs once the job fails, and that its
 * keep-own-run input agrees with ci-autofix.yml: a workflow CI autofix
 * listens to must keep its own run alive (a cancelled run concludes
 * `cancelled`, which autofix ignores) except on renovate/* branches, which
 * autofix skips anyway. ci-fail-fast_test.ts runs the check on the real tree.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./lib/yaml.ts";

export const WORKFLOWS_DIR = ".github/workflows";
export const AUTOFIX_WORKFLOW = "ci-autofix.yml";
export const ACTION_PATH = ".github/actions/cancel-pr-ci-on-failure/action.yml";
export const FAIL_FAST_USES = "./.github/actions/cancel-pr-ci-on-failure";
export const FAIL_FAST_IF = "failure() && github.event_name == 'pull_request'";
export const RENOVATE_AWARE_KEEP = `\${{ !startsWith(github.head_ref, 'renovate/') }}`;
/** The workflow the action never cancels and that always keeps its own run. */
export const PROTECTED_WORKFLOW = "Upgrade verification";

export interface Workflow {
  file: string;
  doc: Record<string, unknown>;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dictOf(value: unknown): Dict {
  return isDict(value) ? value : {};
}

function stepsOf(job: Dict): Dict[] {
  return Array.isArray(job.steps) ? job.steps.filter(isDict) : [];
}

export function workflowName(workflow: Workflow): string {
  return typeof workflow.doc.name === "string"
    ? workflow.doc.name
    : workflow.file;
}

export function isPullRequestTriggered(doc: Dict): boolean {
  const on = doc.on;
  if (typeof on === "string") return on === "pull_request";
  if (Array.isArray(on)) return on.includes("pull_request");
  return isDict(on) && "pull_request" in on;
}

function checksOutWorkspaceRoot(step: Dict): boolean {
  return (
    typeof step.uses === "string" &&
    step.uses.startsWith("actions/checkout@") &&
    dictOf(step.with).path === undefined
  );
}

/** Label-triggered cold draws report a measured verdict, not a PR check, so they never cancel PR CI. */
export const EXEMPT_JOBS: Readonly<Record<string, readonly string[]>> = {
  "kind-cold-draw.yml": ["resolve", "draw"],
};

/**
 * A local action needs the repository in the workspace, and a push-only job
 * never sees a pull_request event, so neither needs the step.
 */
export function isExempt(job: Dict): boolean {
  return (
    !stepsOf(job).some(checksOutWorkspaceRoot) ||
    job.if === "github.event_name == 'push'"
  );
}

/** The keep-own-run input the step must pass, or undefined for the default. */
export function expectedKeepOwnRun(
  name: string,
  autofixWorkflows: readonly string[],
): string | undefined {
  if (name === PROTECTED_WORKFLOW) return "true";
  return autofixWorkflows.includes(name) ? RENOVATE_AWARE_KEEP : undefined;
}

export function parseAutofixWorkflows(autofix: Dict): string[] {
  const workflows = dictOf(dictOf(autofix.on).workflow_run).workflows;
  if (!Array.isArray(workflows) || workflows.length === 0) {
    throw new Error(
      `${AUTOFIX_WORKFLOW}: on.workflow_run.workflows is missing or empty`,
    );
  }
  return workflows.map(String);
}

function jobFindings(
  where: string,
  job: Dict,
  keepOwnRun: string | undefined,
  topPermissions: unknown,
): string[] {
  const findings: string[] = [];
  const last = stepsOf(job).at(-1) ?? {};
  if (last.uses !== FAIL_FAST_USES) {
    return [`${where}: the last step must be \`uses: ${FAIL_FAST_USES}\``];
  }
  if (last.if !== FAIL_FAST_IF) {
    findings.push(`${where}: the fail-fast step needs \`if: ${FAIL_FAST_IF}\``);
  }
  if (last["continue-on-error"] !== true) {
    findings.push(`${where}: the fail-fast step needs continue-on-error: true`);
  }
  const keep = dictOf(last.with)["keep-own-run"];
  const actual = keep === undefined ? undefined : String(keep);
  if (actual !== keepOwnRun) {
    findings.push(
      `${where}: keep-own-run is ${actual ?? "unset"}, expected ${keepOwnRun ?? "unset"} (see ${AUTOFIX_WORKFLOW} on.workflow_run.workflows)`,
    );
  }
  const permissions = dictOf(job.permissions ?? topPermissions);
  if (permissions.actions !== "write") {
    findings.push(
      `${where}: the token needs \`actions: write\` (job or workflow permissions) to cancel runs`,
    );
  }
  return findings;
}

/** Every way the workflows disagree with the fail-fast contract. */
export function failFastFindings(
  workflows: readonly Workflow[],
  autofixWorkflows: readonly string[],
): string[] {
  const names = new Set(workflows.map(workflowName));
  const findings = autofixWorkflows
    .filter((name) => !names.has(name))
    .map(
      (name) =>
        `${AUTOFIX_WORKFLOW}: listens to "${name}", which no workflow is named`,
    );
  for (const workflow of workflows) {
    if (!isPullRequestTriggered(workflow.doc)) continue;
    const keepOwnRun = expectedKeepOwnRun(
      workflowName(workflow),
      autofixWorkflows,
    );
    for (const [id, job] of Object.entries(dictOf(workflow.doc.jobs))) {
      if (!isDict(job) || isExempt(job)) continue;
      if (EXEMPT_JOBS[workflow.file]?.includes(id)) continue;
      findings.push(
        ...jobFindings(
          `${workflow.file} job ${id}`,
          job,
          keepOwnRun,
          workflow.doc.permissions,
        ),
      );
    }
  }
  return findings;
}

/** The workflow name the action's PROTECTED_WORKFLOW env never cancels. */
export function actionProtectedWorkflow(action: Dict): string | undefined {
  const steps = dictOf(action.runs).steps;
  if (!Array.isArray(steps)) return undefined;
  for (const step of steps) {
    const value = dictOf(dictOf(step).env).PROTECTED_WORKFLOW;
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function readYaml(path: string): Dict {
  return dictOf(parse(readFileSync(path, "utf8")));
}

export function readWorkflows(dir = WORKFLOWS_DIR): Workflow[] {
  return readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => ({ file, doc: readYaml(join(dir, file)) }));
}
