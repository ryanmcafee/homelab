import type { Logger } from "pino";
import { type Alert, type AlertGroup, groupAlerts } from "../alerts.ts";
import { fetchActiveAlerts } from "./alertmanager.ts";
import type { IntakeConfig } from "./config.ts";
import type { WorkflowClient } from "./kube.ts";
import { TriageQueue } from "./queue.ts";
import {
  branchFor,
  buildWorkflow,
  GROUP_LABEL,
  groupHash,
} from "./workflow.ts";

export type SubmissionStatus = "submitted" | "running" | "dry-run" | "error";

export interface Submission {
  key: string;
  alertname: string;
  namespace?: string;
  branch: string;
  status: SubmissionStatus;
  workflow?: string;
  error?: string;
  at: string;
}

export class RecordStore<T> {
  private readonly items: T[] = [];

  constructor(private readonly capacity: number) {}

  add(item: T): void {
    this.items.unshift(item);
    this.items.length = Math.min(this.items.length, this.capacity);
  }

  list(): readonly T[] {
    return this.items;
  }
}

export class Metrics {
  alertsReceived = 0;
  sweepFailures = 0;
  private readonly submissions = new Map<SubmissionStatus, number>();

  submitted(status: SubmissionStatus): void {
    this.submissions.set(status, (this.submissions.get(status) ?? 0) + 1);
  }

  render(queueDepth: number): string {
    const statuses: SubmissionStatus[] = [
      "submitted",
      "running",
      "dry-run",
      "error",
    ];
    return [
      "# TYPE triage_agent_alerts_received_total counter",
      `triage_agent_alerts_received_total ${this.alertsReceived}`,
      "# TYPE triage_agent_sweep_failures_total counter",
      `triage_agent_sweep_failures_total ${this.sweepFailures}`,
      "# TYPE triage_agent_workflow_submissions_total counter",
      ...statuses.map(
        (s) =>
          `triage_agent_workflow_submissions_total{status="${s}"} ${this.submissions.get(s) ?? 0}`,
      ),
      "# TYPE triage_agent_queue_depth gauge",
      `triage_agent_queue_depth ${queueDepth}`,
      "",
    ].join("\n");
  }
}

export interface IntakeDeps {
  client: WorkflowClient;
  logger: Logger;
  now?: () => Date;
}

/**
 * Alert intake: groups, dedupes and cools down alerts, then submits one
 * triage-fix Workflow per group unless one for the group is still running.
 */
export function createIntake(config: IntakeConfig, deps: IntakeDeps) {
  const { logger, client } = deps;
  const now = deps.now ?? (() => new Date());
  const records = new RecordStore<Submission>(config.maxRecords);
  const metrics = new Metrics();

  async function submit(group: AlertGroup): Promise<void> {
    const base = {
      key: group.key,
      alertname: group.alertname,
      ...(group.namespace ? { namespace: group.namespace } : {}),
      branch: branchFor(group),
      at: now().toISOString(),
    };
    const manifest = buildWorkflow(group, {
      namespace: config.workflowNamespace,
      template: config.workflowTemplate,
    });
    let record: Submission;
    if (config.dryRun) {
      logger.info({ manifest }, "dry run: workflow not submitted");
      record = { ...base, status: "dry-run" };
    } else {
      const active = await client.listActive(
        config.workflowNamespace,
        `${GROUP_LABEL}=${groupHash(group)}`,
      );
      if (active.length > 0) {
        record = { ...base, status: "running", workflow: active[0] ?? "" };
      } else {
        const name = await client.create(manifest);
        record = { ...base, status: "submitted", workflow: name };
      }
    }
    records.add(record);
    metrics.submitted(record.status);
    logger.info(record, "alert group handled");
  }

  const queue = new TriageQueue(submit, {
    cooldownMs: config.cooldownSeconds * 1000,
    onError: (group, error) => {
      const message = error instanceof Error ? error.message : String(error);
      records.add({
        key: group.key,
        alertname: group.alertname,
        branch: branchFor(group),
        status: "error",
        error: message,
        at: now().toISOString(),
      });
      metrics.submitted("error");
      logger.error(
        { err: error, key: group.key },
        "workflow submission failed",
      );
    },
  });

  function handleAlerts(alerts: Alert[]): void {
    metrics.alertsReceived += alerts.length;
    for (const group of groupAlerts(alerts, config.ignoredAlerts)) {
      const outcome = queue.offer(group);
      logger.info(
        { key: group.key, alerts: group.alerts.length, outcome },
        "alert group offered",
      );
    }
  }

  async function sweep(): Promise<void> {
    try {
      handleAlerts(await fetchActiveAlerts(config.alertmanagerUrl));
    } catch (error) {
      metrics.sweepFailures++;
      logger.error({ err: error }, "Alertmanager sweep failed");
    }
  }

  return {
    records,
    metrics,
    handleAlerts,
    sweep,
    queueDepth: () => queue.depth(),
    idle: () => queue.idle(),
  };
}
