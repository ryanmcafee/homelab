#!/usr/bin/env -S bun test
/**
 * Unit tests for the pure helpers in verify-claim.ts: parsing the level-0 JSON
 * contract (including `task verify`'s trailing failure line), rendering the
 * PR-body block, extracting it back from a PR body, and the compare rules.
 *
 *   bun test scripts/verify-claim_test.ts
 */

import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";
import {
  compareClaim,
  extractClaim,
  extractJsonObject,
  MARKER,
  parseArgs,
  parseVerifyResult,
  renderClaimBlock,
  renderComparison,
  renderMissing,
  toClaim,
  type VerifyResult,
} from "./verify-claim.ts";

// Shaped like `homelab verify all --level 0 --json` (internal/verify/types.go).
const RESULT: VerifyResult = {
  level: 0,
  checks: [
    { name: "render/homelab/addons", status: "pass", duration_ms: 120 },
    {
      name: "gitops/localdev/ssa",
      status: "skip",
      duration_ms: 1,
      detail: "no huge-CRD charts",
    },
    { name: "pluto/homelab", status: "pass", duration_ms: 40 },
  ],
  pass: true,
  duration_ms: 2900,
};

const FAILING: VerifyResult = {
  level: 0,
  checks: [
    { name: "render/homelab/addons", status: "pass" },
    {
      name: "snapshot/homelab/addons",
      status: "fail",
      detail: "rendered output differs",
      findings: ["@@ -1 +1 @@", "-a", "+b"],
    },
  ],
  pass: false,
};

