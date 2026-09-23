#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure helpers in health-test.ts.
 *
 * The live runner needs the argocd CLI; these do not. They pin the two parsers
 * against real captured output (argocd v3.5.2) and the fixture header
 * contract, plus the coverage cross-check and the verdict logic.
 *
 *   bun test scripts/health-test_test.ts
 */

import { test } from "bun:test";
import { assertEquals, assertThrows } from "./lib/assert.ts";
import {
  argocdErrorSummary,
  buildConfigMap,
  coverage,
  fixtureGroupKind,
  healthKey,
  judge,
  parseExpectation,
  parseHealthOutput,
} from "./health-test.ts";

// ---------------------------------------------------------------------------
// parseHealthOutput — samples captured from
// `argocd admin settings resource-overrides health <fixture> --argocd-cm-path <cm>`
// with argocd v3.5.2+e258ee2. stdout is exactly two lines, MESSAGE possibly
// empty; the JSON log lines go to stderr and never reach this parser.
// ---------------------------------------------------------------------------
test("parseHealthOutput: captured Healthy output with a message", () => {
  const stdout = "STATUS: Healthy\nMESSAGE: Secret synced\n";
  assertEquals(parseHealthOutput(stdout), {
    status: "Healthy",
    message: "Secret synced",
  });
});

test("parseHealthOutput: captured Degraded and Progressing outputs", () => {
  assertEquals(
    parseHealthOutput("STATUS: Degraded\nMESSAGE: item not found\n"),
    { status: "Degraded", message: "item not found" },
  );
  assertEquals(
    parseHealthOutput("STATUS: Progressing\nMESSAGE: Waiting for status\n"),
    { status: "Progressing", message: "Waiting for status" },
  );
});

test("parseHealthOutput: an empty hs.message prints as a bare MESSAGE line", () => {
  // Captured with a Lua that sets hs.message = "": the CLI still prints the
  // label, followed by a single space and a newline.
  assertEquals(parseHealthOutput("STATUS: Healthy\nMESSAGE: \n"), {
    status: "Healthy",
    message: "",
  });
});

test("parseHealthOutput: tolerates CRLF and a missing MESSAGE line", () => {
  assertEquals(parseHealthOutput("STATUS: Suspended\r\nMESSAGE: paused\r\n"), {
    status: "Suspended",
    message: "paused",
  });
  assertEquals(parseHealthOutput("STATUS: Healthy\n"), {
    status: "Healthy",
    message: "",
  });
});

test("parseHealthOutput: no STATUS line is an error, not a silent pass", () => {
  assertThrows(() => parseHealthOutput(""), Error, "STATUS");
  assertThrows(
    () => parseHealthOutput("MESSAGE: only a message\n"),
    Error,
    "STATUS",
  );
  assertThrows(() => parseHealthOutput("STATUS: \n"), Error, "STATUS");
});

// ---------------------------------------------------------------------------
// parseExpectation — the fixture header contract
// ---------------------------------------------------------------------------
test("parseExpectation: status only", () => {
  assertEquals(
    parseExpectation("# expect: Healthy\napiVersion: v1\nkind: Secret\n"),
    { status: "Healthy", message: null },
  );
});

test("parseExpectation: status plus message substring", () => {
  assertEquals(
    parseExpectation(
      "# expect: Degraded\n# message: item not found\napiVersion: onepassword.com/v1\n",
    ),
    { status: "Degraded", message: "item not found" },
  );
});

test("parseExpectation: message substring keeps inner spaces, trims the ends", () => {
  assertEquals(
    parseExpectation(
      "#expect:Progressing\n#  message:   Waiting for  status  \n",
    ),
    { status: "Progressing", message: "Waiting for  status" },
  );
});

test("parseExpectation: a message header only counts on line 2", () => {
  // Line 2 is a normal YAML comment here, so no message expectation is set.
  assertEquals(
    parseExpectation("# expect: Healthy\n# a note\n# message: ignored\n"),
    { status: "Healthy", message: null },
  );
});

test("parseExpectation: rejects a missing header, unknown status or empty message", () => {
  assertThrows(
    () => parseExpectation("apiVersion: v1\nkind: Secret\n"),
    Error,
    "# expect:",
  );
  assertThrows(() => parseExpectation(""), Error, "# expect:");
  assertThrows(
    () => parseExpectation("# expect: Ready\n"),
    Error,
    "Healthy|Progressing|Degraded|Suspended",
  );
  assertThrows(
    () => parseExpectation("# expect: healthy\n"),
    Error,
    "Healthy|Progressing|Degraded|Suspended",
  );
  assertThrows(
    () => parseExpectation("# expect: Healthy\n# message:\n"),
    Error,
    "non-empty",
  );
});

// ---------------------------------------------------------------------------
// healthKey / fixtureGroupKind / buildConfigMap
// ---------------------------------------------------------------------------
test("healthKey: file name becomes the argocd-cm key", () => {
  assertEquals(
    healthKey("onepassword.com_OnePasswordItem.lua"),
    "resource.customizations.health.onepassword.com_OnePasswordItem",
  );
  assertEquals(
    healthKey("charts/bootstrap/files/health/networking.k8s.io_Ingress.lua"),
    "resource.customizations.health.networking.k8s.io_Ingress",
  );
  assertThrows(() => healthKey("notes.txt"), Error, ".lua");
});

