#!/usr/bin/env -S bun test
/**
 * Unit tests for renovate-regen.ts, and the parity gate itself: the last test
 * reads the real .github/workflows/upgrade.yml and .github/renovate.json5, so
 * moving REGEN_BOT_EMAIL or editing gitIgnoredAuthors without moving the other
 * fails CI instead of silently orphaning every future renovate/* branch.
 *
 *   bun test scripts/renovate-regen_test.ts
 */

import { readFileSync } from "node:fs";
import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";
import {
  branchGuardError,
  commitIdentityFindings,
  COMMITTER_READ_FROM_MAJOR,
  committerIsRead,
  deployedMajorFindings,
  generatedOnlyError,
  identityParityError,
  parseGitIgnoredAuthors,
  parseRegenIdentity,
  readDeployedRenovate,
  RENOVATE_CONFIG_PATH,
  WORKFLOW_PATH,
} from "./renovate-regen.ts";

const WORKFLOW_FIXTURE = `
name: Upgrade verification
env:
  REGEN_BOT_NAME: homelab-regen-bot
  REGEN_BOT_EMAIL: homelab-regen-bot@users.noreply.github.com
`;

const CONFIG_FIXTURE = `{
  rebaseWhen: 'behind-base-branch',
  // .github/workflows/upgrade.yml commits as this author.
  gitIgnoredAuthors: [
    // a comment inside the array
    'homelab-regen-bot@users.noreply.github.com',
  ],
}`;

test("parseRegenIdentity reads the workflow env block", () => {
  const id = parseRegenIdentity(WORKFLOW_FIXTURE);
  assertEquals(id.name, "homelab-regen-bot");
  assertEquals(id.email, "homelab-regen-bot@users.noreply.github.com");
});

test("parseRegenIdentity accepts quoted values", () => {
  const id = parseRegenIdentity(
    `env:\n  REGEN_BOT_NAME: 'bot'\n  REGEN_BOT_EMAIL: "bot@example.invalid"\n`,
  );
  assertEquals(id.name, "bot");
  assertEquals(id.email, "bot@example.invalid");
});

test("parseRegenIdentity fails closed when the workflow drops the env key", () => {
  const err = assertThrows(() =>
    parseRegenIdentity("name: Upgrade verification\n"),
  );
  assertStringIncludes(String(err), "REGEN_BOT_NAME");
});

test("parseGitIgnoredAuthors ignores comments inside the array", () => {
  assertEquals(parseGitIgnoredAuthors(CONFIG_FIXTURE), [
    "homelab-regen-bot@users.noreply.github.com",
  ]);
});

test("parseGitIgnoredAuthors fails closed when the array is absent", () => {
  const err = assertThrows(() =>
    parseGitIgnoredAuthors("{ rebaseWhen: 'behind-base-branch' }"),
  );
  assertStringIncludes(String(err), "gitIgnoredAuthors");
});

test("identityParityError passes when the workflow identity is ignored", () => {
  assertEquals(
    identityParityError(
      { name: "bot", email: "bot@users.noreply.github.com" },
      ["bot@users.noreply.github.com"],
    ),
    null,
  );
});

test("identityParityError catches drift between the two files", () => {
  const err = identityParityError(
    { name: "bot", email: "renamed-bot@users.noreply.github.com" },
    ["bot@users.noreply.github.com"],
  );
  assert(err !== null, "drifted identity must be reported");
  assertStringIncludes(err!, "renovate-regen/identity-parity");
  assertStringIncludes(err!, "renamed-bot@users.noreply.github.com");
});

test("identityParityError catches an emptied gitIgnoredAuthors", () => {
  const err = identityParityError(
    { name: "bot", email: "bot@users.noreply.github.com" },
    [],
  );
  assert(err !== null, "an empty ignore list must be reported");
  assertStringIncludes(err!, "(empty)");
});

