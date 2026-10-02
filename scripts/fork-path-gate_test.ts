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
  README_BADGES_BEGIN,
  README_BADGES_END,
  README_COUNTERS,
  type RunFact,
  blobUrl,
  classify,
  decide,
  extractDischargeReason,
  extractRunLinks,
  globToRegExp,
  hasDischargeLabel,
  coldPathTaskClosure,
  readmeChangedOutsideGenerated,
  renderComment,
  taskfileChangeReachesColdPath,
} from "./fork-path-gate.ts";
import { expectedLiterals, regionRe } from "./docs-check.ts";

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
      "terragrunt/env/main.hcl",
      "talos/patches/cp.yaml",
      "packer/talos.pkr.hcl",
    ],
  });
  assertEquals(tier1, []);
  assertEquals(tier2.length, 13);
});

test("classify: the explicitly excluded surfaces stay excluded", () => {
  const { tier1, tier2 } = classify({
    files: [
      "ansible/site.yml",
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

const TASKFILE_TEXT = [
  "version: '3'", //                                        1
  "vars:", //                                               2
  "  KIND_CLUSTER: homelab-localdev", //                    3
  "tasks:", //                                              4
  "  # Setup", //                                           5
  "  validate:", //                                         6
  "    deps: [bun:install]", //                             7
  "    cmds:", //                                           8
  "      - go run ./cmd/homelab validate", //               9
  "  bun:install:", //                                     10
  "    cmds:", //                                          11
  "      - bun install", //                                12
  "  localdev:up:", //                                     13
  "    cmds:", //                                          14
  "      - task: localdev:kind", //                        15
  "  localdev:kind:", //                                   16
  "    deps:", //                                          17
  "      - kind:pull", //                                  18
  "    cmds:", //                                          19
  "      - bun scripts/localdev-kind.ts up", //            20
  "  kind:pull:", //                                       21
  "    cmds:", //                                          22
  "      - docker pull kindest/node", //                   23
  "  localdev:ci:", //                                     24
  "    cmds:", //                                          25
  "      - task: localdev:up", //                          26
  "      - task: test:e2e", //                             27
  "  test:alerts:", //                                     28
  "    cmds:", //                                          29
  "      - helm template charts/addons -f values-localdev.yaml", // 30
  "  test:e2e:", //                                        31
  "    cmds:", //                                          32
  "      - chainsaw test", //                              33
].join("\n");

function hunk(oldStart: number, newStart: number, lines: string[]): string {
  const removed = lines.filter((l) => l.startsWith("-")).length;
  const added = lines.filter((l) => l.startsWith("+")).length;
  return [
    "diff --git a/Taskfile.yml b/Taskfile.yml",
    "--- a/Taskfile.yml",
    "+++ b/Taskfile.yml",
    `@@ -${oldStart},${removed} +${newStart},${added} @@`,
    ...lines,
  ].join("\n");
}

test("coldPathTaskClosure: the cold entry points plus everything they call", () => {
  assertEquals([...coldPathTaskClosure(TASKFILE_TEXT)].sort(), [
    "bun:install",
    "kind:pull",
    "localdev:kind",
    "localdev:up",
    "validate",
  ]);
});

test("taskfileChangeReachesColdPath: a task the cold path never runs is not Tier 1, even when it says localdev", () => {
  // homelab#501: test:alerts renders values-localdev.yaml, and the old
  // substring rule read that as a change to the cold path.
  const diff = hunk(30, 30, [
    "-      - helm template charts/addons -f values-localdev.yaml",
    "+      - helm template charts/addons -f values-localdev.yaml --strict",
  ]);
  const taskfile = { diff, baseText: TASKFILE_TEXT, headText: TASKFILE_TEXT };
  assertEquals(taskfileChangeReachesColdPath(taskfile), false);
  assertEquals(classify({ files: ["Taskfile.yml"], taskfile }).tier1, []);
});

test("taskfileChangeReachesColdPath: a task named localdev but off the cold path is not Tier 1", () => {
  const diff = hunk(27, 27, [
    "-      - task: test:e2e",
    "+      - task: test:e2e -- --quiet",
  ]);
  assertEquals(
    taskfileChangeReachesColdPath({
      diff,
      baseText: TASKFILE_TEXT,
      headText: TASKFILE_TEXT,
    }),
    false,
  );
});

test("taskfileChangeReachesColdPath: a cold entry point is Tier 1", () => {
  const diff = hunk(15, 15, [
    "-      - task: localdev:kind",
    "+      - task: localdev:kind -- --wait",
  ]);
  const taskfile = { diff, baseText: TASKFILE_TEXT, headText: TASKFILE_TEXT };
  assertEquals(taskfileChangeReachesColdPath(taskfile), true);
  assertEquals(classify({ files: ["Taskfile.yml"], taskfile }).tier1, [
    "Taskfile.yml",
  ]);
});

test("taskfileChangeReachesColdPath: a task reached only through deps is Tier 1, with no localdev in the line", () => {
  // The old rule missed this: kind:pull runs inside localdev:up but never says
  // localdev, and validate is a cold step whose body never says it either.
  for (const [line, text] of [
    [23, "      - docker pull kindest/node:v1.34"],
    [9, "      - go run ./cmd/homelab validate --strict"],
    [12, "      - bun install --frozen-lockfile"],
  ] as const) {
    const diff = hunk(line, line, [
      `-${TASKFILE_TEXT.split("\n")[line - 1]}`,
      `+${text}`,
    ]);
    assertEquals(
      taskfileChangeReachesColdPath({
        diff,
        baseText: TASKFILE_TEXT,
        headText: TASKFILE_TEXT,
      }),
      true,
    );
  }
});

test("taskfileChangeReachesColdPath: a line outside tasks: reaches every task", () => {
  const diff = hunk(3, 3, [
    "-  KIND_CLUSTER: homelab-localdev",
    "+  KIND_CLUSTER: other",
  ]);
  assertEquals(
    taskfileChangeReachesColdPath({
      diff,
      baseText: TASKFILE_TEXT,
      headText: TASKFILE_TEXT,
    }),
    true,
  );
});

test("taskfileChangeReachesColdPath: a deleted cold task is judged against the base", () => {
  // Removing the wiring is exactly the regression class 3a catches; the head
  // no longer has the task, so only the base can place the deleted lines.
  const lines = TASKFILE_TEXT.split("\n");
  const headText = [...lines.slice(0, 20), ...lines.slice(23)].join("\n");
  const diff = hunk(21, 20, [
    "-  kind:pull:",
    "-    cmds:",
    "-      - docker pull kindest/node",
  ]);
  assertEquals(
    taskfileChangeReachesColdPath({ diff, baseText: TASKFILE_TEXT, headText }),
    true,
  );
});

test("taskfileChangeReachesColdPath: a new task wired into the cold path is judged against the head", () => {
  const lines = TASKFILE_TEXT.split("\n");
  const headText = [
    ...lines.slice(0, 14),
    "      - task: localdev:kind",
    "      - task: localdev:fresh",
    ...lines.slice(15, 33),
    "  localdev:fresh:",
    "    cmds:",
    "      - echo fresh",
  ].join("\n");
  const diff = [
    "--- a/Taskfile.yml",
    "+++ b/Taskfile.yml",
    "@@ -15,0 +16,1 @@",
    "+      - task: localdev:fresh",
    "@@ -33,0 +35,3 @@",
    "+  localdev:fresh:",
    "+    cmds:",
    "+      - echo fresh",
  ].join("\n");
  assertEquals(
    taskfileChangeReachesColdPath({ diff, baseText: TASKFILE_TEXT, headText }),
    true,
  );
  // The new task's own body counts on its own, not only via the wiring line.
  const bodyOnly = diff
    .split("\n")
    .filter((_, i) => i < 2 || i > 3)
    .join("\n");
  assertEquals(
    taskfileChangeReachesColdPath({
      diff: bodyOnly,
      baseText: TASKFILE_TEXT,
      headText,
    }),
    true,
  );
});

test("taskfileChangeReachesColdPath: a section comment between tasks reaches nothing", () => {
  // Line 10 follows validate's body, so it must not be read as part of it.
  const lines = TASKFILE_TEXT.split("\n");
  const text = [...lines.slice(0, 9), "  # Tooling", ...lines.slice(9)].join(
    "\n",
  );
  const diff = hunk(10, 10, ["-  # Tooling", "+  # Tooling and installs"]);
  assertEquals(
    taskfileChangeReachesColdPath({ diff, baseText: text, headText: text }),
    false,
  );
});

test("classify: a Taskfile change with nothing to judge it by fails closed", () => {
  assertEquals(classify({ files: ["Taskfile.yml"] }).tier1, ["Taskfile.yml"]);
  assertEquals(
    classify({
      files: ["Taskfile.yml"],
      taskfile: { diff: hunk(9, 9, ["+x"]), baseText: "", headText: "" },
    }).tier1,
    ["Taskfile.yml"],
  );
});

// --- the readme.md badges exception (MCAA-1046) ---------------------------

const README_BEFORE = [
  "<h1>homelab</h1>",
  README_BADGES_BEGIN,
  "[![Cilium](https://img.shields.io/badge/Cilium-1.19.5-F8C517)](https://cilium.io/)",
  README_BADGES_END,
  "",
  "```bash",
  "task localdev:up",
  "```",
].join("\n");

test("classify: a readme diff only inside the badges region is not Tier 1", () => {
  // The Renovate regeneration bot's commit after a charts.cilium bump.
  const after = README_BEFORE.replace("Cilium-1.19.5", "Cilium-1.19.6");
  assertEquals(readmeChangedOutsideGenerated(README_BEFORE, after), false);
  assertEquals(
    classify({
      files: [
        "configuration/versions.yaml",
        "readme.md",
        "docs/applications.md",
        "tests/snapshots/homelab/addons.yaml",
      ],
      readme: { before: README_BEFORE, after },
    }),
    { tier1: [], tier2: [] },
  );
});

test("classify: a readme diff outside the badges region is Tier 1", () => {
  const after = README_BEFORE.replace(
    "task localdev:up",
    "task localdev:up -- --wait",
  ).replace("Cilium-1.19.5", "Cilium-1.19.6");
  assertEquals(readmeChangedOutsideGenerated(README_BEFORE, after), true);
  assertEquals(
    classify({ files: ["readme.md"], readme: { before: README_BEFORE, after } })
      .tier1,
    ["readme.md"],
  );
});

test("classify: a readme diff only in docs-check counters is not Tier 1", () => {
  // homelab#467 adding the 40th addon, as docs:check -- --fix rewrites it.
  const before = `${README_BEFORE}\n39 addons and 16 applications, 91 ArgoCD Applications in all.`;
  const after = `${README_BEFORE}\n40 addons and 17 applications, 93 ArgoCD Applications in all.`;
  assertEquals(readmeChangedOutsideGenerated(before, after), false);
  assertEquals(
    classify({ files: ["readme.md"], readme: { before, after } }).tier1,
    [],
  );
});

test("readmeChangedOutsideGenerated: a counter's words still count", () => {
  const before = `${README_BEFORE}\n39 addons in all.`;
  assertEquals(
    readmeChangedOutsideGenerated(
      before,
      `${README_BEFORE}\n39 add-ons in all.`,
    ),
    true,
  );
  assertEquals(
    readmeChangedOutsideGenerated(
      `${README_BEFORE}\nrun task 3 times`,
      `${README_BEFORE}\nrun task 4 times`,
    ),
    true,
  );
});

test("readmeChangedOutsideGenerated: moving a marker over prose counts", () => {
  // Widening the region to swallow a command must not hide the command change.
  const after = [
    "<h1>homelab</h1>",
    README_BADGES_BEGIN,
    "[![Cilium](https://img.shields.io/badge/Cilium-1.19.5-F8C517)](https://cilium.io/)",
    "",
    "```bash",
    "task localdev:ci",
    "```",
    README_BADGES_END,
  ].join("\n");
  assertEquals(readmeChangedOutsideGenerated(README_BEFORE, after), true);
});

test("readmeChangedOutsideGenerated: an added or deleted readme counts", () => {
  assertEquals(readmeChangedOutsideGenerated(null, README_BEFORE), true);
  assertEquals(readmeChangedOutsideGenerated(README_BEFORE, null), true);
});

test("classify: readme.md with no content supplied stays Tier 1", () => {
  assertEquals(classify({ files: ["readme.md"] }).tier1, ["readme.md"]);
});

test("README_BADGES markers match the region docs-check.ts writes", () => {
  const text = `${README_BADGES_BEGIN}\nbody\n${README_BADGES_END}`;
  assertEquals(regionRe("badges").exec(text)?.[2], "body");
});

test("README_COUNTERS match the readme counters docs-check.ts rewrites", () => {
  const readmeFixes = expectedLiterals({
    versions: {},
    addons: 1,
    applications: 1,
    argoApplications: 1,
    localdevApplications: 1,
    e2eSuites: [],
    smokeJobs: [],
    routes: [],
    addonApps: [],
    applicationApps: [],
  })
    .filter((l) => l.file === "readme.md" && l.fix)
    .map((l) => l.fix?.[0].source)
    .sort();
  assertEquals(README_COUNTERS.map((r) => r.source).sort(), readmeFixes);
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

test("renderComment: an infrastructure-tree hit names the classes no static check sees", () => {
  const classification = { tier1: [], tier2: ["terragrunt/env/main.hcl"] };
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
  }) as string;
  assert(c.includes("does not fail the check"));
  assert(c.includes("hardware prerequisites"));
  assert(c.includes("topology"));
  assert(c.includes("secret-store"));
  assert(c.includes("identity"));
  // Level 0 renders configuration/, not these trees; claiming it covers them is false.
  assert(!c.includes("level 0's render"));
});

test("renderComment: a configuration-only hit carries no infrastructure note", () => {
  const classification = { tier1: [], tier2: ["charts/secrets/values.yaml"] };
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
  }) as string;
  assert(c.includes("level 0's render"));
  assert(!c.includes("hardware prerequisites"));
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
