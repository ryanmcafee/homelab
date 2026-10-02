import type { AlertGroup } from "../../src/alerts.ts";
import type { Triage } from "../../src/prompt.ts";

export const group: AlertGroup = {
  key: "KubePodCrashLooping/paperclip",
  alertname: "KubePodCrashLooping",
  namespace: "paperclip",
  severity: "warning",
  alerts: [
    {
      fingerprint: "abc",
      name: "KubePodCrashLooping",
      labels: {
        alertname: "KubePodCrashLooping",
        namespace: "paperclip",
        pod: "paperclip-0",
      },
      annotations: { summary: "Pod paperclip-0 is crash looping" },
      startsAt: "2026-09-25T10:00:00Z",
    },
  ],
};

export const triage: Triage = {
  actionable: true,
  summary: "paperclip-0 crash loops",
  rootCause: "memory limit too low",
  evidence: ["OOMKilled"],
  confidence: "high",
  recommendedFix: "raise the limit in charts/paperclip/values.yaml",
};

export const goodPlan = `## Why
paperclip-0 is OOMKilled every few minutes because its memory limit is below its working set.

## Commit message
fix(paperclip): raise the memory limit above the working set

## Files
charts/paperclip/values.yaml

## Change
Raise resources.limits.memory from 512Mi to 1Gi.

## Tests
task verify:text, task test:snapshot -- --update

## Risk
More memory reserved on the node.
`;
