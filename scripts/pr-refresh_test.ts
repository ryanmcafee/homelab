#!/usr/bin/env -S bun test
/**
 * Unit tests for pr-refresh.ts, plus an end-to-end merge in a scratch repo that
 * reproduces what made 29 PRs conflict: a PR branch cut before .gitattributes
 * existed, a log both sides appended to, a count both sides moved, a snapshot
 * both sides regenerated, and one real disagreement.
 *
 *   bun test scripts/pr-refresh_test.ts
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import { assert, assertEquals, assertThrows } from "./lib/assert.ts";
import {
  branchGuardError,
  classifyPath,
  gitSupportsAttrSource,
  type Hunk,
  isCountOnly,
  maskOwned,
  mergeAndResolve,
  parseArgs,
  parseConflicts,
  parseUnionPaths,
  resolveCountConflicts,
  resolveUnionHunk,
  resolveUnionText,
  spaceHeadings,
  unionResolved,
} from "./pr-refresh.ts";

const hunk = (
  ours: string[],
  theirs: string[],
  inRegion = false,
  base: string[] = [],
): Hunk => ({
  ours,
  base,
  theirs,
  inRegion,
  touchesMarker: false,
});

test("classifyPath: generated, count and everything else", () => {
  const cases: [string, string][] = [
    ["tests/snapshots/homelab/applications.yaml", "generated"],
    ["tests/schemas/argoproj.io/application_v1alpha1.json", "generated"],
    ["charts/addons/values-localdev.yaml", "generated"],
    ["charts/applications/values-localdev.yaml", "generated"],
    ["readme.md", "counts"],
    [".github/homelab.svg", "counts"],
    ["docs/applications.md", "counts"],
    ["docs/networking.md", "counts"],
    ["charts/applications/values.yaml", "manual"],
    ["docs/runbooks/verification.md", "manual"],
    ["tests/snapshotsX/a.yaml", "manual"],
  ];
  for (const [path, want] of cases)
    assertEquals(classifyPath(path), want, path);
});

test("maskOwned: only the numbers docs:check owns", () => {
  assertEquals(
    maskOwned(
      "readme.md",
      "39 addons and 17 applications, 93 ArgoCD Applications in all, Talos 1.12",
    ),
    "# addons and # applications, # ArgoCD Applications in all, Talos 1.12",
  );
  assertEquals(
    maskOwned("readme.md", "→ 64 Applications synced from your working tree"),
    "→ # Applications synced from your working tree",
  );
  assertEquals(
    maskOwned(".github/homelab.svg", "  @keyframes c4{0%,52.826%{opacity:0}}"),
    "  @keyframes c#{#%,#%{opacity:#}}",
  );
  assertEquals(
    maskOwned(
      ".github/homelab.svg",
      '<text x="912" y="177">addons · 39</text>',
    ),
    '<text x="912" y="177">addons · #</text>',
  );
  assertEquals(maskOwned("charts/x/values.yaml", "replicas: 3"), "replicas: 3");
});

test("parseConflicts: merge style, diff3 style and region tracking", () => {
  const merge = [
    "a",
    "<<<<<<< HEAD",
    "x1",
    "=======",
    "x2",
    ">>>>>>> origin/main",
    "b",
  ].join("\n");
  const s = parseConflicts(merge);
  assertEquals(s, ["a", hunk(["x1"], ["x2"]), "b"]);

  const diff3 = [
    "<<<<<<< HEAD",
    "x1",
    "||||||| merged common ancestors",
    "x0",
    "=======",
    "x2",
    ">>>>>>> origin/main",
  ].join("\n");
  assertEquals(parseConflicts(diff3), [hunk(["x1"], ["x2"], false, ["x0"])]);

  const region = [
    "<!-- docs-check:begin addons-table -->",
    "<<<<<<< HEAD",
    "| a | 1 |",
    "=======",
    "| b | 2 |",
    ">>>>>>> origin/main",
    "<!-- docs-check:end addons-table -->",
    "<<<<<<< HEAD",
    "p",
    "=======",
    "q",
    ">>>>>>> origin/main",
  ].join("\n");
  const r = parseConflicts(region) ?? [];
  assertEquals((r[1] as Hunk).inRegion, true);
  assertEquals((r[3] as Hunk).inRegion, false);

  assertEquals(
    parseConflicts("<<<<<<< HEAD\nx\n=======\ny"),
    null,
    "unterminated",
  );
  assertEquals(parseConflicts("x\n>>>>>>> origin/main"), null, "unopened");
});

test("isCountOnly: counts resolve, real edits do not", () => {
  const readme = "readme.md";
  assert(
    isCountOnly(
      readme,
      hunk(
        ["39 addons and 17 applications, 94 ArgoCD Applications in all."],
        ["39 addons and 17 applications, 93 ArgoCD Applications in all."],
      ),
    ),
    "a count moved on both sides",
  );
  assert(
    !isCountOnly(
      readme,
      hunk(["40 addons, Talos 1.13"], ["39 addons, Talos 1.12"]),
    ),
    "a hand-written number on the same line changed too",
  );
  assert(
    !isCountOnly(readme, hunk(["39 addons, fast"], ["39 addons, slow"])),
    "prose changed",
  );
  assert(
    !isCountOnly(readme, hunk(["x", "x"], ["x"])),
    "a duplicated plain line",
  );
  assert(
    !isCountOnly(readme, hunk(["39 addons"], [])),
    "one side deleted the line",
  );

  const svg = ".github/homelab.svg";
  const counter = (n: number) => [
    `  /* e2e suite counter: ${n} steps of ${(45 / n).toFixed(3)}% from 45% to 90%, then ${n}/${n} holds */`,
    ...Array.from(
      { length: n },
      (_, i) => `  @keyframes c${i}{0%,${45 + i}%{opacity:0}}`,
    ),
  ];
  assert(
    isCountOnly(svg, hunk(counter(22), counter(23))),
    "the suite counter grew a keyframe",
  );
  // The shapes PR #504 hit: a reworded counter comment, the animation-class
  // line, and an odd suite count leaving one text element alone on its line.
  assert(
    isCountOnly(
      svg,
      hunk(
        [
          "  /* e2e suite counter: 22 steps from 45% to 90%, then 22/22 holds */",
          "  .c21{animation:c21 27s infinite}.c22{animation:c22 27s infinite}",
        ],
        [
          "  /* e2e suite counter: 23 steps of 1.957% from 45% to 90%, then 23/23 holds */",
          "  .c21{animation:c21 27s infinite}.c22{animation:c22 27s infinite}.c23{animation:c23 27s infinite}",
          '  <text class="c22" x="332" y="272">22/23 suites</text>',
        ],
      ),
    ),
    "generated counter lines of any shape",
  );
  assert(
    !isCountOnly(
      svg,
      hunk(
        ['  <text class="c1" x="1">1/2 suites</text>', '  <g id="new"/>'],
        ['  <text class="c1" x="1">1/3 suites</text>'],
      ),
    ),
    "a hand-written SVG line beside the counter",
  );
  assert(
    !isCountOnly(svg, hunk(["<rect x=1/>"], ["<rect x=2/>"])),
    "an unowned SVG number",
  );

  assert(
    isCountOnly("docs/applications.md", hunk(["| a |"], ["| b |"], true)),
    "inside a region",
  );
  assert(
    !isCountOnly("docs/applications.md", hunk(["| a |"], ["| b |"])),
    "outside a region",
  );
  assert(
    !isCountOnly(readme, {
      ...hunk(["39 addons"], ["40 addons"]),
      touchesMarker: true,
    }),
    "a region marker inside the hunk",
  );
  assert(
    !isCountOnly(
      "charts/x/values.yaml",
      hunk(["replicas: 3"], ["replicas: 2"]),
    ),
    "not a count file",
  );
});

test("resolveCountConflicts: picks the asked side, refuses a real change", () => {
  const text = [
    "# Homelab",
    "<<<<<<< HEAD",
    "64 Applications synced from your working tree",
    "=======",
    "63 Applications synced from your working tree",
    ">>>>>>> origin/main",
    "middle",
    "<<<<<<< HEAD",
    "39 addons and 18 applications",
    "=======",
    "40 addons and 17 applications",
    ">>>>>>> origin/main",
    "",
  ].join("\n");
  assertEquals(
    resolveCountConflicts("readme.md", text, "theirs"),
    "# Homelab\n63 Applications synced from your working tree\nmiddle\n40 addons and 17 applications\n",
  );
  assertEquals(
    resolveCountConflicts("readme.md", text, "ours"),
    "# Homelab\n64 Applications synced from your working tree\nmiddle\n39 addons and 18 applications\n",
  );
  const real = text.replace(
    "middle\n<<<<<<< HEAD\n39 addons",
    "middle\n<<<<<<< HEAD\n39 addonz",
  );
  assertEquals(resolveCountConflicts("readme.md", real, "theirs"), null);
});

test("resolveUnionHunk: insertions keep both, edits drop the stale line", () => {
  const u = (ours: string[], base: string[], theirs: string[]) =>
    resolveUnionHunk(hunk(ours, theirs, false, base));
  assertEquals(u(["P"], [], ["M"]), ["P", "M"], "both inserted");
  // #527: the PR edited a row, main inserted the next row.
  assertEquals(
    u(["A2"], ["A"], ["A", "B"]),
    ["A2", "B"],
    "PR edited, base inserted",
  );
  assertEquals(
    u(["A", "P"], ["A"], ["A3"]),
    ["P", "A3"],
    "base edited, PR inserted",
  );
  assertEquals(
    u(["X", "P"], ["X"], ["X", "Q"]),
    ["X", "P", "Q"],
    "kept by both",
  );
  assertEquals(
    u(["A2", "B"], ["A", "B"], ["A", "C"]),
    ["A2", "C"],
    "PR edited A, base replaced B",
  );
  assertEquals(
    u(["", "P"], [""], ["", "M"]),
    ["", "P", "M"],
    "a shared blank line",
  );
  assertEquals(u(["A1"], ["A"], ["A2"]), null, "both rewrote the same line");
  assertEquals(u([], ["A"], ["A2"]), null, "PR deleted what base edited");
  assertEquals(u([], ["A"], []), [], "both deleted, nothing added");
});

test("resolveUnionText: whole file, null on a real conflict", () => {
  const text = [
    "| a | 1 |",
    "<<<<<<< HEAD",
    "| b | 2, edited |",
    "||||||| base",
    "| b | 2 |",
    "=======",
    "| b | 2 |",
    "| c | 3 |",
    ">>>>>>> origin/main",
    "",
  ].join("\n");
  assertEquals(
    resolveUnionText(text),
    "| a | 1 |\n| b | 2, edited |\n| c | 3 |\n",
  );
  const editEdit = [
    "<<<<<<< HEAD",
    "| b | 2, edited |",
    "||||||| base",
    "| b | 2 |",
    "=======",
    "| b | 2, edited differently |",
    ">>>>>>> origin/main",
    "",
  ].join("\n");
  assertEquals(resolveUnionText(editEdit), null, "both sides rewrote row b");
});

test("spaceHeadings: restores the blank line union drops, outside fences", () => {
  const glued = "## Entries\n\n### b\n- b entry\n### a\n- a entry\n";
  assertEquals(
    spaceHeadings(glued),
    "## Entries\n\n### b\n- b entry\n\n### a\n- a entry\n",
  );
  assertEquals(
    spaceHeadings("# t\n\n## x\n"),
    "# t\n\n## x\n",
    "already spaced",
  );
  const fenced = "text\n```bash\necho\n# a shell comment\n```\n";
  assertEquals(spaceHeadings(fenced), fenced, "a comment in a code fence");
  assertEquals(
    spaceHeadings("#hashtag\nx\n"),
    "#hashtag\nx\n",
    "not a heading",
  );
});

