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

function groupFor(eventName: string, pullNumber?: number): string {
  const match = groupTemplate.match(
    /^(pr-dependency-triage-)\$\{\{\s*github\.event_name == 'pull_request_target' && github\.event\.pull_request\.number \|\| 'sweep'\s*\}\}$/,
  );
  if (groupTemplate === "pr-dependency-triage") return groupTemplate;
  if (!match) {
    throw new Error(`Unsupported triage concurrency group: ${groupTemplate}`);
  }
  return `${match[1]}${eventName === "pull_request_target" ? pullNumber : "sweep"}`;
}

test("different PR events have different cancellation groups", () => {
  expect(groupFor("pull_request_target", 426)).not.toBe(
    groupFor("pull_request_target", 427),
  );
});

test("a newer event for the same PR supersedes the prior run", () => {
  expect(cancelInProgress).toBe("true");
  expect(groupFor("pull_request_target", 426)).toBe(
    groupFor("pull_request_target", 426),
  );
});

test("scheduled and manual sweeps use a separate shared group", () => {
  expect(groupFor("schedule")).toBe(groupFor("workflow_dispatch"));
  expect(groupFor("schedule")).not.toBe(groupFor("pull_request_target", 426));
});
