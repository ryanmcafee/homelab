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
