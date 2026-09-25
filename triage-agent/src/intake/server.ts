import { ZodError } from "zod";
import { type Alert, parseWebhook } from "../alerts.ts";
import type { Metrics, RecordStore, Submission } from "./intake.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface HandlerDeps {
  onAlerts: (alerts: Alert[]) => void;
  records: RecordStore<Submission>;
  metrics: Metrics;
  queueDepth: () => number;
  /** Further exposition text appended to /metrics (the workspace janitor). */
  extraMetrics?: () => string;
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
      case "/submissions":
        return Response.json(deps.records.list());
      case "/metrics":
        return new Response(
          deps.metrics.render(deps.queueDepth()) +
            (deps.extraMetrics?.() ?? ""),
          {
            headers: { "content-type": "text/plain; version=0.0.4" },
          },
        );
      default:
        return new Response("not found\n", { status: 404 });
    }
  };
}
