#!/usr/bin/env -S bun test
/**
 * Proves the rotation drill's 180s wall-clock bound in tests/e2e/nats-auth/probes.sh cannot
 * pass a run that took longer than 180s.
 *
 * The drill compares two whole-second `date +%s` stamps, which understate real time by up to
 * a second: a delta of 180 can be 180.998s of real time. Level 2 never reaches that boundary,
 * so this file runs the shipped `drill_await` phase with `nats` and `date` stand-ins.
 *
 *   bun test scripts/nats-auth-drill-deadline_test.ts
 */

import { test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals, assertStringIncludes } from "./lib/assert.ts";

const PROBES = join(import.meta.dir, "..", "tests", "e2e", "nats-auth", "probes.sh");
const APPLIED_AT = 1_000;

function stub(path: string, lines: string[]): void {
  writeFileSync(path, ["#!/bin/sh", ...lines].join("\n"));
  chmodSync(path, 0o755);
}

/** Runs drill_await with the reload already in force, the pod clock reading APPLIED_AT + delta. */
function awaitAfter(delta: number): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "nats-auth-drill-deadline-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    stub(join(bin, "date"), [`echo ${APPLIED_AT + delta}`]);
    stub(join(bin, "nats"), [
      'case "$*" in',
      '*/verify-next.nk*) echo "nats://nats:4222: 1.2ms" ;;',
      '*) echo "nats: error: nats: Authorization Violation" ;;',
      "esac",
    ]);
    const run = Bun.spawnSync(["sh", PROBES, "drill_await"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NATS_URL: "nats://nats:4222",
        SEEDS: dir,
        DRILL_ACCEPT: "verify-next",
        DRILL_REFUSE: "verify",
        DRILL_APPLIED_AT: String(APPLIED_AT),
      },
    });
    return {
      code: run.exitCode ?? -1,
      output: `${run.stdout.toString()}${run.stderr.toString()}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a whole-second delta of 179 passes, because real elapsed time is then under 180s", () => {
  const run = awaitAfter(179);
  assertEquals(run.code, 0, run.output);
  assertStringIncludes(run.output, "PASS rotation_and_revocation_drill");
  assertStringIncludes(run.output, "in force under 180s (wall clock)");
});

test("a whole-second delta of 180 fails, because real elapsed time can be up to 180.999s", () => {
  const run = awaitAfter(180);
  assertEquals(run.code, 1, run.output);
  assertStringIncludes(run.output, "FAIL rotation_and_revocation_drill");
  assertStringIncludes(run.output, "at least 180s elapsed");
});