test("fixtureGroupKind: group_kind from apiVersion/kind, core group is bare kind", () => {
  assertEquals(
    fixtureGroupKind(
      "# expect: Healthy\napiVersion: tailscale.com/v1alpha1\nkind: Connector\nmetadata:\n  name: x\n",
    ),
    "tailscale.com_Connector",
  );
  assertEquals(
    fixtureGroupKind('apiVersion: "networking.k8s.io/v1"\nkind: "Ingress"\n'),
    "networking.k8s.io_Ingress",
  );
  assertEquals(fixtureGroupKind("apiVersion: v1\nkind: Service\n"), "Service");
  assertThrows(() => fixtureGroupKind("kind: Service\n"), Error, "apiVersion");
});

test("fixtureGroupKind: only top-level apiVersion/kind count", () => {
  // The nested `kind: Application` under status.resources must not win.
  const text = [
    "apiVersion: argoproj.io/v1alpha1",
    "kind: Application",
    "status:",
    "  resources:",
    "    - kind: Deployment",
    "      apiVersion: apps/v1",
  ].join("\n");
  assertEquals(fixtureGroupKind(text), "argoproj.io_Application");
});

test("buildConfigMap: argocd-cm manifest with sorted data keys", () => {
  const cm = buildConfigMap({
    "resource.customizations.health.b_B": "hs = {}\nreturn hs\n",
    "resource.customizations.health.a_A":
      'hs = {}\nhs.status = "Healthy"\nreturn hs\n',
  });
  const parsed = JSON.parse(cm);
  assertEquals(parsed.kind, "ConfigMap");
  assertEquals(parsed.metadata, { name: "argocd-cm", namespace: "argocd" });
  assertEquals(Object.keys(parsed.data), [
    "resource.customizations.health.a_A",
    "resource.customizations.health.b_B",
  ]);
  assertEquals(
    parsed.data["resource.customizations.health.a_A"],
    'hs = {}\nhs.status = "Healthy"\nreturn hs\n',
  );
});

// ---------------------------------------------------------------------------
// judge / coverage / argocdErrorSummary
// ---------------------------------------------------------------------------
test("judge: status match without a message expectation passes", () => {
  assertEquals(
    judge(
      { status: "Healthy", message: null },
      {
        status: "Healthy",
        message: "anything",
      },
    ),
    { ok: true, detail: "" },
  );
});

test("judge: status mismatch fails and reports the actual message", () => {
  const v = judge(
    { status: "Degraded", message: null },
    {
      status: "Healthy",
      message: "Secret synced",
    },
  );
  assertEquals(v.ok, false);
  assertEquals(
    v.detail,
    'expected Degraded, got Healthy (message: "Secret synced")',
  );
});

test("judge: message substring is checked only after the status matches", () => {
  assertEquals(
    judge(
      { status: "Healthy", message: "synced" },
      {
        status: "Healthy",
        message: "Secret synced from 1Password",
      },
    ).ok,
    true,
  );
  const v = judge(
    { status: "Healthy", message: "nothing like this" },
    {
      status: "Healthy",
      message: "Secret synced",
    },
  );
  assertEquals(v.ok, false);
  assertEquals(
    v.detail,
    'status Healthy as expected, but message "Secret synced" does not contain "nothing like this"',
  );
});

test("coverage: both directions of the Lua <-> fixture cross-check", () => {
  assertEquals(
    coverage(["b_B", "a_A", "orphan_O"], {
      a_A: 2,
      b_B: 1,
      stray_S: 1,
      empty_E: 0,
    }),
    {
      covered: ["a_A", "b_B"],
      luaWithoutFixtures: ["orphan_O"],
      fixturesWithoutLua: ["empty_E", "stray_S"],
    },
  );
});

test("coverage: a Lua whose fixture directory is empty is uncovered", () => {
  assertEquals(coverage(["a_A"], { a_A: 0 }), {
    covered: [],
    luaWithoutFixtures: ["a_A"],
    fixturesWithoutLua: ["a_A"].filter(() => false),
  });
});

test("argocdErrorSummary: pulls the fatal msg out of argocd's JSON log lines", () => {
  // Captured from argocd v3.5.2 when the Lua indexes a nil table.
  const stderr = [
    '{"level":"info","msg":"Starting configmap/secret informers","time":"2026-09-12T23:12:39-05:00"}',
    '{"level":"info","msg":"Ignore status for all objects","time":"2026-09-12T23:12:39-05:00"}',
    '{"level":"fatal","msg":"failed to get resource health for traefik/traefik-external: \\u003cstring\\u003e:2: attempt to index a non-table object(nil) with key \'phase\'","time":"2026-09-12T23:12:39-05:00"}',
    "",
  ].join("\n");
  assertEquals(
    argocdErrorSummary(stderr),
    "fatal: failed to get resource health for traefik/traefik-external: <string>:2: attempt to index a non-table object(nil) with key 'phase'",
  );
});

test("argocdErrorSummary: non-JSON stderr falls back to its last line", () => {
  assertEquals(
    argocdErrorSummary(
      "mise ERROR No version is set for shim: argocd\nmise ERROR Run with --verbose\n",
    ),
    "mise ERROR Run with --verbose",
  );
  assertEquals(argocdErrorSummary("\n  \n"), "(no stderr)");
});
