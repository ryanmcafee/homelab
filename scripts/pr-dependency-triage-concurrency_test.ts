import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const workflow = readFileSync(
  new URL("../.github/workflows/pr-dependency-triage.yml", import.meta.url),
  "utf8",
);
const concurrency = workflow.match(
  /^concurrency:\n(?: {2}#.*\n)* {2}group: (.+)\n {2}cancel-in-progress: (.+)$/m,
);
if (!concurrency)
  throw new Error(
    "Expected a scalar concurrency group and cancel-in-progress setting",
  );
const groupTemplate = concurrency[1];
const cancelInProgress = concurrency[2];

function groupFor(eventName: string, runId: number): string {
  const match = groupTemplate.match(
    /^(pr-dependency-triage-)\$\{\{\s*github\.event_name == 'pull_request_target' && github\.run_id \|\| 'sweep'\s*\}\}$/,
  );
  if (!match) {
    throw new Error(`Unsupported triage concurrency group: ${groupTemplate}`);
  }
  return `${match[1]}${eventName === "pull_request_target" ? runId : "sweep"}`;
}

test("a newer event for the same PR never cancels the prior run", () => {
  expect(groupFor("pull_request_target", 1001)).not.toBe(
    groupFor("pull_request_target", 1002),
  );
});

test("a newer sweep supersedes the prior sweep", () => {
  expect(cancelInProgress).toBe("true");
  expect(groupFor("schedule", 1001)).toBe(groupFor("workflow_dispatch", 1002));
});

test("sweeps never share a group with PR events", () => {
  expect(groupFor("schedule", 1001)).not.toBe(
    groupFor("pull_request_target", 1001),
  );
});
