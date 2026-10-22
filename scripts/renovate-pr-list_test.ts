import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { assertEquals, assertStringIncludes } from "./lib/assert.ts";

const REPO = "ryanmcafee/homelab";
const HEAD = "renovate/monitoring-stack";
const SHA = "4bbaf15aead0f1ad3e1cc546210b098b2a26b119";
const debug = Buffer.from(
  JSON.stringify({ createdInVer: "43.110.14", updatedInVer: "43.110.14" }),
).toString("base64");
const body = `<!--renovate-debug:${debug}-->`;

type Pr = {
  number: number;
  head: { ref: string; sha: string; repo: { full_name: string } };
  body: string;
};

function pr(number: number, ref: string, prBody = body): Pr {
  return {
    number,
    head: {
      ref,
      sha: number === 255 ? SHA : String(number),
      repo: { full_name: REPO },
    },
    body: prBody,
  };
}

async function runGate(pages: Pr[][], head = HEAD, sha = SHA) {
  const dir = mkdtempSync(join(tmpdir(), "renovate-pr-list-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      '#!/bin/sh\nif [ "$1" = "pr" ]; then cat "$MOCK_GH_FIRST_PAGE"; elif [ "$1" = "api" ] && [ "$2" = "--paginate" ] && [ "$3" = "repos/$GITHUB_REPOSITORY/pulls?state=open&per_page=100" ]; then cat "$MOCK_GH_ALL_PAGES"; else exit 2; fi\n',
    );
    chmodSync(gh, 0o755);
    const firstPage = join(dir, "first.json");
    const allPages = join(dir, "all.json");
    writeFileSync(
      firstPage,
      JSON.stringify(
        pages[0]!.map((item) => ({
          headRefName: item.head.ref,
          body: item.body,
        })),
      ),
    );
    writeFileSync(
      allPages,
      pages.map((page) => JSON.stringify(page)).join("\n"),
    );
    const result = Bun.spawnSync(["task", "renovate:deployed-major"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        MOCK_GH_FIRST_PAGE: firstPage,
        MOCK_GH_ALL_PAGES: allPages,
        GITHUB_REPOSITORY: REPO,
        GITHUB_HEAD_REF: head,
        GITHUB_EXPECTED_HEAD_SHA: sha,
        GITHUB_EXPECTED_PR_NUMBER: "255",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      status: result.exitCode,
      output: `${new TextDecoder().decode(result.stdout)}\n${new TextDecoder().decode(result.stderr)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("deployed-major reads a Renovate head on page two of 104 open PRs", async () => {
  const first = Array.from({ length: 100 }, (_, index) =>
    pr(500 - index, `renovate/other-${index}`),
  );
  const second = [
    pr(258, "renovate/other-a"),
    pr(257, "renovate/other-b"),
    pr(256, "renovate/other-c"),
    pr(255, HEAD),
  ];
  const result = await runGate([first, second]);
  assertEquals(result.status, 0, result.output);
  assertStringIncludes(result.output, "43.110.14");
});

test("deployed-major reads a known-good first-page head", async () => {
  const result = await runGate([[pr(255, HEAD)]]);
  assertEquals(result.status, 0, result.output);
  assertStringIncludes(result.output, "43.110.14");
});

test("deployed-major fails closed when the expected head is absent", async () => {
  const result = await runGate([[pr(256, "renovate/other")]]);
  assertEquals(result.status === 0, false);
  assertStringIncludes(
    result.output,
    "does not contain renovate/monitoring-stack",
  );
});

test("deployed-major fails closed when the PR head SHA changed", async () => {
  const result = await runGate([[pr(255, HEAD)]], HEAD, "old-head-sha");
  assertEquals(result.status === 0, false);
  assertStringIncludes(result.output, "expected head SHA");
});

test("another PR with the same ref and SHA cannot stand in for this PR", async () => {
  const impostor = pr(256, HEAD);
  impostor.head.sha = SHA;
  const result = await runGate([[impostor]]);
  assertEquals(result.status === 0, false);
  assertStringIncludes(result.output, "expected head SHA");
});

test("a fork with the same branch name cannot establish the deployed major", async () => {
  const fork = pr(255, HEAD);
  fork.head.repo.full_name = "someone-else/homelab";
  const result = await runGate([[fork]]);
  assertEquals(result.status === 0, false);
  assertStringIncludes(result.output, "Fork heads fail closed");
});

test("deployed-major fails closed when no version can be read", async () => {
  const result = await runGate([[pr(255, HEAD, "no renovate-debug blob")]]);
  assertEquals(result.status === 0, false);
  assertStringIncludes(
    result.output,
    "deployed Renovate version could not be read",
  );
});