test("branchGuardError allows renovate/* and rejects everything else", () => {
  assertEquals(branchGuardError("renovate/monitoring-stack", false), null);
  const err = branchGuardError("feat/envoy-gateway", false);
  assert(err !== null, "a feature branch must be rejected");
  assertStringIncludes(err!, "renovate-regen/branch-scope");
  assertEquals(branchGuardError("main", false) !== null, true);
});

test("branchGuardError honours the documented --any-branch bypass", () => {
  assertEquals(branchGuardError("bump/traefikoidc", true), null);
});

test("generatedOnlyError passes for regenerated artefacts", () => {
  assertEquals(
    generatedOnlyError([
      "charts/addons/values-localdev.yaml",
      "tests/snapshots/localdev/addons.yaml",
      "tests/schemas/master-standalone-strict/foo.json",
      "readme.md",
      "docs/apps/sonarr.md",
    ]),
    null,
  );
});

test("generatedOnlyError rejects the real #252 case: a source fix beside the bump", () => {
  // renovate/infrastructure-tools carried `fix(verify): validate against the
  // X.Y.0 kubeconform schema set` (internal/verify/*.go, scripts/toggle-test.ts)
  // in the same branch as the bump. Authoring that as the bot would invite
  // Renovate to force-push over it.
  const err = generatedOnlyError([
    "charts/addons/values-localdev.yaml",
    "internal/verify/render.go",
    "scripts/toggle-test.ts",
  ]);
  assert(err !== null, "a non-generated file must be reported");
  assertStringIncludes(err!, "renovate-regen/generated-only");
  assertStringIncludes(err!, "internal/verify/render.go");
  assertStringIncludes(err!, "scripts/toggle-test.ts");
});

test("the repository's own regeneration identity is one Renovate ignores", () => {
  const identity = parseRegenIdentity(readFileSync(WORKFLOW_PATH, "utf8"));
  const ignoredAuthors = parseGitIgnoredAuthors(
    readFileSync(RENOVATE_CONFIG_PATH, "utf8"),
  );
  assertEquals(identityParityError(identity, ignoredAuthors), null);
  // Fork-ability: the trusted author may not be a personal address, or a fork's
  // regeneration commits (carrying the forker's address) orphan every branch.
  for (const author of ignoredAuthors) {
    assert(
      author.endsWith("@users.noreply.github.com"),
      `gitIgnoredAuthors entry ${author} is not a generic bot address; a fork cannot inherit it`,
    );
  }
});

/**
 * The runbook is the third place the regeneration identity appears, and the
 * only one a person copy-pastes. Both halves of the recipe are load-bearing,
 * but for different Renovate majors: `isBranchModified()` collects `%ae` only
 * through 43.x and `%ae` *and* `%ce` from 44.0.0, then abandons the branch if
 * any address survives removing the git author and `gitIgnoredAuthors`
 * (renovatebot/renovate `lib/util/git/index.ts`; see
 * COMMITTER_READ_FROM_MAJOR). This repository ran 43.110.14 on 2026-09-26, so
 * the author is what counts today and the committer is what will count after
 * the 44 upgrade — the recipe has to satisfy both, and the runbook has to say
 * which is which. Measured 2026-09-26 on the Paperclip runner, one tree, three
 * invocations, all exiting 0:
 *
 *   git -c user.email=<bot> commit                    -> author <op>  committer <op>
 *   GIT_COMMITTER_EMAIL=<bot> git commit --author <bot> -> author <bot> committer <op>
 *   git commit --author <bot>                         -> author <bot> committer <op>
 *
 * So `-c user.email` is what carries the committer on an ordinary machine and
 * `--author` is the only form that survives a wrapper exporting
 * `GIT_AUTHOR_EMAIL`; neither alone produces a Renovate-managed commit, and
 * where the committer is pinned no git invocation can. The runbook therefore
 * has to show both forms, show the `%ce` read-back that detects the pinned
 * case, and show the API fallback that is the only way out of it.
 */
const RUNBOOK_PATH = "docs/runbooks/verification.md";

