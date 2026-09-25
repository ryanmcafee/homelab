#!/usr/bin/env -S bun test
/**
 * Unit tests for the decision logic in fork-path-gate.ts.
 *
 * Everything here is pure: no clone, no network, no pull request. The cases
 * are the acceptance criteria of the gate, so a change that silently widens
 * the Tier 1 surface or weakens a discharge route fails here rather than in
 * somebody's pull request six weeks later.
 *
 *   bun test scripts/fork-path-gate_test.ts
 */

import { test } from "bun:test";
import { assert, assertEquals } from "./lib/assert.ts";
import {
  COLD_WORKFLOW_PATH,
  CONTRACT_PATH,
  DISCHARGE_LABEL,
  type RunFact,
  blobUrl,
  classify,
  decide,
  extractDischargeReason,
  extractRunLinks,
  globToRegExp,
  hasDischargeLabel,
  renderComment,
  taskfileDiffTouchesLocaldev,
} from "./fork-path-gate.ts";

const HEAD = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";

function coldRun(over: Partial<RunFact> = {}): RunFact {
  return {
    runId: 99,
    owner: "o",
    repo: "r",
    workflowPath: COLD_WORKFLOW_PATH,
    conclusion: "success",
    headSha: HEAD,
    ...over,
  };
}

// --- globbing -------------------------------------------------------------

test("globToRegExp: ** crosses separators, * does not", () => {
  assertEquals(
    globToRegExp("localdev/**").test("localdev/values/a.yaml"),
    true,
  );
  assertEquals(globToRegExp("localdev/**").test("localdev/Tiltfile"), true);
  assertEquals(globToRegExp("localdev/**").test("localdevx/Tiltfile"), false);
  assertEquals(
    globToRegExp("scripts/localdev-*.ts").test("scripts/localdev-kind.ts"),
    true,
  );
  // * must not cross a directory boundary, or scripts/localdev-*/x.ts would
  // quietly match too.
  assertEquals(
    globToRegExp("scripts/localdev-*.ts").test("scripts/localdev-a/b.ts"),
    false,
  );
  // Dots are literal, not "any character".
  assertEquals(globToRegExp(".sops.yaml").test("xsopsXyaml"), false);
});

// --- classification -------------------------------------------------------

test("classify: the Tier 1 surface fork-path-cold.yml actually executes", () => {
  const { tier1, tier2 } = classify({
    files: [
      "mise.toml",
      "localdev/kind-config.yaml",
      "scripts/localdev-kind.ts",
      "readme.md",
      "docs/tooling.md",
      "docs/local-development.md",
      COLD_WORKFLOW_PATH,
    ],
  });
  assertEquals(tier1.length, 7);
  assertEquals(tier2, []);
});

test("classify: Tier 2 warns and never lands in Tier 1", () => {
  const { tier1, tier2 } = classify({
    files: [
      "configuration/environments/localdev.yaml",
      "charts/bootstrap/values.yaml",
      "charts/gitops/templates/app.yaml",
      "charts/secrets/values.yaml",
      ".sops.yaml",
      "policy.sops.hujson",
      ".env.op",
      "docs/secrets.md",
      "docs/secrets-management.md",
      "docs/contracts/fork-ability.md",
    ],
  });
  assertEquals(tier1, []);
  assertEquals(tier2.length, 10);
});

test("classify: the explicitly excluded surfaces stay excluded", () => {
  // Real fork-ability surface, but check 3a executes none of it, so demanding
  // a cold run for it would greenlight an unchecked change. Tracked separately.
  const { tier1, tier2 } = classify({
    files: [
      "terragrunt/env/main.hcl",
      "talos/patches/cp.yaml",
      "ansible/site.yml",
      "packer/talos.pkr.hcl",
      "configuration/templates/a.tmpl",
      "configuration/schema/a.schema.yaml",
      "charts/addons/values.yaml",
      "charts/applications/foo/values.yaml",
      ".github/CODEOWNERS",
      ".github/workflows/verify.yml",
    ],
  });
  assertEquals(tier1, []);
  assertEquals(tier2, []);
});

// --- the Taskfile.yml narrowing (acceptance criterion 5) ------------------