function bodyWith(block: string): string {
  return `## Summary\n- thing\n\n## Verification\n\n${block}\n## Test plan\n- [x] ok\n`;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------
test("extractJsonObject: strips task's trailing failure line", () => {
  const raw =
    JSON.stringify(FAILING, null, 2) +
    '\ntask: Failed to run task "verify": exit status 1\n';
  assertEquals(JSON.parse(extractJsonObject(raw)), FAILING);
});

test("extractJsonObject: single-line object and leading noise", () => {
  const raw = "go: downloading x\n" + JSON.stringify(RESULT) + "\n";
  assertEquals(JSON.parse(extractJsonObject(raw)), RESULT);
});

test("parseVerifyResult: accepts the contract and keeps detail/findings", () => {
  const r = parseVerifyResult(JSON.stringify(FAILING, null, 2));
  assertEquals(r.pass, false);
  assertEquals(r.checks[1].findings, ["@@ -1 +1 @@", "-a", "+b"]);
});

test("parseVerifyResult: rejects empty input, non-JSON and wrong shapes", () => {
  assertThrows(() => parseVerifyResult(""), Error, "no JSON object");
  // `task verify` when the Go build itself failed: only task's error line.
  assertThrows(
    () =>
      parseVerifyResult('task: Failed to run task "verify": exit status 1\n'),
    Error,
    "no JSON object",
  );
  assertThrows(() => parseVerifyResult("{nope"), Error, "not JSON");
  assertThrows(
    () => parseVerifyResult('{"level":0,"pass":true}'),
    Error,
    "`checks`",
  );
  assertThrows(
    () =>
      parseVerifyResult(
        '{"level":0,"pass":true,"checks":[{"name":"a","status":"ok"}]}',
      ),
    Error,
    "status",
  );
});

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
test("toClaim + renderClaimBlock: sorted, one check per line, valid JSON", () => {
  const block = renderClaimBlock(toClaim(RESULT));
  const lines = block.trimEnd().split("\n");
  assertEquals(lines[0], MARKER);
  assertEquals(lines[1], "```json");
  assertEquals(lines[2], '{"level":0,"pass":true,"checks":{');
  assertEquals(lines.slice(3, 6), [
    '"gitops/localdev/ssa":"skip",',
    '"pluto/homelab":"pass",',
    '"render/homelab/addons":"pass"',
  ]);
  assertEquals(lines.slice(6), ["}}", "```"]);
  const json = JSON.parse(lines.slice(2, 7).join("\n"));
  assertEquals(json, {
    level: 0,
    pass: true,
    checks: {
      "gitops/localdev/ssa": "skip",
      "pluto/homelab": "pass",
      "render/homelab/addons": "pass",
    },
  });
});

test("render -> extract round trip, CRLF bodies included", () => {
  const block = renderClaimBlock(toClaim(FAILING));
  const got = extractClaim(bodyWith(block).replaceAll("\n", "\r\n"));
  assertEquals(got.markers, 1);
  assertEquals(got.error, null);
  assertEquals(got.claim, toClaim(FAILING));
});

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------
test("extractClaim: no marker", () => {
  const got = extractClaim("## Summary\nnothing here\n");
  assertEquals(got, { claim: null, markers: 0, error: null });
});

test("extractClaim: marker without a fence, and a placeholder that is not JSON", () => {
  assertStringIncludes(
    extractClaim(`${MARKER}\nplease paste\n`).error ?? "",
    "not followed",
  );
  const placeholder = `${MARKER}\n\`\`\`json\nreplace me with task verify:claim\n\`\`\`\n`;
  const got = extractClaim(placeholder);
  assertEquals(got.claim, null);
  assertStringIncludes(got.error ?? "", "not JSON");
});

test("extractClaim: the last well-formed block wins over a template placeholder", () => {
  const placeholder = `${MARKER}\n\`\`\`json\nreplace me\n\`\`\`\n`;
  const body = bodyWith(placeholder + "\n" + renderClaimBlock(toClaim(RESULT)));
  const got = extractClaim(body);
  assertEquals(got.markers, 2);
  assertEquals(got.claim, toClaim(RESULT));
});

test("extractClaim: rejects an invalid status inside the block", () => {
  const block = `${MARKER}\n\`\`\`json\n{"level":0,"pass":true,"checks":{"a":"ok"}}\n\`\`\`\n`;
  assertStringIncludes(extractClaim(block).error ?? "", "status");
});

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------
test("compareClaim: identical claim matches", () => {
  const cmp = compareClaim(toClaim(RESULT), RESULT);
  assert(cmp.ok);
  assertEquals(cmp.failures, []);
  assertEquals(cmp.warnings, []);
  assertEquals(cmp.checkCount, 3);
});

test("compareClaim: an honest failing claim matches a failing CI run", () => {
  const cmp = compareClaim(toClaim(FAILING), FAILING);
  assert(cmp.ok);
  assertStringIncludes(
    renderComparison(cmp, FAILING),
    "the claim says so honestly",
  );
});

test("compareClaim: pass <-> fail and overall pass differences fail", () => {
  const claim = toClaim({
    ...FAILING,
    pass: true,
    checks: FAILING.checks.map((c) => ({ ...c, status: "pass" })),
  });
  const cmp = compareClaim(claim, FAILING);
  assertEquals(cmp.ok, false);
  assertEquals(cmp.failures, [
    {
      name: "snapshot/homelab/addons",
      claimed: "pass",
      actual: "fail",
    },
  ]);
  assertEquals(cmp.problems.length, 1);
  assertStringIncludes(cmp.problems[0], "CI says it fails");
});

test("compareClaim: claimed fail where CI skips is a failure (fail on either side)", () => {
  const claim = toClaim(RESULT);
  claim.checks["gitops/localdev/ssa"] = "fail";
  claim.pass = false;
  const cmp = compareClaim(claim, RESULT);
  assertEquals(cmp.failures, [
    {
      name: "gitops/localdev/ssa",
      claimed: "fail",
      actual: "skip",
    },
  ]);
});

test("compareClaim: skip <-> pass is a warning only", () => {
  const claim = toClaim(RESULT);
  claim.checks["pluto/homelab"] = "skip";
  const cmp = compareClaim(claim, RESULT);
  assert(cmp.ok);
  assertEquals(cmp.warnings, [
    {
      name: "pluto/homelab",
      claimed: "skip",
      actual: "pass",
    },
  ]);
  assertStringIncludes(renderComparison(cmp, RESULT), "skip/pass difference");
});

test("compareClaim: check-name sets must match in both directions", () => {
  const claim = toClaim(RESULT);
  delete claim.checks["pluto/homelab"];
  claim.checks["render/homelab/removed-chart"] = "pass";
  const cmp = compareClaim(claim, RESULT);
  assertEquals(cmp.ok, false);
  assertEquals(cmp.failures, [
    { name: "pluto/homelab", claimed: "absent", actual: "pass" },
    { name: "render/homelab/removed-chart", claimed: "pass", actual: "absent" },
  ]);
});

test("compareClaim: the claim must be level 0", () => {
  const claim = { ...toClaim(RESULT), level: 2 };
  const cmp = compareClaim(claim, RESULT);
  assertEquals(cmp.ok, false);
  assertStringIncludes(cmp.problems[0], "level 2");
});

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------
test("renderComparison: mismatch shows the table, findings and how to fix", () => {
  const claim = toClaim({
    ...FAILING,
    pass: true,
    checks: FAILING.checks.map((c) => ({ ...c, status: "pass" })),
  });
  const md = renderComparison(compareClaim(claim, FAILING), FAILING, "abc1234");
  assertStringIncludes(md, "**Result:** MISMATCH");
  assertStringIncludes(md, "on `abc1234`");
  assertStringIncludes(md, "| `snapshot/homelab/addons` | `pass` | `fail` |");
  assertStringIncludes(md, "- @@ -1 +1 @@");
  assertStringIncludes(md, "task verify:claim");
});

test("renderMissing: explains the marker and the command", () => {
  const md = renderMissing("The PR description has no block.");
  assertStringIncludes(md, "**Result:** MISSING");
  assertStringIncludes(md, "task verify:claim");
  assertStringIncludes(md, MARKER);
});

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
test("parseArgs: subcommands, required --actual, unknown flags", () => {
  assertEquals(parseArgs(["render"]).cmd, "render");
  assertEquals(
    parseArgs(["compare", "--actual", "a.json", "--body-file", "b.md"])
      .bodyFile,
    "b.md",
  );
  assertEquals(parseArgs(["--help"]).cmd, "help");
  assertThrows(() => parseArgs([]), Error, "subcommand");
  assertThrows(() => parseArgs(["compare"]), Error, "--actual");
  assertThrows(
    () => parseArgs(["compare", "--actual"]),
    Error,
    "requires a value",
  );
  assertThrows(
    () => parseArgs(["render", "--bogus"]),
    Error,
    "unknown argument",
  );
});
