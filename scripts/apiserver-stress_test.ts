#!/usr/bin/env -S deno test
/**
 * Unit tests for the pure helpers in apiserver-stress.ts. Nothing here opens
 * a socket or reads a kubeconfig from disk.
 *
 *   deno test scripts/apiserver-stress_test.ts
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1";
import {
  applyLeaseFallback,
  buildPlan,
  type CellSummary,
  classifyError,
  classifyStatus,
  countErrors,
  DEFAULT_MAX_CONCURRENCY,
  describeIdentity,
  FALLBACK_PATH,
  formatDuration,
  isClientSaturated,
  kubeconfigPath,
  latencyStats,
  LEASE_PATH,
  loadCredentials,
  longestOutage,
  METHOD,
  normalizeEndpoint,
  parseArgs,
  parseConcurrency,
  parseDuration,
  percentile,
  PROBE_PATHS,
  type RequestResult,
  resolveContext,
  type StepSummary,
  STRESS_PATHS,
  summarize,
  summaryTable,
  UsageError,
} from "./apiserver-stress.ts";

const VIP = "https://vip.example.test:6443";
const CP1 = "https://cp1.example.test:6443";

function result(
  overrides: Partial<RequestResult> & {
    at: number;
    kind: RequestResult["kind"];
  },
): RequestResult {
  return {
    endpoint: VIP,
    path: "/readyz",
    status: overrides.kind === "ok" ? 200 : null,
    latencyMs: 10,
    ...overrides,
  };
}

// ----------------------------------------------------------------------------
// durations
// ----------------------------------------------------------------------------

Deno.test("parseDuration accepts 30s, 5m, plain seconds, ms and h", () => {
  assertEquals(parseDuration("30s"), 30_000);
  assertEquals(parseDuration("5m"), 300_000);
  assertEquals(parseDuration("90"), 90_000);
  assertEquals(parseDuration("250ms"), 250);
  assertEquals(parseDuration("1h"), 3_600_000);
  assertEquals(parseDuration(" 1.5s "), 1500);
});

Deno.test("parseDuration rejects junk, zero and negatives with the flag name", () => {
  for (const bad of ["", "forever", "-5s", "0", "0s", "5 minutes", "1d"]) {
    const err = assertThrows(
      () => parseDuration(bad, "step-duration"),
      UsageError,
    );
    assert(err.message.includes("--step-duration"), err.message);
  }
});

Deno.test("formatDuration picks the shortest unit", () => {
  assertEquals(formatDuration(300_000), "5m");
  assertEquals(formatDuration(90_000), "90s");
  assertEquals(formatDuration(250), "250ms");
  assertEquals(formatDuration(0), "0ms");
});

// ----------------------------------------------------------------------------
// concurrency
// ----------------------------------------------------------------------------

Deno.test("parseConcurrency parses a list and keeps the order", () => {
  assertEquals(parseConcurrency("8,32,64", DEFAULT_MAX_CONCURRENCY, false), [
    8,
    32,
    64,
  ]);
  assertEquals(parseConcurrency(" 64 , 8 ", 128, false), [64, 8]);
  assertEquals(parseConcurrency("1", 1, false), [1]);
});

Deno.test("parseConcurrency guard refuses steps above the maximum unless --i-know", () => {
  const err = assertThrows(
    () => parseConcurrency("8,256", 128, false),
    UsageError,
  );
  assert(err.message.includes("256"), err.message);
  assert(err.message.includes("--i-know"), err.message);
  assertEquals(parseConcurrency("8,256", 128, true), [8, 256]);
});

Deno.test("parseConcurrency rejects empty, zero, negative and non-numeric steps", () => {
  for (const bad of ["", ",", "0", "-8", "8,abc", "8.5", "8;32"]) {
    assertThrows(() => parseConcurrency(bad, 128, true), UsageError);
  }
});

// ----------------------------------------------------------------------------
// percentiles
// ----------------------------------------------------------------------------

Deno.test("percentile uses nearest rank and tolerates unsorted input", () => {
  const sample = [50, 10, 40, 20, 30, 60, 70, 80, 90, 100];
  assertEquals(percentile(sample, 50), 50);
  assertEquals(percentile(sample, 95), 100);
  assertEquals(percentile(sample, 99), 100);
  assertEquals(percentile(sample, 0), 10);
  assertEquals(percentile(sample, 100), 100);
  assertEquals(percentile([7], 50), 7);
  assertEquals(percentile([], 50), null);
});

Deno.test("latencyStats reports p50/p95/p99/max and nulls for an empty sample", () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  assertEquals(latencyStats(values), { p50: 50, p95: 95, p99: 99, max: 100 });
  assertEquals(latencyStats([]), {
    p50: null,
    p95: null,
    p99: null,
    max: null,
  });
});

// ----------------------------------------------------------------------------
// error classification
// ----------------------------------------------------------------------------

Deno.test("classifyError buckets timeouts, refused, reset, tls and other", () => {
  const timeout = new DOMException("signal timed out", "TimeoutError");
  assertEquals(classifyError(timeout), "timeout");
  assertEquals(
    classifyError(new DOMException("aborted", "AbortError")),
    "timeout",
  );
  assertEquals(
    classifyError(
      new TypeError(
        "error sending request for url (https://x:6443/readyz): client error (Connect): tcp connect error: Operation timed out (os error 60)",
      ),
    ),
    "timeout",
  );
  assertEquals(
    classifyError(
      new TypeError(
        "client error (Connect): tcp connect error: Connection refused (os error 61)",
      ),
    ),
    "refused",
  );
  assertEquals(
    classifyError(new TypeError("connection reset by peer (os error 54)")),
    "reset",
  );
  assertEquals(
    classifyError(new TypeError("connection closed before message completed")),
    "reset",
  );
  assertEquals(
    classifyError(
      new TypeError(
        "http2 error: stream error received: unexpected internal error encountered",
      ),
    ),
    "reset",
  );
  assertEquals(
    classifyError(new TypeError("invalid peer certificate: UnknownIssuer")),
    "tls",
  );
  assertEquals(classifyError(new TypeError("tls handshake eof")), "tls");
  assertEquals(
    classifyError(
      new TypeError("dns error: failed to lookup address information"),
    ),
    "other",
  );
  assertEquals(classifyError("weird string"), "other");
});

Deno.test("classifyStatus treats only 2xx as ok", () => {
  assertEquals(classifyStatus(200), "ok");
  assertEquals(classifyStatus(204), "ok");
  assertEquals(classifyStatus(403), "http 403");
  assertEquals(classifyStatus(500), "http 500");
  assertEquals(classifyStatus(301), "http 301");
});

Deno.test("countErrors sorts by frequency then name and skips ok", () => {
  const rs = [
    result({ at: 1, kind: "ok" }),
    result({ at: 2, kind: "timeout" }),
    result({ at: 3, kind: "http 503" }),
    result({ at: 4, kind: "timeout" }),
    result({ at: 5, kind: "refused" }),
  ];
  assertEquals(Object.entries(countErrors(rs)), [
    ["timeout", 2],
    ["http 503", 1],
    ["refused", 1],
  ]);
  assertEquals(countErrors([result({ at: 1, kind: "ok" })]), {});
});

// ----------------------------------------------------------------------------
// outages
// ----------------------------------------------------------------------------

Deno.test("longestOutage finds the longest run of consecutive failures", () => {
  const rs = [
    result({ at: 1000, kind: "ok" }),
    result({ at: 2000, kind: "timeout", latencyMs: 5000 }),
    result({ at: 3000, kind: "ok" }),
    result({ at: 4000, kind: "refused", latencyMs: 3 }),
    result({ at: 5000, kind: "timeout", latencyMs: 5000 }),
    result({ at: 6000, kind: "http 503", latencyMs: 20 }),
    result({ at: 7000, kind: "ok" }),
    result({ at: 8000, kind: "reset", latencyMs: 1 }),
  ];
  assertEquals(longestOutage(rs), { start: 4000, end: 10_000, failures: 3 });
});

Deno.test("longestOutage sorts by send time, handles a trailing outage and none at all", () => {
  const trailing = [
    result({ at: 3000, kind: "timeout", latencyMs: 5000 }),
    result({ at: 1000, kind: "ok" }),
    result({ at: 2000, kind: "timeout", latencyMs: 5000 }),
  ];
  assertEquals(longestOutage(trailing), {
    start: 2000,
    end: 8000,
    failures: 2,
  });
  assertEquals(
    longestOutage([
      result({ at: 1, kind: "ok" }),
      result({ at: 2, kind: "ok" }),
    ]),
    null,
  );
  assertEquals(longestOutage([]), null);
});

Deno.test("longestOutage breaks a tie on failures by wall-clock length", () => {
  const rs = [
    result({ at: 1000, kind: "timeout", latencyMs: 10 }),
    result({ at: 1500, kind: "timeout", latencyMs: 10 }),
    result({ at: 2000, kind: "ok" }),
    result({ at: 3000, kind: "timeout", latencyMs: 5000 }),
    result({ at: 4000, kind: "timeout", latencyMs: 5000 }),
  ];
  assertEquals(longestOutage(rs), { start: 3000, end: 9000, failures: 2 });
});

// ----------------------------------------------------------------------------
// summary
// ----------------------------------------------------------------------------

Deno.test("summarize groups per endpoint and path in first-seen order", () => {
  const rs = [
    result({ at: 1000, kind: "ok", latencyMs: 10 }),
    result({ at: 1000, kind: "ok", endpoint: CP1, latencyMs: 30 }),
    result({ at: 1000, kind: "ok", path: LEASE_PATH, latencyMs: 20 }),
    result({ at: 2000, kind: "timeout", latencyMs: 5000 }),
    result({ at: 3000, kind: "ok", latencyMs: 12 }),
  ];
  const cells = summarize(rs);
  assertEquals(cells.map((c) => [c.endpoint, c.path]), [
    [VIP, "/readyz"],
    [CP1, "/readyz"],
    [VIP, LEASE_PATH],
  ]);
  assertEquals(cells[0], {
    endpoint: VIP,
    path: "/readyz",
    count: 3,
    ok: 2,
    errors: { timeout: 1 },
    latency: { p50: 10, p95: 12, p99: 12, max: 12 },
    longestOutage: { start: 2000, end: 7000, failures: 1 },
  });
  assertEquals(cells[1].longestOutage, null);
  assertEquals(summarize([]), []);
});

Deno.test("summaryTable renders one aligned row per cell", () => {
  const table = summaryTable(summarize([
    result({ at: 0, kind: "ok", latencyMs: 10 }),
    result({ at: 1000, kind: "http 503", latencyMs: 20 }),
  ]));
  const lines = table.split("\n");
  assertEquals(lines.length, 2);
  assert(lines[0].startsWith("ENDPOINT"), lines[0]);
  assert(lines[1].startsWith(VIP), lines[1]);
  // Columns pad to the widest cell, so the endpoint column is as wide as the
  // URL, not as the "ENDPOINT" header: every column must start at the same
  // offset in the header and in the row.
  for (const [header, cell] of [["PATH", "/readyz"], ["COUNT", "2"]]) {
    assertEquals(lines[0].indexOf(header), lines[1].indexOf(cell), header);
  }
  assert(lines[1].includes("http 503=1"), lines[1]);
  assert(lines[1].includes("1 (00:00:01.000..00:00:01.020 UTC)"), lines[1]);
});

Deno.test("applyLeaseFallback swaps the Lease for /version only on a 403", () => {
  const forbidden = result({
    at: 1,
    kind: "http 403",
    status: 403,
    path: LEASE_PATH,
  });
  assertEquals(applyLeaseFallback(PROBE_PATHS, forbidden), [
    "/readyz",
    FALLBACK_PATH,
  ]);
  assertEquals(
    applyLeaseFallback(STRESS_PATHS, forbidden).includes(LEASE_PATH),
    false,
  );
  const unauthorized = { ...forbidden, kind: "http 401" as const, status: 401 };
  assertEquals(applyLeaseFallback(PROBE_PATHS, unauthorized), [...PROBE_PATHS]);
  const otherPath = { ...forbidden, path: "/readyz" };
  assertEquals(applyLeaseFallback(PROBE_PATHS, otherPath), [...PROBE_PATHS]);
});

// ----------------------------------------------------------------------------
// endpoints and paths
// ----------------------------------------------------------------------------

Deno.test("normalizeEndpoint keeps the origin and rejects paths and credentials", () => {
  assertEquals(
    normalizeEndpoint("https://10.0.0.10:6443/"),
    "https://10.0.0.10:6443",
  );
  assertEquals(normalizeEndpoint(" https://cp1.example.test:6443 "), CP1);
  for (
    const bad of [
      "cp1:6443",
      "ftp://x",
      "https://x:6443/readyz",
      "https://x:6443/?a=b",
      "https://user:pw@x:6443",
    ]
  ) {
    assertThrows(() => normalizeEndpoint(bad), UsageError);
  }
});

// ----------------------------------------------------------------------------
// kubeconfig
// ----------------------------------------------------------------------------

Deno.test("kubeconfigPath prefers the flag, then the first $KUBECONFIG entry, then ~/.kube/config", () => {
  assertEquals(kubeconfigPath("/x/kc.yaml", "/y:/z", "/home/a"), "/x/kc.yaml");
  assertEquals(
    kubeconfigPath(undefined, "/y/kc.yaml:/z", "/home/a"),
    "/y/kc.yaml",
  );
  assertEquals(kubeconfigPath(undefined, " : /z ", "/home/a"), "/z");
  assertEquals(
    kubeconfigPath(undefined, "", "/home/a"),
    "/home/a/.kube/config",
  );
  assertEquals(
    kubeconfigPath(undefined, undefined, "/home/a"),
    "/home/a/.kube/config",
  );
});

const b64 = (s: string) => btoa(s);
const CA_PEM = "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n";
const CERT_PEM = "-----BEGIN CERTIFICATE-----\ncl\n-----END CERTIFICATE-----\n";
// Assembled rather than spelled out so the detect-private-key pre-commit hook
// keeps flagging real keys instead of being taught to ignore this file. The
// body is the single letter "k": there is no key material here.
const PEM = (label: string, body: string) =>
  `${"-".repeat(5)}BEGIN ${label}${"-".repeat(5)}\n${body}\n${
    "-".repeat(5)
  }END ${label}${"-".repeat(5)}\n`;
const KEY_PEM = PEM("EC PRIVATE KEY", "k");
const TOKEN = "fixture-token-not-a-secret";

const KUBECONFIG = {
  apiVersion: "v1",
  kind: "Config",
  "current-context": "admin@homelab",
  clusters: [
    {
      name: "homelab",
      cluster: { server: VIP, "certificate-authority-data": b64(CA_PEM) },
    },
    {
      name: "readonly",
      cluster: { server: "https://proxy.example.test" },
    },
    {
      name: "files",
      cluster: { server: CP1, "certificate-authority": "certs/ca.crt" },
    },
    {
      name: "insecure",
      cluster: {
        server: CP1,
        "insecure-skip-tls-verify": true,
        "certificate-authority-data": b64(CA_PEM),
      },
    },
  ],
  contexts: [
    { name: "admin@homelab", context: { cluster: "homelab", user: "admin" } },
    {
      name: "homelab-readonly",
      context: { cluster: "readonly", user: "agent" },
    },
    { name: "files", context: { cluster: "files", user: "files-user" } },
    { name: "token-file", context: { cluster: "homelab", user: "tf" } },
    { name: "insecure", context: { cluster: "insecure", user: "admin" } },
    { name: "anon", context: { cluster: "homelab", user: "nobody" } },
    { name: "exec", context: { cluster: "homelab", user: "plugin" } },
    { name: "half", context: { cluster: "homelab", user: "half" } },
    { name: "dangling", context: { cluster: "missing", user: "admin" } },
  ],
  users: [
    {
      name: "admin",
      user: {
        "client-certificate-data": b64(CERT_PEM),
        "client-key-data": b64(KEY_PEM),
      },
    },
    { name: "agent", user: { token: TOKEN } },
    {
      name: "files-user",
      user: {
        "client-certificate": "certs/client.crt",
        "client-key": "/abs/client.key",
      },
    },
    { name: "tf", user: { tokenFile: "token.txt" } },
    { name: "nobody", user: {} },
    { name: "plugin", user: { exec: { command: "some-plugin" } } },
    { name: "half", user: { "client-certificate-data": b64(CERT_PEM) } },
  ],
};

Deno.test("resolveContext uses current-context and inline cert data", () => {
  const rc = resolveContext(KUBECONFIG);
  assertEquals(rc.context, "admin@homelab");
  assertEquals(rc.cluster, "homelab");
  assertEquals(rc.user, "admin");
  assertEquals(rc.server, VIP);
  assertEquals(rc.ca, { kind: "data", value: b64(CA_PEM) });
  assertEquals(rc.insecureSkipTlsVerify, false);
  assertEquals(rc.identity, {
    type: "cert",
    cert: { kind: "data", value: b64(CERT_PEM) },
    key: { kind: "data", value: b64(KEY_PEM) },
  });
  assertEquals(describeIdentity(rc), "client certificate (data) + key (data)");
});

Deno.test("resolveContext selects a bearer-token context without a CA", () => {
  const rc = resolveContext(KUBECONFIG, "homelab-readonly");
  assertEquals(rc.server, "https://proxy.example.test");
  assertEquals(rc.ca, null);
  assertEquals(rc.identity, {
    type: "token",
    token: { kind: "data", value: TOKEN },
  });
  assertEquals(describeIdentity(rc), "bearer token (inline)");
  assert(!describeIdentity(rc).includes(TOKEN));
});

Deno.test("resolveContext supports file variants, tokenFile and insecure-skip-tls-verify", () => {
  const files = resolveContext(KUBECONFIG, "files");
  assertEquals(files.ca, { kind: "file", value: "certs/ca.crt" });
  assertEquals(files.identity, {
    type: "cert",
    cert: { kind: "file", value: "certs/client.crt" },
    key: { kind: "file", value: "/abs/client.key" },
  });
  assertEquals(
    describeIdentity(files),
    "client certificate (file) + key (file)",
  );

  const tf = resolveContext(KUBECONFIG, "token-file");
  assertEquals(tf.identity, {
    type: "token",
    token: { kind: "file", value: "token.txt" },
  });
  assertEquals(describeIdentity(tf), "bearer token (tokenFile)");

  const insecure = resolveContext(KUBECONFIG, "insecure");
  assertEquals(insecure.insecureSkipTlsVerify, true);
  assertEquals(insecure.ca?.kind, "data");

  const anon = resolveContext(KUBECONFIG, "anon");
  assertEquals(anon.identity, { type: "none" });
  assertEquals(describeIdentity(anon), "none (anonymous)");
});

Deno.test("resolveContext rejects missing names, exec plugins and half credentials", () => {
  const bad: [string | undefined, unknown, string][] = [
    ["nope", KUBECONFIG, 'context "nope" not found'],
    ["dangling", KUBECONFIG, 'cluster "missing" not found'],
    ["exec", KUBECONFIG, "exec/auth-provider"],
    ["half", KUBECONFIG, "without a key"],
    [undefined, { clusters: [] }, "no current-context"],
    [undefined, "not a mapping", "not a YAML mapping"],
    [undefined, {
      "current-context": "c",
      contexts: [{ name: "c", context: { cluster: "k", user: "u" } }],
      clusters: [{ name: "k", cluster: {} }],
      users: [{ name: "u", user: {} }],
    }, "has no server"],
  ];
  for (const [ctx, doc, msg] of bad) {
    assertThrows(() => resolveContext(doc, ctx), UsageError, msg);
  }
});

Deno.test("loadCredentials decodes inline data and reads files relative to the kubeconfig", async () => {
  const reads: string[] = [];
  const readFile = (p: string) => {
    reads.push(p);
    if (p.endsWith("ca.crt")) return Promise.resolve(CA_PEM);
    if (p.endsWith("client.crt")) return Promise.resolve(CERT_PEM);
    if (p.endsWith("client.key")) return Promise.resolve(KEY_PEM);
    if (p.endsWith("token.txt")) return Promise.resolve(`${TOKEN}\n`);
    return Promise.reject(new Error("ENOENT"));
  };

  const inline = await loadCredentials(
    resolveContext(KUBECONFIG),
    "/kc",
    readFile,
  );
  assertEquals(inline, { caPem: CA_PEM, certPem: CERT_PEM, keyPem: KEY_PEM });
  assertEquals(reads, []);

  const files = await loadCredentials(
    resolveContext(KUBECONFIG, "files"),
    "/home/a/.kube",
    readFile,
  );
  assertEquals(files, { caPem: CA_PEM, certPem: CERT_PEM, keyPem: KEY_PEM });
  assertEquals(reads, [
    "/home/a/.kube/certs/ca.crt",
    "/home/a/.kube/certs/client.crt",
    "/abs/client.key",
  ]);

  const token = await loadCredentials(
    resolveContext(KUBECONFIG, "homelab-readonly"),
    "/kc",
    readFile,
  );
  assertEquals(token, { token: TOKEN });

  const tokenFile = await loadCredentials(
    resolveContext(KUBECONFIG, "token-file"),
    "/kc",
    readFile,
  );
  assertEquals(tokenFile, { caPem: CA_PEM, token: TOKEN });

  const insecure = await loadCredentials(
    resolveContext(KUBECONFIG, "insecure"),
    "/kc",
    readFile,
  );
  assertEquals(
    insecure.caPem,
    undefined,
    "no CA pinning when TLS verification is skipped",
  );
  assertEquals(insecure.certPem, CERT_PEM);

  const anon = await loadCredentials(
    resolveContext(KUBECONFIG, "anon"),
    "/kc",
    readFile,
  );
  assertEquals(anon, { caPem: CA_PEM });
});

Deno.test("loadCredentials reports unreadable files and bad base64 without echoing data", async () => {
  const missing = resolveContext(KUBECONFIG, "files");
  await assertRejects(
    () =>
      loadCredentials(
        missing,
        "/kc",
        () => Promise.reject(new Error("ENOENT")),
      ),
    Error,
    "cannot read certificate-authority file /kc/certs/ca.crt",
  );
  const badB64 = resolveContext({
    ...KUBECONFIG,
    users: [{
      name: "admin",
      user: { "client-certificate-data": "@@@", "client-key-data": "@@@" },
    }],
  });
  await assertRejects(
    () => loadCredentials(badB64, "/kc", () => Promise.resolve("")),
    Error,
    "client-certificate-data in the kubeconfig is not valid base64",
  );
});

// ----------------------------------------------------------------------------
// argv and plan
// ----------------------------------------------------------------------------

Deno.test("parseArgs defaults and help", () => {
  const args = parseArgs(["probe"]);
  assertEquals(args.command, "probe");
  assertEquals(args.endpoints, []);
  assertEquals(args.paths, undefined);
  assertEquals(args.interval, "1s");
  assertEquals(args.timeout, "5s");
  assertEquals(args.duration, "60s");
  assertEquals(args.slow, "1s");
  assertEquals(args.concurrency, "8,32");
  assertEquals(args.stepDuration, "30s");
  assertEquals(args.maxConcurrency, "128");
  assertEquals(args.dryRun, false);
  assertEquals(args.iKnow, false);
  assertEquals(args.http1, false);
  assertEquals(parseArgs([]).command, "help");
  assertEquals(parseArgs(["stress", "--help"]).command, "help");
  assertEquals(parseArgs(["-h"]).command, "help");
});

Deno.test("parseArgs collects repeatable flags and the = form", () => {
  const args = parseArgs([
    "--",
    "stress",
    "--endpoint",
    CP1,
    "--endpoint=https://cp2.example.test:6443",
    "--path",
    "/readyz",
    "--concurrency=8,32,64",
    "--step-duration",
    "10s",
    "--max-concurrency",
    "256",
    "--i-know",
    "--http1",
    "--json",
    "out.json",
    "--context",
    "admin@homelab",
    "--kubeconfig",
    "/x/kc",
    "--dry-run",
  ]);
  assertEquals(args.command, "stress");
  assertEquals(args.endpoints, [CP1, "https://cp2.example.test:6443"]);
  assertEquals(args.paths, ["/readyz"]);
  assertEquals(args.concurrency, "8,32,64");
  assertEquals(args.stepDuration, "10s");
  assertEquals(args.maxConcurrency, "256");
  assertEquals(args.iKnow, true);
  assertEquals(args.http1, true);
  assertEquals(args.json, "out.json");
  assertEquals(args.context, "admin@homelab");
  assertEquals(args.kubeconfig, "/x/kc");
  assertEquals(args.dryRun, true);
});

Deno.test("parseArgs rejects bad invocations", () => {
  const bad: [string[], string][] = [
    [["frobnicate"], "unknown subcommand"],
    [["probe", "extra"], "unexpected argument"],
    [["probe", "--bogus"], "unknown flag"],
    [["probe", "--endpoint"], "needs a value"],
    [["probe", "--endpoint", "--dry-run"], "needs a value"],
  ];
  for (const [argv, msg] of bad) {
    assertThrows(() => parseArgs(argv), UsageError, msg);
  }
});

Deno.test("buildPlan converts durations, paths and the concurrency guard", () => {
  const plan = buildPlan(
    parseArgs(["stress", "--duration", "5m", "--interval", "500ms"]),
  );
  assertEquals(plan.command, "stress");
  assertEquals(plan.extraEndpoints, []);
  assertEquals(plan.probePaths, [...PROBE_PATHS]);
  assertEquals(plan.stressPaths, [...STRESS_PATHS]);
  assertEquals(plan.intervalMs, 500);
  assertEquals(plan.timeoutMs, 5000);
  assertEquals(plan.durationMs, 300_000);
  assertEquals(plan.slowMs, 1000);
  assertEquals(plan.steps, [8, 32]);
  assertEquals(plan.stepDurationMs, 30_000);

  const custom = buildPlan(parseArgs([
    "probe",
    "--path",
    "/version",
    "--path",
    "/healthz",
    "--endpoint",
    `${CP1}/`,
  ]));
  assertEquals(custom.probePaths, ["/version", "/healthz"]);
  assertEquals(custom.stressPaths, ["/version", "/healthz"]);
  assertEquals(custom.extraEndpoints, [CP1]);

  assertThrows(
    () => buildPlan(parseArgs(["stress", "--concurrency", "8,512"])),
    UsageError,
    "--i-know",
  );
  assertEquals(
    buildPlan(parseArgs(["stress", "--concurrency", "8,512", "--i-know"]))
      .steps,
    [8, 512],
  );
  assertEquals(
    buildPlan(
      parseArgs(["stress", "--concurrency", "200", "--max-concurrency", "200"]),
    ).steps,
    [200],
  );
  assertThrows(
    () => buildPlan(parseArgs(["stress", "--max-concurrency", "lots"])),
    UsageError,
    "--max-concurrency",
  );
  assertThrows(
    () => buildPlan(parseArgs(["probe", "--path", "readyz"])),
    UsageError,
    "must start with /",
  );
  assertThrows(
    () => buildPlan(parseArgs(["probe", "--timeout", "soon"])),
    UsageError,
    "--timeout",
  );
});

Deno.test("the only request method is GET", () => {
  assertEquals(METHOD, "GET");
});

Deno.test("isClientSaturated separates a starved client from a slow server", () => {
  const cell = (count: number, ok: number): CellSummary => ({
    endpoint: VIP,
    path: "/readyz",
    count,
    ok,
    errors: ok < count ? { timeout: count - ok } : {},
    latency: { p50: 10, p95: 20, p99: 20, max: 20 },
    longestOutage: null,
  });
  const step = (over: Partial<StepSummary>): StepSummary => ({
    concurrency: 64,
    durationMs: 30_000,
    requests: 1512,
    achievedRps: 49,
    errors: { timeout: 384 },
    latency: { p50: 17, p95: 67, p99: 88, max: 110 },
    probe: [cell(30, 30)],
    ...over,
  });
  // Load timed out, probe clean, completed load requests fast -> the client.
  assert(isClientSaturated(step({})));
  // No load timeouts at all -> nothing to explain.
  assertEquals(isClientSaturated(step({ errors: {} })), false);
  // The probe failed too -> the server really was unreachable.
  assertEquals(isClientSaturated(step({ probe: [cell(30, 27)] })), false);
  // Completed load requests were slow -> the server was struggling.
  assertEquals(
    isClientSaturated(
      step({ latency: { p50: 900, p95: 3000, p99: 4200, max: 4900 } }),
    ),
    false,
  );
});