test("taskfileDiffTouchesLocaldev: a hunk with no localdev line is not Tier 1", () => {
  // This is the shape of 15 of the last 20 commits that touched Taskfile.yml.
  const diff = [
    "diff --git a/Taskfile.yml b/Taskfile.yml",
    "--- a/Taskfile.yml",
    "+++ b/Taskfile.yml",
    "@@ -60,1 +60,2 @@",
    "-      - bun run lint",
    "+      - bun run lint",
    "+      - bun run test",
  ].join("\n");
  assertEquals(taskfileDiffTouchesLocaldev(diff), false);
  assertEquals(
    classify({ files: ["Taskfile.yml"], taskfileDiff: diff }).tier1,
    [
      // no Tier 1 hit: a Taskfile change that cannot reach the cold path
    ],
  );
});

test("taskfileDiffTouchesLocaldev: a hunk touching a localdev line is Tier 1", () => {
  const diff = [
    "--- a/Taskfile.yml",
    "+++ b/Taskfile.yml",
    "@@ -10,1 +10,1 @@",
    "-      - task localdev:up",
    "+      - task localdev:up -- --wait",
  ].join("\n");
  assertEquals(taskfileDiffTouchesLocaldev(diff), true);
  assertEquals(
    classify({ files: ["Taskfile.yml"], taskfileDiff: diff }).tier1,
    ["Taskfile.yml"],
  );
});

test("taskfileDiffTouchesLocaldev: the file header is not content", () => {
  // `+++ b/localdev/...` in some other file's diff must not make Taskfile.yml
  // Tier 1, and the Taskfile's own headers never count.
  const headersOnly = [
    "--- a/Taskfile.yml",
    "+++ b/Taskfile.yml",
    "@@ -1,1 +1,1 @@",
    "-version: '3'",
    '+version: "3"',
  ].join("\n");
  assertEquals(taskfileDiffTouchesLocaldev(headersOnly), false);
});

test("taskfileDiffTouchesLocaldev: a deleted localdev line counts", () => {
  // Removing the localdev wiring is exactly the regression class 3a catches.
  assertEquals(
    taskfileDiffTouchesLocaldev("--- a/Taskfile.yml\n-  localdev:down:"),
    true,
  );
});

// --- discharge route 1: the linked run ------------------------------------

test("extractRunLinks: finds, dedupes and keeps the repository", () => {
  const body = [
    "Ran it: https://github.com/acme/homelab/actions/runs/36099151539",
    "again https://github.com/acme/homelab/actions/runs/36099151539 (same)",
    "and https://github.com/other/repo/actions/runs/7",
  ].join("\n");
  assertEquals(extractRunLinks(body), [
    { owner: "acme", repo: "homelab", runId: 36099151539 },
    { owner: "other", repo: "repo", runId: 7 },
  ]);
  assertEquals(extractRunLinks(""), []);
});

test("decide: a successful cold run at the PR head discharges Tier 1", () => {
  const d = decide({
    classification: { tier1: ["docs/tooling.md"], tier2: [] },
    headSha: HEAD,
    labels: [],
    body: "https://github.com/o/r/actions/runs/99",
    runs: [coldRun()],
  });
  assertEquals(d.verdict, "pass");
  assertEquals(d.dischargedBy, "run");
});

test("decide: a cold run owned by a FORK discharges, deliberately", () => {
  // Route 1 is the only discharge an outside contributor can execute: they
  // cannot dispatch a workflow here and cannot apply a label. The head SHA is
  // what the run proves; the owner of the runner that produced it is not part
  // of the claim. Do not "fix" this into an owner check.
  const d = decide({
    classification: { tier1: ["mise.toml"], tier2: [] },
    headSha: HEAD,
    labels: [],
    body: "https://github.com/a-stranger/their-fork/actions/runs/99",
    runs: [coldRun({ owner: "a-stranger", repo: "their-fork" })],
  });
  assertEquals(d.verdict, "pass");
  assertEquals(d.dischargedBy, "run");
});

test("decide: a run on a different head SHA fails and says so", () => {
  const d = decide({
    classification: { tier1: ["docs/tooling.md"], tier2: [] },
    headSha: HEAD,
    labels: [],
    body: "https://github.com/o/r/actions/runs/99",
    runs: [coldRun({ headSha: OTHER })],
  });
  assertEquals(d.verdict, "fail");
  assert(
    d.messages.some((m) => m.includes(OTHER) && m.includes(HEAD)),
    `expected a SHA-mismatch message, got: ${d.messages.join(" | ")}`,
  );
});

