import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

type Pull = {
  number: number;
  draft: boolean;
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
  labels: Array<{ name: string }>;
};

const workflow = load(
  readFileSync(
    new URL("../.github/workflows/pr-dependency-triage.yml", import.meta.url),
    "utf8",
  ),
) as { jobs: { classify: { steps: Array<{ with: { script: string } }> } } };
const script = workflow.jobs.classify.steps[0].with.script;
const AsyncFunction = (async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;
const run = new AsyncFunction("github", "context", "core", script);

function pull(
  number: number,
  head: string,
  base: string,
  repo = "owner/repo",
  draft = false,
): Pull {
  return {
    number,
    draft,
    base: { ref: base },
    head: { ref: head, repo: { full_name: repo } },
    labels: [],
  };
}

function harness(pulls: Pull[], writeError?: Error) {
  const writes: Array<{ issue_number: number; labels: string[] }> = [];
  const github = {
    rest: {
      issues: {
        getLabel: async () => ({}),
        createLabel: async () => ({}),
        setLabels: async (args: { issue_number: number; labels: string[] }) => {
          if (writeError) throw writeError;
          writes.push(args);
        },
      },
      repos: { get: async () => ({ data: { default_branch: "main" } }) },
      pulls: { list: async () => pulls },
    },
    paginate: async () => pulls,
  };
  const summary = {
    addHeading: () => summary,
    addRaw: () => summary,
    write: async () => {},
  };
  const core = { info: () => {}, summary };
  return {
    writes,
    execute: () =>
      run(github, { repo: { owner: "owner", repo: "repo" } }, core),
  };
}

describe("PR dependency triage workflow", () => {
  test("classifies root, blocked child, orphan and fork PRs", async () => {
    const subject = harness([
      pull(1, "feature/root", "main"),
      pull(2, "feature/child", "feature/root"),
      pull(3, "feature/orphan", "missing-parent"),
      pull(4, "feature/fork", "main", "other/repo"),
    ]);
    await subject.execute();
    expect(subject.writes).toEqual([
      expect.objectContaining({
        issue_number: 1,
        labels: ["review/ready", "stack/root"],
      }),
      expect.objectContaining({ issue_number: 2, labels: ["stack/blocked"] }),
      expect.objectContaining({
        issue_number: 3,
        labels: ["dependency/orphan"],
      }),
      expect.objectContaining({ issue_number: 4, labels: ["review/ready"] }),
    ]);
  });

  test("fails loudly when GitHub denies a required label write", async () => {
    const denied = Object.assign(
      new Error("Resource not accessible by integration"),
      {
        status: 403,
      },
    );
    const subject = harness([pull(1, "feature/root", "main")], denied);
    await expect(subject.execute()).rejects.toThrow(
      "Resource not accessible by integration",
    );
    expect(subject.writes).toEqual([]);
  });
});
