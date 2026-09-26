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
  commitIdentityError,
  generatedOnlyError,
  identityParityError,
  parseGitIgnoredAuthors,
  parseRegenIdentity,
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
 * because Renovate's `isBranchModified()` unions `%ae` *and* `%ce` over every
 * commit in `origin/<base>..origin/<branch>` and abandons the branch if any
 * address survives removing the git author, `gitIgnoredAuthors` and the
 * platform's own `noreply@github.com` (renovatebot/renovate
 * `lib/util/git/index.ts`; `lib/modules/platform/github/index.ts` for the
 * platform list). Measured 2026-09-26 on the Paperclip runner, one tree, three
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
      `never shows \`-c user.email=${email}\`, so the manual path sets no committer — and Renovate reads the committer of every commit ahead of the base branch, not just the author`,
    ],
    [
      /%ce/.test(markdown),
      "never shows the `%ce` read-back, so an operator whose committer is pinned by a credential wrapper cannot tell that the commit they just made orphaned the branch",
    ],
    [
      near(/committer\[email\]/g, 120),
      `never shows the API fallback (\`committer[email]=${email}\`), which is the only path left when a wrapper pins the committer`,
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
  assertEquals(errors.length, 4);
  assertStringIncludes(errors[0]!, "never shows `git commit --author`");
});

test("commitIdentityError names the committer when only the author is right", () => {
  const identity = { name: "homelab-regen-bot", email: BOT_EMAIL_FIXTURE };
  const error = commitIdentityError(
    identity,
    BOT_EMAIL_FIXTURE,
    "2336262+operator@users.noreply.github.com",
  );
  assert(error !== null);
  assertStringIncludes(error, "renovate-regen/commit-identity");
  assertStringIncludes(
    error,
    "committer: 2336262+operator@users.noreply.github.com",
  );
  assert(
    !error.includes("author:"),
    "the author was correct and must not be reported",
  );
  assertStringIncludes(error, "committer[email]");
});

test("commitIdentityError passes only when both addresses are the bot", () => {
  const identity = { name: "homelab-regen-bot", email: BOT_EMAIL_FIXTURE };
  assertEquals(
    commitIdentityError(identity, BOT_EMAIL_FIXTURE, BOT_EMAIL_FIXTURE),
    null,
  );
  assert(
    commitIdentityError(identity, "operator@example.com", BOT_EMAIL_FIXTURE) !==
      null,
  );
});

test("the runbook's manual regeneration recipe survives a git wrapper", () => {
  const identity = parseRegenIdentity(readFileSync(WORKFLOW_PATH, "utf8"));
  assertEquals(
    runbookAuthorshipErrors(readFileSync(RUNBOOK_PATH, "utf8"), identity.email),
    [],
  );
});