test("spaceHeadings: the committed union files are already spaced", () => {
  for (const p of parseUnionPaths(readFileSync(".gitattributes", "utf8"))) {
    const text = readFileSync(p, "utf8");
    assertEquals(spaceHeadings(text), text, p);
  }
});

test("parseUnionPaths: reads merge=union lines, skips comments", () => {
  assertEquals(
    parseUnionPaths(
      "# merge=union is cool\na.md merge=union\nb.md text eol=lf\nc.md   -diff merge=union\n",
    ),
    ["a.md", "c.md"],
  );
});

test("parity: the committed .gitattributes unions exactly the files that exist", () => {
  const paths = parseUnionPaths(readFileSync(".gitattributes", "utf8"));
  assertEquals(paths, [
    "docs/project_notes/bugs.md",
    "docs/project_notes/issues.md",
    "docs/runbooks/verification.md",
  ]);
  for (const p of paths) readFileSync(p, "utf8");
});

test("gitSupportsAttrSource: 2.40 and later", () => {
  assert(gitSupportsAttrSource("git version 2.43.0"));
  assert(gitSupportsAttrSource("git version 2.40.1"));
  assert(gitSupportsAttrSource("git version 3.0.0"));
  assert(!gitSupportsAttrSource("git version 2.39.5 (Apple Git-154)"));
  assert(!gitSupportsAttrSource("nonsense"));
});

