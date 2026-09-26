#!/usr/bin/env bun
/**
 * Prints a Workflow as the intake would submit it, named so `argo lint --offline`
 * accepts it next to the rendered triage-fix WorkflowTemplate (triage-agent-image.yml).
 */
import { buildWorkflow } from "../src/intake/workflow.ts";

const workflow = buildWorkflow(
  {
    key: "KubePodCrashLooping/sample",
    alertname: "KubePodCrashLooping",
    namespace: "sample",
    severity: "warning",
    alerts: [
      {
        fingerprint: "0123456789abcdef",
        name: "KubePodCrashLooping",
        labels: { alertname: "KubePodCrashLooping", namespace: "sample" },
        annotations: { summary: "sample" },
        startsAt: "2026-09-25T00:00:00Z",
      },
    ],
  },
  { namespace: "triage-agent", template: "triage-fix" },
);
const { generateName, ...metadata } = workflow.metadata;
process.stdout.write(
  `${JSON.stringify({ ...workflow, metadata: { ...metadata, name: `${generateName}sample` } }, null, 2)}\n`,
);