function runbookAuthorshipErrors(markdown: string, email: string): string[] {
  const errors: string[] = [];
  const quoted = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const near = (re: RegExp, window = 200): boolean =>
    [...markdown.matchAll(re)].some((match) =>
      markdown
        .slice(match.index ?? 0, (match.index ?? 0) + window)
        .includes(email),
    );
  const required: [boolean, string][] = [
    [
      near(/--author/g, 160),
      `never shows \`git commit --author\` with ${email}, so the manual path has no author recipe that survives a wrapper exporting GIT_AUTHOR_EMAIL`,
    ],
    [
      new RegExp(`-c\\s+user\\.email\\s*=\\s*['"]?${quoted}`).test(markdown),
      `never shows \`-c user.email=${email}\`, so the manual path sets no committer — inert on the deployed Renovate 43.x, but from Renovate ${COMMITTER_READ_FROM_MAJOR} the committer of every commit ahead of the base branch counts too`,
    ],
    [
      /%ce/.test(markdown),
      "never shows the `%ce` read-back, so an operator whose committer is pinned by a credential wrapper cannot tell that the commit they just made orphaned the branch",
    ],
    [
      near(/committer\[email\]/g, 120),
      `never shows the API fallback (\`committer[email]=${email}\`), which is the only path left when a wrapper pins the committer`,
    ],
    [
      new RegExp(
        `Renovate\\s+${COMMITTER_READ_FROM_MAJOR}\\b|\\b${COMMITTER_READ_FROM_MAJOR}\\.x\\b`,
      ).test(markdown),
      `never names Renovate ${COMMITTER_READ_FROM_MAJOR} as the major at which the committer starts counting, so a reader cannot tell whether a committer mismatch is an orphaning event today or only after the upgrade`,
    ],
  ];
  for (const [satisfied, why] of required) {
    if (!satisfied) {
      errors.push(`renovate-regen/runbook-authorship: ${RUNBOOK_PATH} ${why}.`);
    }
  }
  return errors;
}

const BOT_EMAIL_FIXTURE = "homelab-regen-bot@users.noreply.github.com";

/** A minimal runbook section that satisfies all four requirements. */
const COMPLETE_RECIPE = [
  "```sh",
  "git -c user.name=homelab-regen-bot \\",
  "    -c user.email=homelab-regen-bot@users.noreply.github.com \\",
  '    commit --author "homelab-regen-bot <homelab-regen-bot@users.noreply.github.com>" \\',
  "    -m 'chore(deps): regenerate'",
  "git log -1 --format='%ae %ce'   # both must be the bot address",
  "```",
  "The committer only counts from Renovate 44; on the deployed 43.x it is ignored.",
  "If the committer is not the bot address, a wrapper pinned it; use the API instead:",
  "```sh",
  'gh api -X PUT repos/{owner}/{repo}/contents/{path} -f branch="$BRANCH" \\',
  "  -f 'author[email]=homelab-regen-bot@users.noreply.github.com' \\",
  "  -f 'committer[email]=homelab-regen-bot@users.noreply.github.com'",
  "```",
].join("\n");

test("runbookAuthorshipErrors accepts the complete recipe", () => {
  assertEquals(runbookAuthorshipErrors(COMPLETE_RECIPE, BOT_EMAIL_FIXTURE), []);
});

test("runbookAuthorshipErrors rejects an --author-only recipe", () => {
  // The shape this gate shipped with: correct author, committer left foreign.
  const errors = runbookAuthorshipErrors(
    COMPLETE_RECIPE.replace(
      "    -c user.email=homelab-regen-bot@users.noreply.github.com \\\n",
      "",
    ),
    BOT_EMAIL_FIXTURE,
  );
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!, "renovate-regen/runbook-authorship");
  assertStringIncludes(errors[0]!, "sets no committer");
});

