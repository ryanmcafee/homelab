#!/usr/bin/env -S bun test
/**
 * Unit tests for the LiteLLM route drift gate, and the gate itself: the last
 * block reads the real charts/litellm-config/values.yaml against a rendered
 * Ingress fixture built from the pinned chart's own $uiPaths/$gatewayPrefixes,
 * so editing one without the other fails CI instead of 404ing a data-plane
 * route in production.
 *
 * Every negative case seeds one drift into that fixture and asserts the gate
 * names the path that moved.
 *
 *   bun test scripts/litellm-route-drift_test.ts
 */

import { readFileSync } from "node:fs";
import { test } from "bun:test";
import { assert, assertEquals, assertStringIncludes } from "./lib/assert.ts";
import {
  diffRoutes,
  EXEMPT_GATEWAY_PATHS,
  extractRenderedRoutes,
  type Finding,
  parseConfiguredRoutes,
  renderFindings,
  resolveChartPin,
} from "./litellm-route-drift.ts";

const ROUTE_VALUES_PATH = "charts/litellm-config/values.yaml";

const UI_SERVICE = "litellm-ui";
const UI_PORT = 3000;
const BACKEND_SERVICE = "litellm-backend";
const BACKEND_PORT = 4001;
const GATEWAY_SERVICE = "litellm-gateway";
const GATEWAY_PORT = 4000;

interface Entry {
  path: string;
  pathType: string;
  service: string;
  port: number;
}

/** Builds a rendered Ingress the way the upstream template lays it out. */
function ingress(entries: Entry[]): string {
  const paths = entries
    .map(
      (e) =>
        `          - path: ${e.path}\n` +
        `            pathType: ${e.pathType}\n` +
        "            backend:\n" +
        "              service:\n" +
        `                name: ${e.service}\n` +
        "                port:\n" +
        `                  number: ${e.port}`,
    )
    .join("\n");
  return [
    "apiVersion: networking.k8s.io/v1",
    "kind: Ingress",
    "metadata:",
    "  name: litellm",
    "spec:",
    "  rules:",
    '    - host: "litellm.example.com"',
    "      http:",
    "        paths:",
    paths,
    "",
  ].join("\n");
}

const ui = (path: string, pathType = "Prefix"): Entry => ({
  path,
  pathType,
  service: UI_SERVICE,
  port: UI_PORT,
});
const gateway = (path: string, pathType = "Prefix"): Entry => ({
  path,
  pathType,
  service: GATEWAY_SERVICE,
  port: GATEWAY_PORT,
});
const backend = (path: string, pathType = "Prefix"): Entry => ({
  path,
  pathType,
  service: BACKEND_SERVICE,
  port: BACKEND_PORT,
});

/**
 * $uiPaths of the pinned chart (templates/ingress.yaml, controller=alb).
 */
const UPSTREAM_UI: Entry[] = [
  ui("/", "Exact"),
  ui("/favicon.ico", "Exact"),
  ui("/litellm-asset-prefix"),
  ui("/_next"),
  ui("/ui"),
  ui("/*.txt", "ImplementationSpecific"),
];

/** The two Exact gateway paths the template renders inline. */
const UPSTREAM_GATEWAY_EXACT: Entry[] = [
  gateway("/test", "Exact"),
  gateway("/debug/memory/summary", "Exact"),
];