test("decide: a failed or still-running cold run does not discharge", () => {
  for (const conclusion of ["failure", "cancelled", null]) {
    const d = decide({
      classification: { tier1: ["mise.toml"], tier2: [] },
      headSha: HEAD,
      labels: [],
      body: "https://github.com/o/r/actions/runs/99",
      runs: [coldRun({ conclusion })],
    });
    assertEquals(d.verdict, "fail", String(conclusion));
  }
});

test("decide: a successful run of some other workflow does not discharge", () => {
  const d = decide({
    classification: { tier1: ["mise.toml"], tier2: [] },
    headSha: HEAD,
    labels: [],
    body: "https://github.com/o/r/actions/runs/99",
    runs: [coldRun({ workflowPath: ".github/workflows/tilt-ci.yml" })],
  });
  assertEquals(d.verdict, "fail");
  assert(d.messages.some((m) => m.includes("tilt-ci.yml")));
});

test("decide: an unreadable run fails closed and names the error", () => {
  const d = decide({
    classification: { tier1: ["mise.toml"], tier2: [] },
    headSha: HEAD,
    labels: [],
    body: "https://github.com/o/r/actions/runs/99",
    runs: [
      coldRun({
        workflowPath: null,
        conclusion: null,
        headSha: null,
        error: "GET /repos/o/r/actions/runs/99 -> 404",
      }),
    ],
  });
  assertEquals(d.verdict, "fail");
  assert(d.messages.some((m) => m.includes("404")));
});

// --- discharge route 2: the audited label ---------------------------------

test("hasDischargeLabel: exact label, case- and space-insensitive", () => {
  assertEquals(hasDischargeLabel([DISCHARGE_LABEL]), true);
  assertEquals(hasDischargeLabel(["  Fork-Path: Cold-Run-Waived "]), true);
  assertEquals(hasDischargeLabel(["fork-path"]), false);
  assertEquals(hasDischargeLabel([]), false);
});

test("extractDischargeReason: a real one-line reason is accepted", () => {
  assertEquals(
    extractDischargeReason(
      "Some preamble.\n\nfork-path: cold-run-waived — reworded a comment only; no command changed.\n",
    ),
    "reworded a comment only; no command changed.",
  );
  // Markdown list markers and emphasis are noise, not content.
  assert(
    extractDischargeReason(
      "- **fork-path: cold-run-waived**: only the table of contents moved in docs/tooling.md",
    ) !== null,
  );
});

test("extractDischargeReason: a bare run link is not a reason", () => {
  // Without stripping URLs first, this line is long enough to pass as prose.
  assertEquals(
    extractDischargeReason(
      "fork-path: https://github.com/o/r/actions/runs/36099151539",
    ),
    null,
  );
});

test("extractDischargeReason: a body with nothing to say is rejected", () => {
  assertEquals(extractDischargeReason(""), null);
  assertEquals(extractDischargeReason("fork-path: cold-run-waived"), null);
  assertEquals(extractDischargeReason("fork-path: n/a"), null);
  assertEquals(extractDischargeReason("Unrelated body text entirely."), null);
});

test("decide: label plus reason discharges; label alone does not", () => {
  const base = {
    classification: { tier1: ["docs/tooling.md"], tier2: [] },
    headSha: HEAD,
    runs: [] as RunFact[],
  };
  const good = decide({
    ...base,
    labels: [DISCHARGE_LABEL],
    body: "fork-path: cold-run-waived — only a typo in prose; no command changed.",
  });
  assertEquals(good.verdict, "pass");
  assertEquals(good.dischargedBy, "label");

  const bare = decide({ ...base, labels: [DISCHARGE_LABEL], body: "" });
  assertEquals(bare.verdict, "fail");
  assert(bare.messages.some((m) => m.includes("no one-line reason")));

  const reasonOnly = decide({
    ...base,
    labels: [],
    body: "fork-path: cold-run-waived — only a typo in prose; no command changed.",
  });
  assertEquals(reasonOnly.verdict, "fail");
  // A reason with no label is the half an outside contributor can actually
  // write. Failing it with no diagnostics tells them nothing about which half
  // is missing, and labelling is the half they are not permitted to do.
  assert(reasonOnly.messages.some((m) => m.includes("label is not")));
  assert(reasonOnly.messages.some((m) => m.includes("fork")));
});

// --- the overall verdict --------------------------------------------------