test("runbookAuthorshipErrors rejects a recipe with no committer read-back", () => {
  const errors = runbookAuthorshipErrors(
    COMPLETE_RECIPE.replace(
      "git log -1 --format='%ae %ce'   # both must be the bot address\n",
      "",
    ),
    BOT_EMAIL_FIXTURE,
  );
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!, "renovate-regen/runbook-authorship");
  assertStringIncludes(errors[0]!, "`%ce` read-back");
});

test("runbookAuthorshipErrors rejects a recipe with no API fallback", () => {
  const errors = runbookAuthorshipErrors(
    COMPLETE_RECIPE.split("If the committer is not the bot address")[0]!,
    BOT_EMAIL_FIXTURE,
  );
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!, "renovate-regen/runbook-authorship");
  assertStringIncludes(errors[0]!, "API fallback");
});

test("runbookAuthorshipErrors fails closed when the recipe is dropped", () => {
  const errors = runbookAuthorshipErrors(
    "Run `task config:export:localdev` and `task test:snapshot -- --update` on the branch and commit.\n",
    BOT_EMAIL_FIXTURE,
  );
  assertEquals(errors.length, 5);
  assertStringIncludes(errors[0]!, "never shows `git commit --author`");
  assertStringIncludes(
    errors[4]!,
    `never names Renovate ${COMMITTER_READ_FROM_MAJOR}`,
  );
});

const IDENTITY_FIXTURE = {
  name: "homelab-regen-bot",
  email: BOT_EMAIL_FIXTURE,
};
/** What the agent runner's git wrapper actually pins the committer to. */
const PINNED_COMMITTER = "2336262+operator@users.noreply.github.com";

test("committerIsRead tracks the 43 -> 44 boundary", () => {
  assertEquals(COMMITTER_READ_FROM_MAJOR, 44);
  assertEquals(committerIsRead(43), false);
  assertEquals(committerIsRead(44), true);
  assertEquals(committerIsRead(null), false, "unknown must not fail closed");
});

test("a pinned committer is advisory on the deployed 43.x, not an error", () => {
  // The regression this replaces: erroring here made `task renovate:regen`
  // exit 1 after a commit that Renovate 43.110.14 tracks perfectly well, i.e.
  // the tool rejected its own correct output for its only intended actor.
  const { error, warning } = commitIdentityFindings(
    IDENTITY_FIXTURE,
    BOT_EMAIL_FIXTURE,
    PINNED_COMMITTER,
    { committerIsRead: false },
  );
  assertEquals(error, null);
  assert(warning !== null);
  assertStringIncludes(warning, "renovate-regen/commit-identity");
  assertStringIncludes(warning, PINNED_COMMITTER);
  assertStringIncludes(warning, "Renovate");
  assertStringIncludes(warning, "44");
  assertStringIncludes(warning, "committer[email]");
});

test("the same pinned committer is an error once Renovate reads it", () => {
  const { error, warning } = commitIdentityFindings(
    IDENTITY_FIXTURE,
    BOT_EMAIL_FIXTURE,
    PINNED_COMMITTER,
    { committerIsRead: true },
  );
  assertEquals(warning, null);
  assert(error !== null);
  assertStringIncludes(error, "renovate-regen/commit-identity");
  assertStringIncludes(error, `committer: ${PINNED_COMMITTER}`);
  assert(
    !error.includes("author:"),
    "the author was correct and must not be reported",
  );
});

test("a wrong author is an error in both regimes", () => {
  for (const read of [false, true]) {
    const { error } = commitIdentityFindings(
      IDENTITY_FIXTURE,
      "operator@example.com",
      BOT_EMAIL_FIXTURE,
      { committerIsRead: read },
    );
    assert(
      error !== null,
      `author mismatch must fail with committerIsRead=${read}`,
    );
    assertStringIncludes(error, "author: operator@example.com");
  }
});

test("a fully correct commit is clean in both regimes", () => {
  for (const read of [false, true]) {
    assertEquals(
      commitIdentityFindings(
        IDENTITY_FIXTURE,
        BOT_EMAIL_FIXTURE,
        BOT_EMAIL_FIXTURE,
        { committerIsRead: read },
      ),
      { error: null, warning: null },
    );
  }
});

