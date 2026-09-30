#!/usr/bin/env -S bun test
/**
 * Failure-first tests for kind-cold-draw.ts: a stale head, a warm cache and an
 * absent cluster must each be caught before a draw is counted.
 *
 *   bun test scripts/kind-cold-draw_test.ts
 */

import { test } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";
import {
  ALLOWED_DRAWS,
  assertCold,
  capture,
  checkHead,
  classify,
  GuardError,
  parseFlags,
  readSummary,
  summarize,
  UsageError,
} from "./kind-cold-draw.ts";

const PR487 = "aa8d475f8db5ff9310e62e697adc776d2147e084";
const PR536 = "427cd3d5fc85a28ee7b3d15c39f84fe02ff147f3";

test("allowlist is exactly PR 487 and PR 536 at their approved SHAs", () => {
  assertEquals({ ...ALLOWED_DRAWS }, { "487": PR487, "536": PR536 });
});

test("checkHead accepts the approved head, by number or by label name", () => {
  assertEquals(checkHead("487", PR487), PR487);
  assertEquals(checkHead("kind-cold-draw-536", `${PR536}\n`), PR536);
});

test("checkHead fails a changed head and names both SHAs", () => {
  const moved = "0000000000000000000000000000000000000001";
  const err = assertThrows(() => checkHead("487", moved), GuardError);
  assertStringIncludes(err.message, `allowed ${PR487}`);
  assertStringIncludes(err.message, `live ${moved}`);
  assertStringIncludes(err.message, "does not count");
});

test("checkHead fails an empty live head", () => {
  assertThrows(() => checkHead("536", ""), GuardError, "live <empty>");
});

test("checkHead refuses a PR outside the allowlist", () => {
  assertThrows(
    () => checkHead("535", PR536),
    GuardError,
    "not an allowed draw target",
  );
});

test("assertCold passes when the cache directory is absent", async () => {
  const dir = join(
    await mkdtemp(join(tmpdir(), "kcd-")),
    "homelab-kind-registry",
  );
  assertStringIncludes(await assertCold(dir), "absent");
});

test("assertCold passes when the cache directory is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kcd-"));
  assertStringIncludes(await assertCold(dir), "empty");
});

test("assertCold fails a restored registry cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kcd-"));
  await mkdir(join(dir, "ecr"));
  await writeFile(join(dir, "ecr", "blob"), "x");
  await assertRejects(() => assertCold(dir), GuardError, "not be cold");
});

test("parseFlags rejects a dangling flag", () => {
  assertThrows(() => parseFlags(["--pr"]), UsageError);
});

const pulledPod = {
  items: [
    {
      metadata: { name: "argocd-redis-abc" },
      spec: {
        containers: [
          {
            name: "redis",
            image: "ecr-public.aws.com/docker/library/redis:8.2.3-alpine",
          },
        ],
      },
      status: {
        phase: "Running",
        containerStatuses: [
          {
            name: "redis",
            image: "ecr-public.aws.com/docker/library/redis:8.2.3-alpine",
            imageID: "ecr-public.aws.com/docker/library/redis@sha256:abc",
            ready: true,
            restartCount: 0,
            state: { running: {} },
          },
        ],
      },
    },
  ],
};

const podEvents = {
  items: [
    {
      involvedObject: { name: "argocd-redis-abc" },
      reason: "Pulled",
      count: 1,
      lastTimestamp: "t1",
      message:
        'Successfully pulled image "redis" in 2.2s (2.2s including waiting)',
    },
    {
      involvedObject: { name: "argocd-redis-abc" },
      reason: "BackOff",
      count: 3,
      lastTimestamp: "t0",
      message: "Back-off pulling image",
    },
    {
      involvedObject: { name: "argocd-server-xyz" },
      reason: "Pulled",
      count: 1,
      lastTimestamp: "t1",
      message: "other pod",
    },
  ],
};

test("summarize records image, readiness, pull timing and failure events for the redis pod only", () => {
  const s = summarize(pulledPod, podEvents);
  assertEquals(s.pod, "argocd-redis-abc");
  assertEquals(s.image, "ecr-public.aws.com/docker/library/redis:8.2.3-alpine");
  assertEquals(s.ready, true);
  assertEquals(
    s.pullEvents.map((e) => e.message),
    ['Successfully pulled image "redis" in 2.2s (2.2s including waiting)'],
  );
  assertEquals(
    s.failureEvents.map((e) => `${e.reason}x${e.count}`),
    ["BackOffx3"],
  );
  assertEquals(s.missing, []);
});

