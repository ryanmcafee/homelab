import { afterAll, describe, expect, test } from "bun:test";
import type { Alert } from "../../src/alerts.ts";
import { fetchActiveAlerts, postToSlack } from "../../src/alertmanager.ts";
import { createHandler, Metrics } from "../../src/server.ts";
import { ReportStore } from "../../src/triage.ts";

const payload = {
  version: "4",
  alerts: [
    {
      status: "firing",
      labels: { alertname: "HomelabNodeNotReady", node: "worker-1" },
      annotations: {},
      startsAt: "2026-09-25T10:00:00Z",
      fingerprint: "f1",
    },
  ],
};

function setup() {
  const received: Alert[][] = [];
  const reports = new ReportStore(5);
  const metrics = new Metrics();
  const handle = createHandler({
    onAlerts: (alerts) => {
      received.push(alerts);
    },
    reports,
    metrics,
    queueDepth: () => 2,
  });
  return { handle, received, reports, metrics };
}

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://x/webhook", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });

describe("createHandler", () => {
  test("accepts a webhook and hands its firing alerts over", async () => {
    const { handle, received } = setup();
    const res = await handle(post(JSON.stringify(payload)));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(received[0]?.[0]?.fingerprint).toBe("f1");
  });

  test("rejects malformed JSON and invalid payloads with 400", async () => {
    const { handle, received } = setup();
    expect((await handle(post("{"))).status).toBe(400);
    const invalid = await handle(post(JSON.stringify({ version: "4" })));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("alerts");
    expect(received.length).toBe(0);
  });

  test("rejects bodies over the size limit with 413", async () => {
    const { handle } = setup();
    const res = await handle(post("x".repeat(1024 * 1024 + 1)));
    expect(res.status).toBe(413);
  });

  test("answers healthz, reports, metrics and 404", async () => {
    const { handle, reports, metrics } = setup();
    reports.add({
      id: "r1",
      key: "k",
      alertname: "A",
      fingerprints: [],
      startedAt: "",
      finishedAt: "",
      status: "ok",
      text: "t",
      costUsd: 0.5,
      turns: 1,
    });
    metrics.runFinished("ok", 0.5);
    expect((await handle(new Request("http://x/healthz"))).status).toBe(200);
    const list = await (await handle(new Request("http://x/reports"))).json();
    expect(list).toMatchObject([{ id: "r1" }]);
    const text = await (await handle(new Request("http://x/metrics"))).text();
    expect(text).toContain('triage_agent_runs_total{status="ok"} 1');
    expect(text).toContain("triage_agent_cost_usd_total 0.5");
    expect(text).toContain("triage_agent_queue_depth 2");
    expect((await handle(new Request("http://x/nope"))).status).toBe(404);
    expect(
      (await handle(new Request("http://x/webhook", { method: "GET" }))).status,
    ).toBe(405);
  });
});

describe("Alertmanager and Slack clients", () => {
  const seen: Request[] = [];
  const slackBodies: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(req);
      const url = new URL(req.url);
      if (url.pathname === "/api/v2/alerts") {
        return Response.json([
          {
            labels: { alertname: "A" },
            annotations: {},
            startsAt: "2026-09-25T10:00:00Z",
            fingerprint: "a1",
            status: { state: "active" },
          },
        ]);
      }
      if (url.pathname === "/slack") {
        slackBodies.push(await req.json());
        return new Response("ok");
      }
      return new Response("nope", { status: 500 });
    },
  });
  afterAll(() => server.stop(true));
  const base = `http://localhost:${server.port}`;

  test("fetches active, unsilenced, uninhibited alerts", async () => {
    const alerts = await fetchActiveAlerts(base);
    expect(alerts.map((a) => a.fingerprint)).toEqual(["a1"]);
    const url = new URL(seen[0]?.url ?? "");
    expect(url.searchParams.get("active")).toBe("true");
    expect(url.searchParams.get("silenced")).toBe("false");
    expect(url.searchParams.get("inhibited")).toBe("false");
  });

  test("throws with the status when Alertmanager fails", async () => {
    await expect(fetchActiveAlerts(`${base}/broken`)).rejects.toThrow(/500/);
  });

  test("posts a report to Slack", async () => {
    await postToSlack(`${base}/slack`, "*A* ok");
    expect(seen.at(-1)?.method).toBe("POST");
    expect(slackBodies).toEqual([{ text: "*A* ok" }]);
  });
});