test("the runbook's manual regeneration recipe survives a git wrapper", () => {
  const identity = parseRegenIdentity(readFileSync(WORKFLOW_PATH, "utf8"));
  assertEquals(
    runbookAuthorshipErrors(readFileSync(RUNBOOK_PATH, "utf8"), identity.email),
    [],
  );
});

/* ---------------------------------------------------------------------------
 * renovate-regen/deployed-major: read the boundary, do not remember it.
 *
 * The 43 -> 44 upgrade arrives through a rate-limited container-image bump on
 * Renovate's own schedule, and its symptom on the far side is a branch that
 * silently stops being rebased. The only in-band source of the *deployed*
 * version is the base64 `renovate-debug` comment Renovate writes at the foot of
 * every PR body it touches.
 * ------------------------------------------------------------------------- */

/**
 * The real blob from the foot of ryanmcafee/homelab#374 on 2026-09-26, copied
 * byte-for-byte. It decodes to
 * {"createdInVer":"43.110.14","updatedInVer":"43.110.14","targetBranch":"main",
 *  "labels":["dependencies","renovate"]} — the measurement MCAA-205 rests on.
 */
const REAL_43_BLOB =
  "<!--renovate-debug:eyJjcmVhdGVkSW5WZXIiOiI0My4xMTAuMTQiLCJ1cGRhdGVkSW5WZXIiOiI0My4xMTAuMTQiLCJ0YXJnZXRCcmFuY2giOiJtYWluIiwibGFiZWxzIjpbImRlcGVuZGVuY2llcyIsInJlbm92YXRlIl19-->";

/** Build a body carrying a synthetic blob, the way Renovate lays one out. */
function bodyWithDebug(debug: Record<string, unknown>): string {
  const base64 = Buffer.from(JSON.stringify(debug), "utf8").toString("base64");
  return [
    "### Configuration",
    "",
    "This PR has been generated by [Renovate Bot](https://redirect.github.com/renovatebot/renovate).",
    `<!--renovate-debug:${base64}-->`,
  ].join("\n");
}

test("readDeployedRenovate reads the real 43.110.14 blob from homelab#374", () => {
  const read = readDeployedRenovate([`body text\n${REAL_43_BLOB}`]);
  assertEquals(read.kind, "read");
  if (read.kind !== "read") return;
  assertEquals(read.deployed.version, "43.110.14");
  assertEquals(read.deployed.major, 43);
  assertEquals(read.deployed.field, "updatedInVer");
  assertEquals(read.blobs, 1);
});

test("readDeployedRenovate prefers updatedInVer over createdInVer", () => {
  // An abandoned branch keeps the version that opened it; the version that last
  // touched the PR is the deployed one.
  const read = readDeployedRenovate([
    bodyWithDebug({ createdInVer: "43.110.14", updatedInVer: "44.115.10" }),
  ]);
  assertEquals(read.kind, "read");
  if (read.kind !== "read") return;
  assertEquals(read.deployed.version, "44.115.10");
  assertEquals(read.deployed.field, "updatedInVer");
});

test("readDeployedRenovate takes the highest major across bodies", () => {
  // The direction that matters: a stale body must not mask a live upgrade,
  // because the failure being guarded is running the 43 regime under 44.
  const read = readDeployedRenovate([
    bodyWithDebug({ createdInVer: "43.110.14", updatedInVer: "43.110.14" }),
    bodyWithDebug({ createdInVer: "44.115.10", updatedInVer: "44.115.10" }),
    bodyWithDebug({ createdInVer: "43.110.14", updatedInVer: "43.110.14" }),
  ]);
  assertEquals(read.kind, "read");
  if (read.kind !== "read") return;
  assertEquals(read.deployed.major, 44);
  assertEquals(read.blobs, 3);
});