test("branchGuardError: refuses detached HEAD, Renovate and the base itself", () => {
  assert(branchGuardError("HEAD", "origin/main")?.includes("detached"));
  assert(
    branchGuardError("renovate/helm-charts", "origin/main")?.includes(
      "rebase checkbox",
    ),
  );
  assert(branchGuardError("main", "origin/main")?.includes("base itself"));
  assert(branchGuardError("feat/x", "origin/feat/x")?.includes("base itself"));
  assertEquals(branchGuardError("feat/x", "origin/main"), null);
  assertEquals(branchGuardError("feat/y", "origin/feat/x"), null);
});

test("parseArgs: defaults, flags and conflicts", () => {
  const d = parseArgs([]);
  assertEquals(d.base, "origin/main");
  assert(d.fetch && d.verify && !d.push && !d.dryRun && !d.cont);
  assertEquals(parseArgs(["--base", "origin/feat/x"]).base, "origin/feat/x");
  assertEquals(parseArgs(["--base=origin/feat/x"]).base, "origin/feat/x");
  const f = parseArgs(["--push", "--no-fetch", "--no-verify", "--continue"]);
  assert(f.push && !f.fetch && !f.verify && f.cont);
  assertThrows(() => parseArgs(["--dry-run", "--continue"]));
  assertThrows(() => parseArgs(["--base"]));
  assertThrows(() => parseArgs(["--bogus"]));
});

