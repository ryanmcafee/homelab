import { afterAll, describe, expect, test } from "bun:test";
import pino from "pino";
import type { Alert } from "../../src/alerts.ts";
import { alertGroupSchema } from "../../src/alerts.ts";
import { fetchActiveAlerts } from "../../src/intake/alertmanager.ts";
import { readIntakeConfig } from "../../src/intake/config.ts";
import { createIntake } from "../../src/intake/intake.ts";
import {
  httpWorkflowClient,
  type WorkflowClient,
} from "../../src/intake/kube.ts";
import { createHandler } from "../../src/intake/server.ts";
import {
  branchFor,
  buildWorkflow,
  GROUP_LABEL,
  slug,
} from "../../src/intake/workflow.ts";
import { group } from "./fixtures.ts";

const alert = (
  name: string,
  fingerprint: string,
  namespace = "plex",
): Alert => ({
  fingerprint,
  name,
  labels: { alertname: name, namespace, severity: "critical" },
  annotations: {},
  startsAt: "2026-09-25T10:00:00Z",
});

const config = readIntakeConfig({
  ALERTMANAGER_URL: "http://am.monitoring.svc:9093/",
  WORKFLOW_NAMESPACE: "triage-agent",
  IGNORED_ALERTS: "Watchdog,GitHubPullRequestNeedsReview",
});

function fakeClient(active: string[] = []) {
  const created: unknown[] = [];
  const selectors: string[] = [];
  const client: WorkflowClient = {
    create: async (manifest) => {
      created.push(manifest);
      return `triage-x-${created.length}`;
    },
    listActive: async (_ns, selector) => {
      selectors.push(selector);
      return active;
    },
  };
  return { client, created, selectors };
}

const silent = pino({ level: "silent" });

describe("readIntakeConfig", () => {
  test("applies defaults and trims the Alertmanager URL", () => {
    expect(config).toMatchObject({
      port: 8080,
      alertmanagerUrl: "http://am.monitoring.svc:9093",
      sweepIntervalSeconds: 300,
      cooldownSeconds: 86400,
      workflowTemplate: "triage-fix",
      dryRun: false,
    });
    expect(config.ignoredAlerts.has("GitHubPullRequestNeedsReview")).toBe(true);
  });

  test("requires the workflow namespace and an http Alertmanager URL", () => {
    expect(() => readIntakeConfig({ ALERTMANAGER_URL: "http://am" })).toThrow(
      /WORKFLOW_NAMESPACE/,
    );
    expect(() =>
      readIntakeConfig({
        ALERTMANAGER_URL: "file:///x",
        WORKFLOW_NAMESPACE: "t",
      }),
    ).toThrow(/ALERTMANAGER_URL/);
  });
});

describe("buildWorkflow", () => {
  test("references the template and carries the group as parameters", () => {
    const wf = buildWorkflow(group, {
      namespace: "triage-agent",
      template: "triage-fix",
    });
    expect(wf.metadata.generateName).toBe("triage-kubepodcrashlooping-");
    expect(wf.metadata.labels[GROUP_LABEL]).toMatch(/^[0-9a-f]{8}$/);
    expect(wf.spec.workflowTemplateRef).toEqual({ name: "triage-fix" });
    const params = Object.fromEntries(
      wf.spec.arguments.parameters.map((p) => [p.name, p.value]),
    );
    expect(params.alertname).toBe("kubepodcrashlooping");
    expect(params.branch).toBe(branchFor(group));
    expect(
      alertGroupSchema.parse(JSON.parse(params["alert-group"] ?? "")),
    ).toEqual(group);
  });

  test("branch names are stable per group and valid refs", () => {
    expect(branchFor(group)).toBe(branchFor({ ...group, alerts: [] }));
    expect(branchFor(group)).toMatch(
      /^triage\/kubepodcrashlooping-[0-9a-f]{8}$/,
    );
    expect(branchFor({ ...group, key: "other" })).not.toBe(branchFor(group));
  });

  test("slug keeps label-safe characters only", () => {
    expect(slug("Kube/Pod Crash__Looping!!")).toBe("kube-pod-crash-looping");
    expect(slug("!!!")).toBe("alert");
    expect(slug("a".repeat(80)).length).toBe(40);
  });
});

