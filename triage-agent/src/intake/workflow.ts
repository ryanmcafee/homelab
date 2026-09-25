import { createHash } from "node:crypto";
import type { AlertGroup } from "../alerts.ts";

export const GROUP_LABEL = "homelab.local/triage-group";
export const ALERTNAME_LABEL = "homelab.local/triage-alertname";

export function slug(value: string, max = 40): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s || "alert";
}

export function groupHash(group: AlertGroup): string {
  return createHash("sha256").update(group.key).digest("hex").slice(0, 8);
}

/** Stable per alert group, so a later run updates the same PR. */
export function branchFor(group: AlertGroup): string {
  return `triage/${slug(group.alertname)}-${groupHash(group)}`;
}

export interface WorkflowOptions {
  namespace: string;
  template: string;
}

export interface WorkflowManifest {
  apiVersion: "argoproj.io/v1alpha1";
  kind: "Workflow";
  metadata: {
    generateName: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    workflowTemplateRef: { name: string };
    arguments: { parameters: { name: string; value: string }[] };
  };
}

/** One Workflow per alert group, from the triage-fix WorkflowTemplate. */
export function buildWorkflow(
  group: AlertGroup,
  opts: WorkflowOptions,
): WorkflowManifest {
  const name = slug(group.alertname);
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Workflow",
    metadata: {
      generateName: `triage-${slug(group.alertname, 30)}-`,
      namespace: opts.namespace,
      labels: {
        [GROUP_LABEL]: groupHash(group),
        [ALERTNAME_LABEL]: name,
      },
    },
    spec: {
      workflowTemplateRef: { name: opts.template },
      arguments: {
        parameters: [
          { name: "alertname", value: name },
          { name: "branch", value: branchFor(group) },
          { name: "alert-group", value: JSON.stringify(group) },
        ],
      },
    },
  };
}