test("summarize records a pod stuck in ImagePullBackOff without a container status as missing", () => {
  const stuck = {
    items: [
      { metadata: { name: "argocd-redis-abc" }, status: { phase: "Pending" } },
    ],
  };
  const s = summarize(stuck, undefined);
  assertEquals(s.waitingReason, null);
  assertEquals(s.missing, [
    "redis container: pod argocd-redis-abc reports no containerStatus named redis",
  ]);
});

test("capture without a cluster or registry still writes explicit missing evidence", async () => {
  const out = await mkdtemp(join(tmpdir(), "kcd-out-"));
  const s = await capture({
    out,
    context: "kind-cold-draw-test-no-such-context",
    namespace: "argocd",
    registry: "kind-cold-draw-test-no-such-container",
  });
  assertEquals(s.pod, null);
  assert(
    s.missing.some((m) => m.startsWith("redis pod: no pod matched")),
    s.missing.join("\n"),
  );
  assert(
    s.missing.some((m) =>
      m.startsWith("container kind-cold-draw-test-no-such-container:"),
    ),
    s.missing.join("\n"),
  );
  assertStringIncludes(
    await readFile(join(out, "redis-describe.txt"), "utf8"),
    "MISSING",
  );
  const onDisk = JSON.parse(await readFile(join(out, "summary.json"), "utf8"));
  assertEquals(onDisk.missing, s.missing);
});

test("the draw workflow restores no cache of any kind", async () => {
  const wf = await readFile(
    new URL("../.github/workflows/kind-cold-draw.yml", import.meta.url),
    "utf8",
  );
  assert(
    !/^\s*-?\s*uses:\s*actions\/cache/m.test(wf),
    "kind-cold-draw.yml must not use actions/cache",
  );
  assert(
    !/^\s*restore-keys:/m.test(wf),
    "kind-cold-draw.yml must not declare restore-keys",
  );
});

const reproducedSummary = async () =>
  readSummary(
    new URL("./testdata/kind-cold-draw/pr487-reproduced/", import.meta.url)
      .pathname,
  );

const argocdFailed = { argocd: "failure", sync: "skipped", wait: "skipped" };
const allPassed = { argocd: "success", sync: "success", wait: "success" };

test("verdict passes the PR 487 draw that reproduced Redis ImagePullBackOff", async () => {
  const s = await reproducedSummary();
  const v = classify(s, argocdFailed);
  assertEquals([v.kind, v.pass], ["reproduced", true]);
  assertStringIncludes(v.reason, "localdev:argocd=failure");
  assertStringIncludes(v.reason, "ImagePullBackOff");
});

test("verdict fails the same failed draw when registry evidence is missing", async () => {
  const s = await reproducedSummary();
  const v = classify(
    { ...s, missing: ["container kind-registry-ecr: docker logs exited 1"] },
    argocdFailed,
  );
  assertEquals([v.kind, v.pass], ["incomplete-evidence", false]);
  assertStringIncludes(v.reason, "kind-registry-ecr");
});

test("verdict fails a cluster step failure that is not the Redis pull", () => {
  const v = classify(summarize(pulledPod, { items: [] }), argocdFailed);
  assertEquals([v.kind, v.pass], ["other-failure", false]);
  assertStringIncludes(v.reason, "no pull failure");
});

test("verdict fails when every step passed but Redis is not ready", async () => {
  const s = await reproducedSummary();
  const v = classify(s, allPassed);
  assertEquals([v.kind, v.pass], ["other-failure", false]);
});

test("verdict passes a clean draw as not reproduced", () => {
  const v = classify(summarize(pulledPod, { items: [] }), allPassed);
  assertEquals([v.kind, v.pass], ["not-reproduced", true]);
});

test("verdict passes a draw whose pull failed then recovered", () => {
  const recovered = summarize(pulledPod, {
    items: [
      {
        involvedObject: { name: "argocd-redis-abc" },
        reason: "Failed",
        message: "Error: ErrImagePull",
      },
    ],
  });
  assertEquals(classify(recovered, allPassed).kind, "recovered");
});

test("readSummary refuses a file that is not a capture summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kcd-verdict-"));
  await writeFile(join(dir, "summary.json"), '{"pod":"x"}');
  await assertRejects(() => readSummary(dir), GuardError, "not a capture");
});