test("decide: no Tier 1 hit passes regardless of labels or body", () => {
  const d = decide({
    classification: { tier1: [], tier2: ["charts/secrets/values.yaml"] },
    headSha: HEAD,
    labels: [],
    body: "",
    runs: [],
  });
  assertEquals(d.verdict, "pass");
  assertEquals(d.dischargedBy, null);
});

test("renderComment: Tier 2 only produces an advisory that cannot be read as a failure", () => {
  const classification = { tier1: [], tier2: ["charts/bootstrap/values.yaml"] };
  const decision = decide({
    classification,
    headSha: HEAD,
    labels: [],
    body: "",
    runs: [],
  });
  const c = renderComment({ classification, decision, headSha: HEAD });
  assert(c !== null);
  assert((c as string).includes("advisory"));
  assert((c as string).includes("does not fail the check"));
  assert(!(c as string).includes("action required"));
});

test("renderComment: a Tier 1 failure always carries both discharge routes", () => {
  const classification = { tier1: ["docs/tooling.md"], tier2: [] };
  const decision = decide({
    classification,
    headSha: HEAD,
    labels: [],
    body: "",
    runs: [],
  });
  const c = renderComment({
    classification,
    decision,
    headSha: HEAD,
  }) as string;
  // No runbook, no alert: a gate that fails without telling you how to clear it
  // is noise that trains people to ignore the next one.
  assert(c.includes("How to clear this"));
  assert(c.includes(DISCHARGE_LABEL));
  assert(c.includes("Re-run failed jobs"));
  assert(c.includes("docs/contracts/fork-ability.md"));
  // The stranger is this document's whole subject, and neither the label nor a
  // re-run is a verb they are allowed. If the runbook stops saying so, their
  // first impression of the gate is "I tripped something I cannot clear".
  assert(c.includes("Contributing from a fork?"));
  assert(c.includes("A maintainer will apply the label."));
});

test("renderComment: the contract link is absolute and pinned to the head SHA", () => {
  // A relative link is NOT rewritten in a comment body: it resolves against the
  // pull-request page and lands a logged-out reader on a login page. The single
  // pointer from the runbook to the normative document has to survive that.
  const classification = { tier1: [], tier2: [CONTRACT_PATH] };
  const c = renderComment({
    classification,
    decision: decide({
      classification,
      headSha: HEAD,
      labels: [],
      body: "",
      runs: [],
    }),
    headSha: HEAD,
    serverUrl: "https://github.com",
    repoSlug: "someone/their-fork",
  }) as string;
  assert(
    c.includes(
      `](https://github.com/someone/their-fork/blob/${HEAD}/${CONTRACT_PATH})`,
    ),
  );
  assert(!c.includes(`](${CONTRACT_PATH})`));
});

test("blobUrl: server and repository come from the environment, never a constant", () => {
  // Fork-ability applies to the fork-ability gate: a fork must link its own
  // copy, on its own server, and nothing here may name one operator's repo.
  assertEquals(
    blobUrl({
      serverUrl: "https://ghe.example.invalid/",
      repoSlug: "a/b",
      sha: "abc",
      path: "p.md",
    }),
    "https://ghe.example.invalid/a/b/blob/abc/p.md",
  );
  // No repository in the environment (a local run): degrade to the bare path
  // rather than inventing an owner.
  assertEquals(
    blobUrl({ serverUrl: "", repoSlug: "", sha: "abc", path: "p.md" }),
    "p.md",
  );
});

test("renderComment: nothing to say produces no comment at all", () => {
  const classification = { tier1: [], tier2: [] };
  assertEquals(
    renderComment({
      classification,
      decision: decide({
        classification,
        headSha: HEAD,
        labels: [],
        body: "",
        runs: [],
      }),
      headSha: HEAD,
    }),
    null,
  );
});

test("the gate hard-codes no operator-specific value", () => {
  // The fork-ability contract applies to the fork-ability gate itself.
  const src = require("node:fs").readFileSync(
    new URL("./fork-path-gate.ts", import.meta.url),
    "utf8",
  ) as string;
  const forbidden = [
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, // an IP address
    /[\w.-]+@[\w.-]+\.\w+/, // an email address
    /\bryanmcafee\b/i, // an account name
  ];
  for (const re of forbidden) {
    const m = src.match(re);
    assertEquals(m, null, `forbidden literal in fork-path-gate.ts: ${m?.[0]}`);
  }
});