/** $gatewayPrefixes of the pinned chart, in template order. */
const UPSTREAM_GATEWAY_PREFIXES: string[] = [
  "/v1/chat",
  "/chat",
  "/v1/completions",
  "/completions",
  "/v1/embeddings",
  "/embeddings",
  "/v1/moderations",
  "/moderations",
  "/v1/audio",
  "/audio",
  "/v1/images",
  "/images",
  "/v1/files",
  "/files",
  "/v1/batches",
  "/batches",
  "/v1/fine_tuning",
  "/fine_tuning",
  "/v1/fine-tuning",
  "/fine-tuning",
  "/v1/responses",
  "/responses",
  "/v1/threads",
  "/threads",
  "/v1/assistants",
  "/assistants",
  "/v1/vector_stores",
  "/vector_stores",
  "/v1/indexes",
  "/v1/models",
  "/models",
  "/openai",
  "/engines",
  "/v1/messages",
  "/messages",
  "/v1/skills",
  "/v1/a2a",
  "/a2a",
  "/v1/rerank",
  "/v2/rerank",
  "/rerank",
  "/v1/ocr",
  "/ocr",
  "/v1/rag",
  "/rag",
  "/v1/video",
  "/v1/videos",
  "/video",
  "/videos",
  "/v1/search",
  "/search",
  "/v1/containers",
  "/containers",
  "/v1/evals",
  "/v1/memory",
  "/queue/chat",
  "/v1beta",
  "/interactions",
  "/anthropic",
  "/azure",
  "/azure_ai",
  "/aws",
  "/bedrock",
  "/comprehendmedical",
  "/cohere",
  "/gemini",
  "/google",
  "/vertex_ai",
  "/vertex-ai",
  "/assemblyai",
  "/eu.assemblyai",
  "/langfuse",
  "/vllm",
  "/mistral",
  "/groq",
  "/voyage",
  "/cursor",
  "/milvus",
  "/openai_passthrough",
  "/toolset",
  "/v1/realtime",
  "/realtime",
  "/health",
  "/metrics",
];

/** The catch-all the template renders last. */
const UPSTREAM_CATCH_ALL: Entry[] = [backend("/")];

function upstreamEntries(): Entry[] {
  return [
    ...UPSTREAM_UI,
    ...UPSTREAM_GATEWAY_EXACT,
    ...UPSTREAM_GATEWAY_PREFIXES.map((p) => gateway(p)),
    ...UPSTREAM_CATCH_ALL,
  ];
}

const realValues = () =>
  parseConfiguredRoutes(readFileSync(ROUTE_VALUES_PATH, "utf8"));

function findingsFor(entries: Entry[]): Finding[] {
  const cfg = realValues();
  return diffRoutes(extractRenderedRoutes(ingress(entries), cfg), cfg);
}

function detailsOf(findings: Finding[]): string {
  return findings.map((f) => `${f.subject}: ${f.detail}`).join("\n");
}

// ============================================================================
// Extraction
// ============================================================================

test("extraction groups the rendered paths by the Service each one targets", () => {
  const cfg = realValues();
  const r = extractRenderedRoutes(ingress(upstreamEntries()), cfg);
  assertEquals(r.uiExactPaths, ["/", "/favicon.ico"]);
  assertEquals(r.uiPathPrefixes, ["/litellm-asset-prefix", "/_next", "/ui"]);
  assertEquals(r.uiWildcardPaths, ["/*.txt"]);
  assertEquals(r.gatewayExactPaths, ["/test", "/debug/memory/summary"]);
  assertEquals(r.gatewayPathPrefixes.length, UPSTREAM_GATEWAY_PREFIXES.length);
  // The backend catch-all is derived, not listed, so it lands in no bucket.
  assert(
    r.targets.has(BACKEND_SERVICE),
    "the backend Service should still be recorded as a target",
  );
});

