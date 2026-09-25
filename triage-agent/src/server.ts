import { ZodError } from "zod";
import { type Alert, parseWebhook } from "./alerts.ts";
import type { Report, ReportStore } from "./triage.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export class Metrics {
  alertsReceived = 0;
  sweepFailures = 0;
  private readonly runs = new Map<Report["status"], number>();
  private costUsd = 0;

  runFinished(status: Report["status"], costUsd: number): void {
    this.runs.set(status, (this.runs.get(status) ?? 0) + 1);
    this.costUsd += costUsd;
  }

  render(queueDepth: number): string {
    const runs = (["ok", "error"] as const).map(
      (s) => `triage_agent_runs_total{status="${s}"} ${this.runs.get(s) ?? 0}`,
    );
    return [
      "# TYPE triage_agent_alerts_received_total counter",
      `triage_agent_alerts_received_total ${this.alertsReceived}`,
      "# TYPE triage_agent_sweep_failures_total counter",
      `triage_agent_sweep_failures_total ${this.sweepFailures}`,
      "# TYPE triage_agent_runs_total counter",
      ...runs,
      "# TYPE triage_agent_cost_usd_total counter",
      `triage_agent_cost_usd_total ${this.costUsd}`,
      "# TYPE triage_agent_queue_depth gauge",
      `triage_agent_queue_depth ${queueDepth}`,
      "",
    ].join("\n");
  }
}

export interface HandlerDeps {
  onAlerts: (alerts: Alert[]) => void;
  reports: ReportStore;
  metrics: Metrics;
  queueDepth: () => number;
}

function badRequest(error: unknown): Response {
  const detail =
    error instanceof ZodError
      ? error.issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; ")
      : "body is not valid JSON";
  return new Response(`invalid Alertmanager webhook: ${detail}\n`, {
    status: 400,
  });
}

async function handleWebhook(req: Request, deps: HandlerDeps) {
  const body = await req.text();
  if (body.length > MAX_BODY_BYTES) {
    return new Response("payload too large\n", { status: 413 });
  }
  let alerts: Alert[];
  try {
    alerts = parseWebhook(JSON.parse(body));
  } catch (error) {
    return badRequest(error);
  }
  deps.metrics.alertsReceived += alerts.length;
  deps.onAlerts(alerts);
  return Response.json({ accepted: alerts.length }, { status: 202 });
}

export function createHandler(deps: HandlerDeps) {
  return async (req: Request): Promise<Response> => {
    const { pathname } = new URL(req.url);
    switch (pathname) {
      case "/webhook":
        return req.method === "POST"
          ? handleWebhook(req, deps)
          : new Response("method not allowed\n", { status: 405 });
      case "/healthz":
        return new Response("ok\n");
      case "/reports":
        return Response.json(deps.reports.list());
      case "/metrics":
        return new Response(deps.metrics.render(deps.queueDepth()), {
          headers: { "content-type": "text/plain; version=0.0.4" },
        });
      default:
        return new Response("not found\n", { status: 404 });
    }
  };
}