describe("createIntake", () => {
  test("submits one workflow per new group and skips ignored alerts", async () => {
    const { client, created, selectors } = fakeClient();
    const intake = createIntake(config, { client, logger: silent });
    intake.handleAlerts([
      alert("PlexDown", "p1"),
      alert("Watchdog", "w1"),
      alert("GitHubPullRequestNeedsReview", "g1"),
    ]);
    intake.handleAlerts([alert("PlexDown", "p1")]);
    await intake.idle();
    expect(created.length).toBe(1);
    expect(selectors[0]).toMatch(new RegExp(`^${GROUP_LABEL}=[0-9a-f]{8}$`));
    expect(intake.records.list()[0]).toMatchObject({
      alertname: "PlexDown",
      status: "submitted",
      workflow: "triage-x-1",
    });
    expect(intake.metrics.render(0)).toContain(
      'triage_agent_workflow_submissions_total{status="submitted"} 1',
    );
  });

  test("does not submit while a workflow for the group still runs", async () => {
    const { client, created } = fakeClient(["triage-plexdown-abc"]);
    const intake = createIntake(config, { client, logger: silent });
    intake.handleAlerts([alert("PlexDown", "p1")]);
    await intake.idle();
    expect(created.length).toBe(0);
    expect(intake.records.list()[0]?.status).toBe("running");
  });

  test("dry run submits nothing", async () => {
    const { client, created } = fakeClient();
    const intake = createIntake(
      { ...config, dryRun: true },
      { client, logger: silent },
    );
    intake.handleAlerts([alert("PlexDown", "p1")]);
    await intake.idle();
    expect(created.length).toBe(0);
    expect(intake.records.list()[0]?.status).toBe("dry-run");
  });

  test("records a failed submission", async () => {
    const client: WorkflowClient = {
      create: async () => {
        throw new Error("forbidden");
      },
      listActive: async () => [],
    };
    const intake = createIntake(config, { client, logger: silent });
    intake.handleAlerts([alert("PlexDown", "p1")]);
    await intake.idle();
    expect(intake.records.list()[0]).toMatchObject({
      status: "error",
      error: "forbidden",
    });
  });
});

describe("createHandler", () => {
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
    const intake = createIntake(config, {
      client: fakeClient().client,
      logger: silent,
    });
    const handle = createHandler({
      onAlerts: (alerts) => {
        received.push(alerts);
      },
      records: intake.records,
      metrics: intake.metrics,
      queueDepth: () => 2,
    });
    return { handle, received };
  }

  const post = (body: string) =>
    new Request("http://x/webhook", { method: "POST", body });

  test("accepts a webhook and hands its firing alerts over", async () => {
    const { handle, received } = setup();
    const res = await handle(post(JSON.stringify(payload)));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(received[0]?.[0]?.fingerprint).toBe("f1");
  });

  test("rejects malformed, invalid and oversized payloads", async () => {
    const { handle, received } = setup();
    expect((await handle(post("{"))).status).toBe(400);
    const invalid = await handle(post(JSON.stringify({ version: "4" })));
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("alerts");
    expect((await handle(post("x".repeat(1024 * 1024 + 1)))).status).toBe(413);
    expect(received.length).toBe(0);
  });

  test("answers healthz, submissions, metrics, 404 and 405", async () => {
    const { handle } = setup();
    expect((await handle(new Request("http://x/healthz"))).status).toBe(200);
    expect(
      await (await handle(new Request("http://x/submissions"))).json(),
    ).toEqual([]);
    const text = await (await handle(new Request("http://x/metrics"))).text();
    expect(text).toContain("triage_agent_queue_depth 2");
    expect((await handle(new Request("http://x/nope"))).status).toBe(404);
    expect(
      (await handle(new Request("http://x/webhook", { method: "GET" }))).status,
    ).toBe(405);
  });
});

describe("HTTP clients", () => {
  const requests: {
    method: string;
    url: string;
    auth: string;
    body: string;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        url: url.pathname + url.search,
        auth: req.headers.get("authorization") ?? "",
        body: await req.text(),
      });
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
      if (url.pathname.startsWith("/apis/") && req.method === "POST") {
        return Response.json(
          { metadata: { name: "triage-a-xyz" } },
          { status: 201 },
        );
      }
      if (url.pathname.startsWith("/apis/")) {
        return Response.json({
          items: [{ metadata: { name: "triage-a-old" } }],
        });
      }
      return new Response("forbidden", { status: 403 });
    },
  });
  afterAll(() => server.stop(true));
  const base = `http://localhost:${server.port}`;

  test("fetches active, unsilenced, uninhibited alerts", async () => {
    const alerts = await fetchActiveAlerts(base);
    expect(alerts.map((a) => a.fingerprint)).toEqual(["a1"]);
    expect(requests.at(-1)?.url).toBe(
      "/api/v2/alerts?active=true&silenced=false&inhibited=false",
    );
    await expect(fetchActiveAlerts(`${base}/broken`)).rejects.toThrow(/403/);
  });

  test("creates and lists workflows with a fresh bearer token each call", async () => {
    let n = 0;
    const client = httpWorkflowClient({
      baseUrl: base,
      token: () => `t${++n}`,
    });
    const manifest = buildWorkflow(group, {
      namespace: "triage-agent",
      template: "triage-fix",
    });
    expect(await client.create(manifest)).toBe("triage-a-xyz");
    const created = requests.at(-1);
    expect(created?.url).toBe(
      "/apis/argoproj.io/v1alpha1/namespaces/triage-agent/workflows",
    );
    expect(created?.auth).toBe("Bearer t1");
    expect(JSON.parse(created?.body ?? "{}").kind).toBe("Workflow");

    expect(
      await client.listActive("triage-agent", `${GROUP_LABEL}=abc`),
    ).toEqual(["triage-a-old"]);
    const listed = requests.at(-1);
    expect(listed?.auth).toBe("Bearer t2");
    expect(decodeURIComponent(listed?.url ?? "")).toContain(
      "workflows.argoproj.io/completed!=true",
    );
  });

  test("throws with the API status", async () => {
    const client = httpWorkflowClient({
      baseUrl: `${base}/x`,
      token: () => "t",
    });
    await expect(client.listActive("ns", "a=b")).rejects.toThrow(/403/);
  });
});
