#!/usr/bin/env -S bun test
/**
 * Unit tests for charts/paperclip/files/paperclip-agent-policy.ts. The API side
 * is a real Bun.serve stand-in for Paperclip; nothing talks to a cluster.
 *
 *   bun test scripts/paperclip-agent-policy_test.ts
 */

import { afterAll, beforeAll, beforeEach, test } from "bun:test";
import {
  enforce,
  type PolicyConfig,
  parseAgents,
  plannedRuntimeConfig,
  readConfig,
} from "../charts/paperclip/files/paperclip-agent-policy.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";

const ACTIVE = "11111111-1111-1111-1111-111111111111";
const ARCHIVED = "22222222-2222-2222-2222-222222222222";
const API_KEY = "test-board-key";

const COMPANIES = [
  { id: ACTIVE, name: "Acme", status: "active" },
  { id: ARCHIVED, name: "Old", status: "archived" },
];

function agent(id: string, runtimeConfig: unknown, status = "idle") {
  return { id, name: `agent ${id}`, status, runtimeConfig };
}

const AGENTS = [
  agent("a1", {
    heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 4 },
  }),
  agent("a2", { heartbeat: { maxConcurrentRuns: 1 } }),
  agent("a3", {}),
  agent("a4", { heartbeat: { maxConcurrentRuns: 20 } }, "terminated"),
  agent("a5", {
    aiConnection: { id: "c1" },
    heartbeat: { intervalSec: 300, maxConcurrentRuns: 20 },
  }),
];

let server: ReturnType<typeof Bun.serve>;
let patches: { path: string; body: unknown }[] = [];
let failPatchFor = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${API_KEY}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (req.method === "PATCH") {
        if (url.pathname === `/api/agents/${failPatchFor}`) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        patches.push({ path: url.pathname, body: await req.json() });
        return Response.json({});
      }
      const routes: Record<string, unknown> = {
        "/api/companies": COMPANIES,
        [`/api/companies/${ACTIVE}/agents`]: AGENTS,
      };
      const body = routes[url.pathname];
      return body === undefined
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json(body);
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  patches = [];
  failPatchFor = "";
});

function config(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    baseUrl: `http://localhost:${server.port}/api`,
    apiKey: API_KEY,
    maxConcurrentRuns: 1,
    requestTimeoutMs: 2000,
    dryRun: false,
    ...overrides,
  };
}

const quiet = () => {};

test("parseAgents rejects payloads that are not arrays of agents", () => {
  assertThrows(() => parseAgents({ agents: [] }), Error, "agents");
  assertThrows(() => parseAgents([{ id: 1 }]), Error, "agents");
});

test("plannedRuntimeConfig keeps every other key and only sets the cap", () => {
  assertEquals(
    plannedRuntimeConfig(
      {
        aiConnection: { id: "c1" },
        heartbeat: { intervalSec: 300, maxConcurrentRuns: 20 },
      },
      1,
    ),
    {
      aiConnection: { id: "c1" },
      heartbeat: { intervalSec: 300, maxConcurrentRuns: 1 },
    },
  );
  assertEquals(plannedRuntimeConfig(null, 1), {
    heartbeat: { maxConcurrentRuns: 1 },
  });
  assertEquals(
    plannedRuntimeConfig({ heartbeat: { maxConcurrentRuns: 1 } }, 1),
    null,
  );
});

test("enforce patches only live agents above or without the cap", async () => {
  const result = await enforce(config(), quiet);
  assertEquals(result, { checked: 4, updated: 3, failed: 0 });
  assertEquals(patches.map((p) => p.path).sort(), [
    "/api/agents/a1",
    "/api/agents/a3",
    "/api/agents/a5",
  ]);
  const a1 = patches.find((p) => p.path === "/api/agents/a1");
  assertEquals(a1?.body, {
    runtimeConfig: {
      heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 },
    },
  });
});

test("enforce in dry-run mode reports changes without patching", async () => {
  const lines: string[] = [];
  const result = await enforce(config({ dryRun: true }), (m) => lines.push(m));
  assertEquals(result.updated, 3);
  assertEquals(patches, []);
  assertStringIncludes(lines.join("\n"), "dry-run");
});

test("enforce counts a rejected patch and still updates the others", async () => {
  failPatchFor = "a3";
  const lines: string[] = [];
  const result = await enforce(config(), (m) => lines.push(m));
  assertEquals(result, { checked: 4, updated: 2, failed: 1 });
  assertStringIncludes(lines.join("\n"), "HTTP 403");
});

test("enforce fails fast without an API key or with a bad key", async () => {
  await assertRejects(
    () => enforce(config({ apiKey: "" }), quiet),
    Error,
    "PAPERCLIP_API_KEY",
  );
  await assertRejects(
    () => enforce(config({ apiKey: "wrong" }), quiet),
    Error,
    "HTTP 401",
  );
  assert(patches.length === 0);
});

test("readConfig applies defaults and validates the cap", () => {
  const cfg = readConfig({
    PAPERCLIP_API_URL: "http://paperclip:3100/api/",
    PAPERCLIP_API_KEY: "k",
  });
  assertEquals(cfg.baseUrl, "http://paperclip:3100/api");
  assertEquals(cfg.maxConcurrentRuns, 1);
  assertEquals(cfg.dryRun, false);
  assertEquals(
    readConfig({ PAPERCLIP_API_URL: "http://x/api", DRY_RUN: "true" }).dryRun,
    true,
  );
  assertThrows(
    () =>
      readConfig({
        PAPERCLIP_API_URL: "http://x/api",
        MAX_CONCURRENT_RUNS: "51",
      }),
    Error,
    "MAX_CONCURRENT_RUNS",
  );
  assertThrows(() => readConfig({}), Error, "PAPERCLIP_API_URL");
});
