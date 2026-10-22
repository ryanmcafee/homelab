#!/usr/bin/env -S bun test
import { test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertEquals } from "./lib/assert.ts";

type WorkflowStep = {
  id?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  steps: WorkflowStep[];
  permissions?: Record<string, string>;
};
const workflow = Bun.YAML.parse(
  await Bun.file(`${import.meta.dir}/../.github/workflows/tilt-ci.yml`).text(),
) as { jobs: Record<string, WorkflowJob> };
const classifyStep = workflow.jobs["changed-paths"].steps.find(
  (step) => step.id === "classify",
);
const command = classifyStep?.run ?? "";

function classify(
  files: { filename: string; previous_filename?: string }[],
  total = files.length,
): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "level2-paths-"));
  try {
    writeFileSync(
      join(dir, "fake_gh"),
      '#!/bin/sh\ncase "$*" in *--jq*) printf "%s\\n" "$GH_TOTAL";; *) printf "%s\\n" "$GH_FILES";; esac\n',
      { mode: 0o755 },
    );
    const mockedCommand = command.replaceAll("gh api", `${dir}/fake_gh api`);
    const result = Bun.spawnSync(
      ["bash", "-e", "-o", "pipefail", "-c", mockedCommand],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "base/repo",
          PR_NUMBER: "1",
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: join(dir, "output"),
          GH_TOTAL: String(total),
          GH_FILES: JSON.stringify(files),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: result.exitCode,
      output:
        result.exitCode === 0
          ? readFileSync(join(dir, "output"), "utf8").trim()
          : result.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("docs-only and unrelated workflow changes skip level 2", () => {
  assertEquals(classify([{ filename: "docs/guide.md" }]), {
    code: 0,
    output: "relevant=false",
  });
  assertEquals(
    classify([{ filename: ".github/workflows/verify.yml" }]).output,
    "relevant=false",
  );
});

test("all former PR filter paths run level 2", () => {
  for (const filename of [
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
    assertEquals(classify([{ filename }]).output, "relevant=true");
  }
});

test("a renamed relevant path and a mixed PR run level 2", () => {
  assertEquals(
    classify([
      { filename: "docs/moved.md", previous_filename: "charts/old.yaml" },
    ]).output,
    "relevant=true",
  );
  assertEquals(
    classify([{ filename: "docs/a.md" }, { filename: "charts/a.yaml" }]).output,
    "relevant=true",
  );
  assertEquals(
    classify([{ filename: "charts-old/a.yaml" }]).output,
    "relevant=false",
  );
});

test("a capped or incomplete API result runs level 2", () => {
  assertEquals(
    classify([{ filename: "docs/a.md" }], 3000).output,
    "relevant=true",
  );
  assertEquals(
    classify([{ filename: "docs/a.md" }], 2).output,
    "relevant=true",
  );
});

test("empty or invalid API metadata fails classification", () => {
  assertEquals(classify([]).code === 0, false);
  assertEquals(
    classify([{ filename: "docs/a.md" }], Number.NaN).code === 0,
    false,
  );
});

test("the classifier executes no PR checkout or script", () => {
  assertEquals(workflow.jobs["changed-paths"].steps.length, 1);
  assertEquals(
    workflow.jobs["kind-argocd"].permissions?.["pull-requests"],
    "read",
  );
  assertEquals(
    workflow.jobs["kind-argocd"].steps[0].with?.["persist-credentials"],
    false,
  );
});