// ---------------------------------------------------------------------------
// End to end in a scratch repository (git only; no regeneration)
// ---------------------------------------------------------------------------

function sh(cwd: string, ...cmd: string[]): string {
  const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0)
    throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function write(dir: string, files: Record<string, string>) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
}

test("mergeAndResolve: base attributes, generated, count-only and manual conflicts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-refresh-"));
  try {
    sh(dir, "git", "init", "-q", "-b", "main");
    sh(dir, "git", "config", "user.email", "t@example.com");
    sh(dir, "git", "config", "user.name", "t");
    sh(dir, "git", "config", "merge.conflictStyle", "diff3");
    const log = (entry: string) =>
      `# Bug Log\n\n## Entries\n${entry}\n### old\n- old\n`;
    write(dir, {
      "docs/project_notes/bugs.md": log(""),
      "readme.md":
        "# Homelab\n\n63 Applications synced from your working tree\n",
      "tests/snapshots/homelab/applications.yaml": "apps: 1\n",
      "charts/applications/values.yaml": "replicas: 1\n",
    });
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-qm", "init");

    sh(dir, "git", "checkout", "-qb", "feat/pr");
    write(dir, {
      "docs/project_notes/bugs.md": log("\n### pr\n- pr entry\n"),
      "readme.md":
        "# Homelab\n\n64 Applications synced from your working tree\n",
      "tests/snapshots/homelab/applications.yaml": "apps: 2\n",
      "charts/applications/values.yaml": "replicas: 2\n",
    });
    sh(dir, "git", "commit", "-qam", "pr");

    sh(dir, "git", "checkout", "-q", "main");
    write(dir, {
      ".gitattributes": "docs/project_notes/bugs.md merge=union\n",
      "docs/project_notes/bugs.md": log("\n### main\n- main entry\n"),
      "readme.md":
        "# Homelab\n\n65 Applications synced from your working tree\n",
      "tests/snapshots/homelab/applications.yaml": "apps: 3\n",
      "charts/applications/values.yaml": "replicas: 3\n",
    });
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-qm", "main");
    sh(dir, "git", "checkout", "-q", "feat/pr");

    // The PR branch has no .gitattributes: only the base's attributes union the log.
    const union = await unionResolved(dir, "HEAD", "main", [
      "docs/project_notes/bugs.md",
    ]);
    assertEquals(union, ["docs/project_notes/bugs.md"]);

    const out = await mergeAndResolve(dir, "main");
    assertEquals(out.upToDate, false);
    assertEquals(out.generated, ["tests/snapshots/homelab/applications.yaml"]);
    assertEquals([...out.counts.keys()], ["readme.md"]);
    assertEquals(out.manual, ["charts/applications/values.yaml"]);

    const bugs = readFileSync(join(dir, "docs/project_notes/bugs.md"), "utf8");
    assert(bugs.includes("- pr entry") && bugs.includes("- main entry"), bugs);
    assert(!bugs.includes("<<<<<<<"), bugs);
    assertEquals(
      readFileSync(join(dir, "readme.md"), "utf8"),
      "# Homelab\n\n65 Applications synced from your working tree\n",
    );
    assertEquals(
      readFileSync(
        join(dir, "tests/snapshots/homelab/applications.yaml"),
        "utf8",
      ),
      "apps: 3\n",
    );
    assert(
      readFileSync(
        join(dir, "charts/applications/values.yaml"),
        "utf8",
      ).includes("<<<<<<<"),
    );
    assertEquals(
      sh(dir, "git", "diff", "--name-only", "--diff-filter=U"),
      "charts/applications/values.yaml",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeAndResolve: an edited row next to an inserted row is not duplicated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-refresh-"));
  try {
    sh(dir, "git", "init", "-q", "-b", "main");
    sh(dir, "git", "config", "user.email", "t@example.com");
    sh(dir, "git", "config", "user.name", "t");
    const table = (rows: string[]) =>
      ["| Check | What |", "|---|---|", ...rows, "", "## Next", ""].join("\n");
    write(dir, {
      "docs/runbooks/verification.md": table([
        "| `a` | one |",
        "| `b` | two |",
      ]),
    });
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-qm", "init");
    sh(dir, "git", "checkout", "-qb", "feat/pr");
    write(dir, {
      "docs/runbooks/verification.md": table([
        "| `a` | one |",
        "| `b` | two, sharper |",
      ]),
    });
    sh(dir, "git", "commit", "-qam", "pr edits b");
    sh(dir, "git", "checkout", "-q", "main");
    write(dir, {
      ".gitattributes": "docs/runbooks/verification.md merge=union\n",
      "docs/runbooks/verification.md": table([
        "| `a` | one |",
        "| `b` | two |",
        "| `c` | three |",
      ]),
    });
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-qm", "main adds c");
    sh(dir, "git", "checkout", "-q", "feat/pr");
    const out = await mergeAndResolve(dir, "main");
    assertEquals(out.union, ["docs/runbooks/verification.md"]);
    assertEquals(out.manual, []);
    assertEquals(
      readFileSync(join(dir, "docs/runbooks/verification.md"), "utf8"),
      table(["| `a` | one |", "| `b` | two, sharper |", "| `c` | three |"]),
    );
    assertEquals(sh(dir, "git", "diff", "--name-only"), "", "staged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeAndResolve: a clean merge stays uncommitted for regeneration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-refresh-"));
  try {
    sh(dir, "git", "init", "-q", "-b", "main");
    sh(dir, "git", "config", "user.email", "t@example.com");
    sh(dir, "git", "config", "user.name", "t");
    write(dir, { "a.md": "a\n", "b.md": "b\n" });
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-qm", "init");
    sh(dir, "git", "checkout", "-qb", "feat/pr");
    write(dir, { "a.md": "a2\n" });
    sh(dir, "git", "commit", "-qam", "pr");
    sh(dir, "git", "checkout", "-q", "main");
    write(dir, { "b.md": "b2\n" });
    sh(dir, "git", "commit", "-qam", "main");
    sh(dir, "git", "checkout", "-q", "feat/pr");
    const before = sh(dir, "git", "rev-parse", "HEAD");
    const out = await mergeAndResolve(dir, "main");
    assertEquals(out.upToDate, false);
    assertEquals(out.manual, []);
    assertEquals(
      sh(dir, "git", "rev-parse", "HEAD"),
      before,
      "nothing committed yet",
    );
    sh(dir, "git", "rev-parse", "--verify", "MERGE_HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeAndResolve: a branch that already contains the base is up to date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-refresh-"));
  try {
    sh(dir, "git", "init", "-q", "-b", "main");
    sh(dir, "git", "config", "user.email", "t@example.com");
    sh(dir, "git", "config", "user.name", "t");
    write(dir, { "a.md": "a\n" });
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-qm", "init");
    sh(dir, "git", "checkout", "-qb", "feat/pr");
    const out = await mergeAndResolve(dir, "main");
    assertEquals(out.upToDate, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