test("a rendered document that is not an Ingress is an error, not empty drift", () => {
  const cfg = realValues();
  let threw = "";
  try {
    extractRenderedRoutes("apiVersion: v1\nkind: Service\nspec: {}\n", cfg);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(threw, "expected kind Ingress");
});

// ============================================================================
// The gate against the real committed values
// ============================================================================

test("the committed route lists match the pinned upstream chart", () => {
  const findings = findingsFor(upstreamEntries());
  assertEquals(
    findings.length,
    0,
    `expected no drift, got:\n${detailsOf(findings)}`,
  );
});

test("the deliberately dropped paths are the two documented ones", () => {
  assertEquals([...EXEMPT_GATEWAY_PATHS].sort(), [
    "/debug/memory/summary",
    "/metrics",
  ]);
  const cfg = realValues();
  for (const p of EXEMPT_GATEWAY_PATHS) {
    assert(
      !cfg.gatewayPathPrefixes.includes(p) &&
        !cfg.gatewayExactPaths.includes(p),
      `${p} is exempt but ${ROUTE_VALUES_PATH} lists it`,
    );
  }
});

test("the chart pin agrees between versions.yaml and the Application values", () => {
  const pin = resolveChartPin(
    readFileSync("configuration/versions.yaml", "utf8"),
    readFileSync("charts/applications/values.yaml", "utf8"),
  );
  assertEquals(pin.name, "litellm");
  assertStringIncludes(pin.repo, "ghcr.io/berriai/litellm/chart");
  assert(
    /^\d+\.\d+\.\d+/.test(pin.version),
    `odd chart version ${pin.version}`,
  );
});

test("a chart pin disagreement fails rather than rendering the wrong version", () => {
  let threw = "";
  try {
    resolveChartPin(
      "charts:\n  litellm: 1.102.1\n",
      "litellm:\n  proxy:\n    chart:\n      name: litellm\n      repo: ghcr.io/berriai/litellm/chart\n      version: 1.99.0\n",
    );
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(threw, "chart version disagreement");
});

// ============================================================================
// Seeded drift: a path moves between the gateway and the backend
// ============================================================================

test("a gateway prefix moved to the backend upstream is named as missing", () => {
  const entries = upstreamEntries().map((e) =>
    e.path === "/v1/responses" ? backend("/v1/responses") : e,
  );
  const findings = findingsFor(entries);
  const text = detailsOf(findings);
  assertEquals(findings.length, 1, text);
  assertStringIncludes(text, "route.gatewayPathPrefixes");
  assertStringIncludes(text, "/v1/responses");
  assertStringIncludes(text, "upstream no longer serves");
});

test("a new upstream gateway prefix is named as an addition", () => {
  const entries = [...upstreamEntries(), gateway("/v1/telepathy")];
  const findings = findingsFor(entries);
  const text = detailsOf(findings);
  assertEquals(findings.length, 1, text);
  assertStringIncludes(text, "route.gatewayPathPrefixes");
  assertStringIncludes(text, "/v1/telepathy");
  assertStringIncludes(text, "404");
});

test("a path that moves from the gateway to the UI is named on both lists", () => {
  const entries = upstreamEntries().map((e) =>
    e.path === "/health" ? ui("/health") : e,
  );
  const text = detailsOf(findingsFor(entries));
  assertStringIncludes(text, "route.gatewayPathPrefixes");
  assertStringIncludes(text, "route.uiPathPrefixes");
  assertStringIncludes(text, "/health");
});

test("a gateway Exact path dropped upstream is named", () => {
  const entries = upstreamEntries().filter((e) => e.path !== "/test");
  const text = detailsOf(findingsFor(entries));
  assertStringIncludes(text, "route.gatewayExactPaths");
  assertStringIncludes(text, "/test");
});

test("an Exact path that becomes a Prefix upstream is drift on both buckets", () => {
  const entries = upstreamEntries().map((e) =>
    e.path === "/test" ? gateway("/test") : e,
  );
  const text = detailsOf(findingsFor(entries));
  assertStringIncludes(text, "route.gatewayExactPaths");
  assertStringIncludes(text, "route.gatewayPathPrefixes");
  assertStringIncludes(text, "/test");
});

test("a UI Exact path dropped upstream is named", () => {
  const entries = upstreamEntries().filter((e) => e.path !== "/favicon.ico");
  const text = detailsOf(findingsFor(entries));
  assertStringIncludes(text, "route.uiExactPaths");
  assertStringIncludes(text, "/favicon.ico");
});

// ============================================================================
// Seeded drift: the exemptions
// ============================================================================

test("an exempt path is not reported while it stays out of values.yaml", () => {
  // /metrics and /debug/memory/summary are in the pristine fixture already.
  assertEquals(findingsFor(upstreamEntries()).length, 0);
});

test("re-adding an exempt path to values.yaml is reported, not absorbed", () => {
  const cfg = realValues();
  cfg.gatewayPathPrefixes = [...cfg.gatewayPathPrefixes, "/metrics"];
  const findings = diffRoutes(
    extractRenderedRoutes(ingress(upstreamEntries()), cfg),
    cfg,
  );
  const text = detailsOf(findings);
  assertStringIncludes(text, "route.gatewayPathPrefixes");
  assertStringIncludes(text, "/metrics");
  assertStringIncludes(text, "drops on purpose");
});

test("an exempt path that upstream stops serving is not a phantom removal", () => {
  const entries = upstreamEntries().filter((e) => e.path !== "/metrics");
  assertEquals(detailsOf(findingsFor(entries)), "");
});

// ============================================================================
// Seeded drift: the Services behind the routes
// ============================================================================

test("an upstream Service rename is named rather than emptying a bucket", () => {
  const entries = upstreamEntries().map((e) =>
    e.service === GATEWAY_SERVICE ? { ...e, service: "litellm-proxy" } : e,
  );
  const text = detailsOf(findingsFor(entries));
  assertStringIncludes(text, "litellm-proxy");
  assertStringIncludes(text, "does not name");
  assertStringIncludes(text, "never names it");
});

test("an upstream port move is named", () => {
  const entries = upstreamEntries().map((e) =>
    e.service === GATEWAY_SERVICE ? { ...e, port: 8000 } : e,
  );
  const text = detailsOf(findingsFor(entries));
  assertStringIncludes(text, "route services");
  assertStringIncludes(text, "8000");
  assertStringIncludes(text, String(GATEWAY_PORT));
});

// ============================================================================
// Seeded drift: the RSC payload flag
// ============================================================================

test("dropping /*.txt upstream contradicts rscPayloads", () => {
  const entries = upstreamEntries().filter((e) => e.path !== "/*.txt");
  const text = detailsOf(findingsFor(entries));
  assertStringIncludes(text, "route.ui.rscPayloads");
  assertStringIncludes(text, "dropped the root-level");
});

test("rscPayloads false while upstream serves /*.txt is reported", () => {
  const cfg = realValues();
  cfg.rscPayloads = false;
  const findings = diffRoutes(
    extractRenderedRoutes(ingress(upstreamEntries()), cfg),
    cfg,
  );
  const text = detailsOf(findings);
  assertStringIncludes(text, "route.ui.rscPayloads");
  assertStringIncludes(text, "/*.txt");
});

// ============================================================================
// The report
// ============================================================================

test("the report names the file to edit and the command to re-run", () => {
  const entries = [...upstreamEntries(), gateway("/v1/telepathy")];
  const report = renderFindings(findingsFor(entries));
  assertStringIncludes(report, "/v1/telepathy");
  assertStringIncludes(report, ROUTE_VALUES_PATH);
  assertStringIncludes(report, "task verify:litellm-routes");
  assertStringIncludes(report, "allowlist.py");
});

test("findings are grouped by subject so one bump reads as one block", () => {
  const report = renderFindings([
    { subject: "route.gatewayPathPrefixes", detail: "first" },
    { subject: "route.gatewayPathPrefixes", detail: "second" },
  ]);
  const lines = report.split("\n");
  const idx = lines.indexOf("route.gatewayPathPrefixes:");
  assert(idx >= 0, `no subject heading in:\n${report}`);
  assertEquals(lines[idx + 1], "  - first");
  assertEquals(lines[idx + 2], "  - second");
});

// ============================================================================
// Values parsing
// ============================================================================

test("a values file missing route: is an error, not an empty comparison", () => {
  let threw = "";
  try {
    parseConfiguredRoutes("namespace: litellm\n");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(threw, "route:");
});

test("a route target without a port is an error", () => {
  let threw = "";
  try {
    parseConfiguredRoutes(
      "route:\n  ui:\n    service: litellm-ui\n  backend:\n    service: b\n    port: 1\n",
    );
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assertStringIncludes(threw, "route.ui.port");
});