test("readDeployedRenovate distinguishes absent from unreadable", () => {
  assertEquals(readDeployedRenovate(["a PR body with no blob"]).kind, "absent");
  assertEquals(readDeployedRenovate([]).kind, "absent");
  // Valid base64, not JSON: the blob format moved under us.
  const mangled = Buffer.from("not json at all", "utf8").toString("base64");
  const read = readDeployedRenovate([`<!--renovate-debug:${mangled}-->`]);
  assertEquals(read.kind, "unreadable");
  assertEquals(read.blobs, 1);
});

test("a synthetic 44.x blob fails the gate and names renovate-regen/deployed-major", () => {
  // Deliberately bad input, which is the point: this is the only rehearsal of
  // the upgrade available before it lands. Assert the rule id, not just that
  // something failed — a parser crash would also be non-zero and would prove
  // nothing about the rule.
  const read = readDeployedRenovate([
    bodyWithDebug({ createdInVer: "44.115.10", updatedInVer: "44.115.10" }),
  ]);
  const { error, warning } = deployedMajorFindings(read, {
    committerIsRead: false,
  });
  assertEquals(warning, null);
  assert(error !== null, "a 44.x deployment under the 43 regime must fail");
  assertStringIncludes(error, "renovate-regen/deployed-major");
  assertStringIncludes(error, "44.115.10");
  assertStringIncludes(error, "%ce");
  // It has to say what to do, or it is an alert with no runbook.
  assertStringIncludes(error, "--committer-strict");
  assertStringIncludes(error, "docs/runbooks/verification.md");
});

test("the same 44.x blob passes once the repository is configured for 44", () => {
  const read = readDeployedRenovate([
    bodyWithDebug({ createdInVer: "44.115.10", updatedInVer: "44.115.10" }),
  ]);
  assertEquals(deployedMajorFindings(read, { committerIsRead: true }), {
    error: null,
    warning: null,
  });
});

test("the deployed 43.x under the 43 regime is clean", () => {
  assertEquals(
    deployedMajorFindings(readDeployedRenovate([REAL_43_BLOB]), {
      committerIsRead: false,
    }),
    { error: null, warning: null },
  );
});

test("43.x under the 44 regime warns rather than fails", () => {
  // Stricter than the deployment costs a correct commit nothing, so this must
  // not be an error: a gate that fails on being over-careful gets bypassed.
  const { error, warning } = deployedMajorFindings(
    readDeployedRenovate([REAL_43_BLOB]),
    { committerIsRead: true },
  );
  assertEquals(error, null);
  assert(warning !== null);
  assertStringIncludes(warning, "renovate-regen/deployed-major");
  assertStringIncludes(warning, "43.110.14");
});

test("an unmeasurable version fails closed in both regimes", () => {
  // The whole reason this check exists is that a version was assumed instead of
  // read, so "I could not read it" must not collapse into "it is fine".
  for (const read of [
    readDeployedRenovate(["no blob here"]),
    readDeployedRenovate([
      `<!--renovate-debug:${Buffer.from("{", "utf8").toString("base64")}-->`,
    ]),
  ]) {
    const { error } = deployedMajorFindings(read, { committerIsRead: false });
    assert(error !== null, `${read.kind} must fail closed`);
    assertStringIncludes(error, "renovate-regen/deployed-major");
  }
});

test("every rule id the script can emit is documented in the runbook", () => {
  // No alert without a runbook. A new guard that fires with a rule id nobody can
  // look up is noise, and the guard table is where a forking operator looks.
  const source = readFileSync("scripts/renovate-regen.ts", "utf8");
  const runbook = readFileSync(RUNBOOK_PATH, "utf8");
  const ruleIds = new Set(
    [...source.matchAll(/renovate-regen\/[a-z][a-z-]*/g)].map((m) => m[0]),
  );
  assert(ruleIds.size >= 6, `expected the known guards, found ${ruleIds.size}`);
  for (const ruleId of ruleIds) {
    assert(
      runbook.includes(ruleId),
      `${ruleId} is emitted by scripts/renovate-regen.ts but never documented in ${RUNBOOK_PATH}`,
    );
  }
});
