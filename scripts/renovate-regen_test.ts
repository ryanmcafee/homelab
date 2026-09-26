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
 * only one a person copy-pastes. `upgrade.yml` applies it with `git -c
 * user.email=...`, which is correct *in CI*. It is not correct in the manual
 * procedure: a git wrapper that exports `GIT_AUTHOR_EMAIL` overrides `-c
 * user.email` and leaves `--author` alone, and the agents that sweep these
 * bumps run behind exactly such a wrapper. Reproduced 2026-09-26 on the
 * Paperclip runner, same repository, same tree:
 *
 *   git -c user.email=homelab-regen-bot@... commit   -> author 2336262+…
 *   git commit --author "homelab-regen-bot <…>"      -> author homelab-regen-bot@…
 *
 * Both exit 0. So copying the CI form into the manual procedure produces, with
 * no error and no warning, the very orphaning commit the procedure exists to
 * prevent. The runbook must teach `--author`, and must not teach `-c
 * user.email` for the bot address.
 */
const RUNBOOK_PATH = "docs/runbooks/verification.md";

function runbookAuthorshipErrors(markdown: string, email: string): string[] {
  const errors: string[] = [];
  const quoted = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const banned = new RegExp(`-c\\s+user\\.email\\s*=\\s*['"]?${quoted}`, "g");
  for (const match of markdown.matchAll(banned)) {
    const line = markdown.slice(0, match.index ?? 0).split("\n").length;
    errors.push(
      `renovate-regen/runbook-authorship: ${RUNBOOK_PATH}:${line} sets the regeneration author with \`-c user.email\`, which a git wrapper that exports GIT_AUTHOR_EMAIL silently overrides. Use \`git commit --author\`.`,
    );
  }
  const teachesWorkingForm = [...markdown.matchAll(/--author/g)].some((match) =>
    markdown.slice(match.index ?? 0, (match.index ?? 0) + 160).includes(email),
  );
  if (!teachesWorkingForm) {
    errors.push(
      `renovate-regen/runbook-authorship: ${RUNBOOK_PATH} never shows \`--author\` with ${email}, so the manual regeneration path has no authorship recipe that survives a git wrapper.`,
    );
  }
  return errors;
}

const BOT_EMAIL_FIXTURE = "homelab-regen-bot@users.noreply.github.com";

test("runbookAuthorshipErrors accepts the --author recipe", () => {
  assertEquals(
    runbookAuthorshipErrors(
      'Author it yourself: `git commit --author "homelab-regen-bot <homelab-regen-bot@users.noreply.github.com>"`.\n',
      BOT_EMAIL_FIXTURE,
    ),
    [],
  );
});

test("runbookAuthorshipErrors rejects the CI `-c user.email` form", () => {
  // Verbatim shape of the recipe proposed for the manual fallback.
  const errors = runbookAuthorshipErrors(
    [
      "```sh",
      "git -c user.name=homelab-regen-bot \\",
      "    -c user.email=homelab-regen-bot@users.noreply.github.com \\",
      "    commit -m 'chore(deps): regenerate'",
      "```",
      'Elsewhere: `git commit --author "homelab-regen-bot <homelab-regen-bot@users.noreply.github.com>"`.',
    ].join("\n"),
    BOT_EMAIL_FIXTURE,
  );
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!, "renovate-regen/runbook-authorship");
  assertStringIncludes(errors[0]!, `${RUNBOOK_PATH}:3`);
});

test("runbookAuthorshipErrors fails closed when the recipe is dropped", () => {
  const errors = runbookAuthorshipErrors(
    "Run `task config:export:localdev` and `task test:snapshot -- --update` on the branch and commit.\n",
    BOT_EMAIL_FIXTURE,
  );
  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0]!, "never shows `--author`");
});

test("the runbook's manual regeneration recipe survives a git wrapper", () => {
  const identity = parseRegenIdentity(readFileSync(WORKFLOW_PATH, "utf8"));
  assertEquals(
    runbookAuthorshipErrors(readFileSync(RUNBOOK_PATH, "utf8"), identity.email),
    [],
  );
});
