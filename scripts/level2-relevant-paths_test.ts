#!/usr/bin/env -S bun test
import { test } from "bun:test";
import { assertEquals } from "./lib/assert.ts";

const script = `${import.meta.dir}/level2-relevant-paths.sh`;

function classify(files: string[]): { code: number; output: string } {
  const result = Bun.spawnSync(["bash", script], {
    stdin: new TextEncoder().encode(
      files.join("\n") + (files.length ? "\n" : ""),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, output: result.stdout.toString().trim() };
}

test("a docs-only or unrelated workflow PR skips level 2", () => {
  assertEquals(classify(["docs/runbooks/verification.md"]).output, "false");
  assertEquals(classify([".github/workflows/verify.yml"]).output, "false");
});

test("every current pull-request filter path runs level 2", () => {
  for (const path of [
    "charts/app/values.yaml",
    "localdev/foo.yaml",
    "Tiltfile",
    "scripts/check.ts",
    "configuration/versions.yaml",
    "tests/e2e/check.yaml",
    "tests/health/check.yaml",
    "Taskfile.yml",
    "cmd/verify/main.go",
    "internal/verify/check.go",
    "go.mod",
    "go.sum",
    "mise.toml",
    "package.json",
    "bun.lock",
    "tsconfig.json",
    "biome.json",
    ".github/workflows/tilt-ci.yml",
  ]) {
    assertEquals(classify([path]), { code: 0, output: "true" });
  }
});

test("a mixed PR runs level 2 and path prefixes do not overmatch", () => {
  assertEquals(classify(["docs/a.md", "charts/a.yaml"]).output, "true");
  assertEquals(classify(["charts-old/a.yaml"]).output, "false");
});

test("an empty API result fails instead of silently skipping", () => {
  assertEquals(classify([]).code, 1);
});
