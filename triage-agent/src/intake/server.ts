import { ZodError } from "zod";
import { type Alert, parseWebhook } from "../alerts.ts";
import type { Metrics, RecordStore, Submission } from "./intake.ts";
import { type Outcome, type RedMetrics, UNMATCHED_ROUTE } from "./red.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface HandlerDeps {
  onAlerts: (alerts: Alert[]) => void;
  records: RecordStore<Submission>;
  metrics: Metrics;
  queueDepth: () => number;
  /** Further exposition text appended to /metrics (the workspace janitor). */
  extraMetrics?: () => string;
  red: RedMetrics;
  requestTimeoutMs: number;
  /** Monotonic milliseconds; performance.now by default. */
  now?: () => number;
}

type Handler = (req: Request) => Promise<Response>;

/** Probes and scrapes, never observed (metrics.v1.yaml observation.excluded). */
const UNOBSERVED_PATHS = new Set(["/healthz", "/metrics"]);
const ROUTES = new Set(["POST /webhook", "GET /submissions"]);

export function routeOf(req: Request): string {
  const route = `${req.method} ${new URL(req.url).pathname}`;
  return ROUTES.has(route) ? route : UNMATCHED_ROUTE;
}

export function classify(status: number): Outcome {
  if (status === 503) return { outcome: "error", code: "unavailable" };
  if (status === 504) return { outcome: "error", code: "timeout" };
  if (status >= 500) return { outcome: "error", code: "internal" };
  if (status === 429) return { outcome: "error", code: "throttled" };
  return { outcome: "success" };
}

function withDeadline(work: Promise<Response>, ms: number) {
  let timer: Timer | undefined;
  const deadline = new Promise<Response>((resolve) => {
    timer = setTimeout(
      () => resolve(new Response("request timed out\n", { status: 504 })),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Observes each request exactly once, from a finally path, under a deadline. */
export function instrument(
  handler: Handler,
  opts: { red: RedMetrics; requestTimeoutMs: number; now?: () => number },
): Handler {
  const now = opts.now ?? (() => performance.now());
  return async (req) => {
    if (UNOBSERVED_PATHS.has(new URL(req.url).pathname)) return handler(req);
    const start = now();
    let outcome: Outcome = { outcome: "error", code: "internal" };
    try {
      const res = await withDeadline(handler(req), opts.requestTimeoutMs);
      outcome = classify(res.status);
      return res;
    } finally {
      opts.red.observe(
        { kind: "http", route: routeOf(req), ...outcome },
        (now() - start) / 1000,
      );
    }
  };
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

export function createHandler(deps: HandlerDeps): Handler {
  const route = async (req: Request): Promise<Response> => {
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
            deps.red.render() +
            (deps.extraMetrics?.() ?? ""),
          {
            headers: { "content-type": "text/plain; version=0.0.4" },
          },
        );
      default:
        return new Response("not found\n", { status: 404 });
    }
  };
  return instrument(route, deps);
}
