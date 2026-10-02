import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const workflow = readFileSync(
  new URL("../.github/workflows/upgrade.yml", import.meta.url),
  "utf8",
);

test("revalidation report projection strips synthetic diagnostics and fails closed", () => {
  // Execute the actual workflow boundary, with all publishing steps excluded.
  const projection = workflow.match(/ {10}if ! jq -s -e '[\s\S]*? {10}fi/)?.[0];
  expect(projection).toBeDefined();
  const markdown = workflow.match(
    / {10}\{\n {12}echo\n[\s\S]*? {10}\} >> upgrade-report\.md/,
  )?.[0];
  expect(markdown).toBeDefined();
  const sentinel = "SYNTHETIC_REVALIDATION_SENTINEL";
  const dir = mkdtempSync(join(tmpdir(), "upgrade-report-sinks-"));
  try {
    for (const [caseIndex, raw] of [
      JSON.stringify({
        level: 0,
        pass: true,
        duration_ms: 1,
        checks: [{ name: "render/test/chart", status: "pass", duration_ms: 1 }],
      }),
      ...["name", "status", "duration_ms"].map((field) =>
        JSON.stringify({
          level: 0,
          pass: false,
          duration_ms: 1,
          checks: [
            {
              name: "render/test/chart",
              status: "fail",
              duration_ms: 1,
              [field]: sentinel,
            },
          ],
        }),
      ),
      ...["level", "pass", "duration_ms"].map((field) =>
        JSON.stringify({
          level: 0,
          pass: false,
          duration_ms: 1,
          checks: [],
          [field]: sentinel,
        }),
      ),
      JSON.stringify({
        level: 0,
        pass: false,
        duration_ms: 1,
        checks: [
          {
            name: "render/test/chart",
            status: "fail",
            duration_ms: 1,
            detail: sentinel,
            findings: [sentinel],
            data: { password: sentinel },
          },
        ],
        unexpected: sentinel,
      }),
      `invalid JSON ${sentinel}`,
      JSON.stringify({ pass: true, checks: [null, sentinel] }),
    ].entries()) {
      writeFileSync(join(dir, "revalidate.raw.json"), raw);
      writeFileSync(join(dir, "upgrade-report.md"), "");
      writeFileSync(join(dir, "summary.md"), "");
      const run = spawnSync(
        "bash",
        [
          "-c",
          `ok=true\n${projection}\n${markdown}\nhead -c 900000 upgrade-report.md >> "$GITHUB_STEP_SUMMARY"\nprintf '%s' "$ok"`,
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md") },
        },
      );
      expect(run.status).toBe(0);
      const safe = readFileSync(join(dir, "revalidate.json"), "utf8");
      expect(safe).not.toContain(sentinel);
      expect(
        readFileSync(join(dir, "upgrade-report.md"), "utf8"),
      ).not.toContain(sentinel);
      expect(readFileSync(join(dir, "summary.md"), "utf8")).not.toContain(
        sentinel,
      );
      expect(run.stdout + run.stderr).not.toContain(sentinel);
      const parsed = JSON.parse(safe);
      if (caseIndex === 0) {
        expect(parsed).toEqual({
          level: 0,
          pass: true,
          duration_ms: 1,
          checks: [
            {
              name: "render-check-0",
              status: "pass",
              duration_ms: 1,
              detail:
                "Diagnostics omitted for Secret safety; reproduce locally with synthetic values",
            },
          ],
        });
      } else {
        expect(parsed.pass).toBe(false);
      }
      if (!raw.startsWith('{"level"')) {
        expect(run.stdout).toBe("false");
        expect(parsed.checks).toEqual([]);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summary, sticky comment and artifact sinks use only report outputs", () => {
  expect(workflow).toContain(
    'head -c 900000 upgrade-report.md >> "$GITHUB_STEP_SUMMARY"',
  );
  expect(workflow).toContain("path: upgrade-report.md");
  const artifactPaths = workflow.match(
    /name: upgrade-report\n {10}path: \|\n([\s\S]*?) {10}if-no-files-found:/,
  )?.[1];
  expect(artifactPaths?.trim().split(/\s+/)).toEqual([
    "upgrade-report.md",
    "upgrade.json",
    "revalidate.json",
    // The undeclared-values gate's report (#483): key paths read from the committed
    // snapshots, never a value, so it carries nothing a Secret could leak through.
    "values.json",
  ]);
});
