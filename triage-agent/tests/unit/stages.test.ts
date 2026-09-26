import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, QueryFn } from "../../src/llm.ts";
import { fakeQuery } from "../../src/llm.ts";
import {
  implementStage,
  planStage,
  triageStage,
} from "../../src/stages/agent.ts";
import {
  type Check,
  ciWatchStage,
  classifyChecks,
  runIdsOf,
} from "../../src/stages/ci.ts";
import { cleanupStage } from "../../src/stages/cleanup.ts";
import { readStageConfig } from "../../src/stages/context.ts";
import {
  commitStage,
  commitSubject,
  needsHumanStage,
  prBody,
  prNumberFromUrl,
  prStage,
} from "../../src/stages/github.ts";
import { isStageName, runStage } from "../../src/stages/index.ts";
import { loopDecision } from "../../src/stages/loop.ts";
import {
  argocdSyncStage,
  buildNotification,
  notifyStage,
} from "../../src/stages/notify.ts";
import { verifyStage, verifySteps } from "../../src/stages/verify.ts";
import { goodPlan, group, triage } from "./fixtures.ts";
import {
  commitAll,
  fakeExec,
  git,
  makeRepo,
  realExec,
  tempRoot,
} from "./helpers.ts";
import { gitOnly, stageDeps, writeEtc } from "./stage-helpers.ts";

const { root, cleanup } = tempRoot("stages-");
afterAll(cleanup);

let n = 0;
const fresh = () => join(root, `case-${++n}`);

/** A work dir whose repo is a clone of a fresh local upstream. */
async function withClone(caseRoot: string) {
  const upstream = await makeRepo(caseRoot, "upstream", {
    "charts/x/values.yaml": "a: 1\n",
    ".mcp.json": JSON.stringify({ mcpServers: { serena: { command: "uvx" } } }),
  });
  const repo = join(caseRoot, "work", "repo");
  await realExec(["git", "clone", "-q", `file://${upstream}`, repo]);
  await git(repo, "config", "user.name", "t");
  await git(repo, "config", "user.email", "t@example.invalid");
  return { upstream, repo };
}

describe("loopDecision", () => {
  test("bounds the fix loop", () => {
    expect(loopDecision(true, 1, 3)).toBe("done");
    expect(loopDecision(false, 1, 3)).toBe("retry");
    expect(loopDecision(false, 2, 3)).toBe("retry");
    expect(loopDecision(false, 3, 3)).toBe("exhausted");
    expect(loopDecision(false, 5, 3)).toBe("exhausted");
    expect(loopDecision(true, 3, 3)).toBe("done");
  });
});

describe("readStageConfig", () => {
  test("rejects a branch outside triage/ and a bad repo slug", () => {
    const base = { REPO_URL: "https://x", REPO_SLUG: "o/r" };
    expect(() => readStageConfig({ ...base, BRANCH: "main" })).toThrow(
      /BRANCH/,
    );
    expect(() => readStageConfig({ ...base, REPO_SLUG: "nope" })).toThrow(
      /REPO_SLUG/,
    );
    expect(
      readStageConfig({ ...base, TRIAGE_AGENT_FAKE_LLM: "1" }),
    ).toMatchObject({
      TRIAGE_AGENT_FAKE_LLM: true,
      ATTEMPT: 1,
      MAX_ATTEMPTS: 3,
      FEEDBACK: "none",
      GIT_USER_NAME: "homelab-triage-agent",
    });
  });

  test("runStage clears the outputs of the previous stage", async () => {
    const deps = stageDeps({
      root: fresh(),
      env: { ARGOCD_APP: "plex" },
      exec: fakeExec().run,
    });
    deps.work.output("next", "retry");
    await runStage("argocd-sync", deps);
    expect(deps.work.has("out/next")).toBe(false);
  });

  test("knows every stage name", () => {
    expect(isStageName("verify")).toBe(true);
    expect(isStageName("toString")).toBe(false);
  });
});

describe("LLM stages", () => {
  function recordingQuery(answer: AgentMessage, seen: unknown[]): QueryFn {
    return async function* (params) {
      seen.push(params);
      yield answer;
    };
  }

  test("triage writes triage.json and out/actionable", async () => {
    const caseRoot = fresh();
    const { upstream } = await withClone(caseRoot);
    const seen: unknown[] = [];
    const { run } = fakeExec();
    const deps = stageDeps({
      root: caseRoot,
      env: { ...writeEtc(caseRoot), REPO_URL: `file://${upstream}` },
      exec: gitOnly(run),
      query: () =>
        recordingQuery(
          {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "done",
            structured_output: triage,
          },
          seen,
        ),
    });
    await triageStage(deps);
    expect(deps.work.readJson("triage.json")).toEqual(triage);
    expect(deps.work.read("out/actionable")).toBe("true");
    const options = JSON.stringify(seen[0]);
    expect(options).toContain('"json_schema"');
    expect(options).toContain('"context7"');
    expect(options).not.toContain('"serena"');
  });

  test("triage fails without an OAuth token unless the LLM is faked", async () => {
    const caseRoot = fresh();
    const { upstream } = await withClone(caseRoot);
    const env = { ...writeEtc(caseRoot), REPO_URL: `file://${upstream}` };
    const noToken = stageDeps({
      root: caseRoot,
      env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "" },
      exec: gitOnly(fakeExec().run),
      query: fakeQuery,
    });
    await expect(triageStage(noToken)).rejects.toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN/,
    );

    const faked = stageDeps({
      root: caseRoot,
      env: {
        ...env,
        CLAUDE_CODE_OAUTH_TOKEN: "",
        TRIAGE_AGENT_FAKE_LLM: "true",
      },
      exec: gitOnly(fakeExec().run),
      query: fakeQuery,
    });
    await triageStage(faked);
    expect(faked.work.read("out/actionable")).toBe("false");
  });

  test("plan keeps a valid plan and rejects an incomplete one", async () => {
    const caseRoot = fresh();
    await withClone(caseRoot);
    const answer = (result: string): QueryFn =>
      recordingQuery(
        { type: "result", subtype: "success", is_error: false, result },
        [],
      );
    const deps = stageDeps({
      root: caseRoot,
      env: writeEtc(caseRoot),
      exec: gitOnly(fakeExec().run),
      query: () => answer(goodPlan),
    });
    deps.work.writeJson("triage.json", triage);
    await planStage(deps);
    expect(deps.work.read("plan.md")).toBe(goodPlan);

    const bad = stageDeps({
      root: caseRoot,
      env: writeEtc(caseRoot),
      exec: gitOnly(fakeExec().run),
      query: () => answer("just do it"),
    });
    await expect(planStage(bad)).rejects.toThrow(/plan rejected/);
  });

  test("implement cuts the branch on the first attempt and feeds logs back later", async () => {
    const caseRoot = fresh();
    const { repo } = await withClone(caseRoot);
    const seen: { prompt: string }[] = [];
    const query: QueryFn = async function* (params) {
      seen.push(params);
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "edited",
      };
    };
    const first = stageDeps({
      root: caseRoot,
      env: writeEtc(caseRoot),
      exec: gitOnly(fakeExec().run),
      query: () => query,
    });
    first.work.writeJson("triage.json", triage);
    first.work.write("plan.md", goodPlan);
    await implementStage(first);
    expect((await git(repo, "branch", "--show-current")).trim()).toBe(
      "triage/kubepodcrashlooping-12345678",
    );
    expect(seen[0]?.prompt).toContain("attempt 1 of 3");

    first.work.write(
      "verify.log",
      "$ task verify:text\nFAIL snapshot\n[exit 1]",
    );
    const second = stageDeps({
      root: caseRoot,
      env: { ...writeEtc(caseRoot), ATTEMPT: "2", FEEDBACK: "verify" },
      exec: gitOnly(fakeExec().run),
      query: () => query,
    });
    await implementStage(second);
    expect(seen[1]?.prompt).toContain("FAIL snapshot");
    expect(second.work.has("implement-verify-2.md")).toBe(true);
  });
});

describe("verify", () => {
  test("verifySteps picks regenerators and checks from the changed files", () => {
    const names = (files: string[]) => verifySteps(files).map((s) => s.name);
    expect(names(["docs/x.md"])).toEqual([
      "docs counts",
      "level 0",
      "PII guard",
    ]);
    expect(names(["charts/x/values.yaml"])).toEqual([
      "golden snapshots",
      "docs counts",
      "level 0",
      "PII guard",
    ]);
    expect(names(["configuration/versions.yaml"])).toContain("localdev values");
    expect(names(["scripts/a.ts"])).toContain("scripts tests");
    expect(names(["triage-agent/src/a.ts"])).toContain("triage-agent tests");
    expect(names(["internal/x/y.go"])).toContain("go tests");
    expect(names(["tests/policy/a.rego"])).toContain("policy tests");
    expect(verifySteps(["charts/a"])[0]?.kind).toBe("regenerate");
  });

  test("records failed checks, the log and the loop decision", async () => {
    const caseRoot = fresh();
    const { repo } = await withClone(caseRoot);
    writeFileSync(join(repo, "charts/x/values.yaml"), "a: 2\n");
    const { run, calls } = fakeExec({
      "mise exec -- task verify:text": {
        code: 1,
        stdout: "FAIL snapshot/homelab/x",
      },
    });
    const deps = stageDeps({
      root: caseRoot,
      env: { ATTEMPT: "3", MAX_ATTEMPTS: "3" },
      exec: gitOnly(run),
    });
    const result = await verifyStage(deps);
    expect(result).toMatchObject({
      passed: false,
      next: "exhausted",
      failed: ["level 0"],
      files: ["charts/x/values.yaml"],
    });
    expect(existsSync(join(repo, ".envrc"))).toBe(true);
    expect(calls[0]).toContain("mise trust --yes");
    expect(calls[1]).toBe(
      "mise install go helm bun kubeconform conftest pluto task yq",
    );
    expect(calls).toContain("mise exec -- task test:snapshot -- --update");
    expect(deps.work.read("verify.log")).toContain("FAIL snapshot/homelab/x");
    expect(deps.work.read("out/passed")).toBe("false");
    expect(deps.work.read("out/next")).toBe("exhausted");
  });

  test("passes when every step exits 0", async () => {
    const caseRoot = fresh();
    await withClone(caseRoot);
    const deps = stageDeps({ root: caseRoot, exec: gitOnly(fakeExec().run) });
    const result = await verifyStage(deps);
    expect(result.passed).toBe(true);
    expect(result.next).toBe("done");
  });

  test("an unavailable toolchain is an error, not a verdict", async () => {
    const caseRoot = fresh();
    await withClone(caseRoot);
    const deps = stageDeps({
      root: caseRoot,
      exec: gitOnly(fakeExec({ "mise install": { code: 1 } }).run),
    });
    await expect(verifyStage(deps)).rejects.toThrow(/mise install/);
  });
});

describe("commit", () => {
  test("commitSubject uses the plan, then a fallback, and a CI subject", () => {
    expect(commitSubject(goodPlan, group, "none")).toBe(
      "fix(paperclip): raise the memory limit above the working set",
    );
    expect(commitSubject(undefined, group, "verify")).toBe(
      "fix(kubepodcrashlooping): resolve KubePodCrashLooping",
    );
    expect(commitSubject(goodPlan, group, "ci")).toContain("CI failure");
  });

  test("commits every change with the plan's message, or reports none", async () => {
    const caseRoot = fresh();
    const { repo } = await withClone(caseRoot);
    const deps = stageDeps({ root: caseRoot, exec: gitOnly(fakeExec().run) });
    deps.work.write("plan.md", goodPlan);

    expect(await commitStage(deps)).toBe(false);
    expect(deps.work.read("out/changed")).toBe("false");

    writeFileSync(join(repo, "charts/x/values.yaml"), "a: 3\n");
    expect(await commitStage(deps)).toBe(true);
    const message = await git(repo, "log", "-1", "--format=%B");
    expect(message).toContain(
      "fix(paperclip): raise the memory limit above the working set",
    );
    expect(message).toContain("Workflow: triage-kubepodcrashlooping-abcde");
    expect(message).not.toMatch(/claude|co-authored/i);
  });
});

describe("pull request", () => {
  test("prBody keeps the why short and folds the report and plan", () => {
    const body = prBody({
      group,
      triage,
      plan: goodPlan,
      workflow: "wf-1",
      verifyPassed: true,
    });
    const intro = body.split("<details>")[0] ?? "";
    expect(intro.split(/\s+/).filter(Boolean).length).toBeLessThan(130);
    expect(body).toContain("<summary>Triage report</summary>");
    expect(body).toContain("memory limit too low");
    expect(body).toContain("## Commit message");
    expect(body).not.toContain("Draft");
    expect(
      prBody({
        group,
        triage,
        plan: goodPlan,
        workflow: "w",
        verifyPassed: false,
      }),
    ).toContain("Draft");
  });

  test("prNumberFromUrl", () => {
    expect(prNumberFromUrl("https://github.com/o/r/pull/42\n")).toBe(42);
    expect(() => prNumberFromUrl("oops")).toThrow();
  });

  async function prCase(verifyPassed: boolean, openPrs: string) {
    const caseRoot = fresh();
    const { repo } = await withClone(caseRoot);
    await git(
      repo,
      "switch",
      "-q",
      "--no-track",
      "-c",
      "triage/kubepodcrashlooping-12345678",
    );
    writeFileSync(join(repo, "charts/x/values.yaml"), "a: 9\n");
    await commitAll(repo, "fix(x): y");
    const fake = fakeExec({
      "gh pr list": { stdout: openPrs },
      "gh pr create": {
        stdout: "https://github.com/example/homelab/pull/77\n",
      },
    });
    const deps = stageDeps({ root: caseRoot, exec: gitOnly(fake.run) });
    deps.work.writeJson("triage.json", triage);
    deps.work.write("plan.md", goodPlan);
    deps.work.writeJson("verify.json", { passed: verifyPassed });
    return { deps, calls: fake.calls, repo, caseRoot };
  }

  test("pushes with lease and opens a PR when none is open", async () => {
    const { deps, calls, caseRoot } = await prCase(true, "[]");
    const record = await prStage(deps);
    expect(record).toEqual({
      number: 77,
      url: "https://github.com/example/homelab/pull/77",
      draft: false,
      created: true,
      needsHuman: false,
    });
    const upstreamBranch = await git(
      join(caseRoot, "upstream"),
      "log",
      "-1",
      "--format=%s",
      "triage/kubepodcrashlooping-12345678",
    );
    expect(upstreamBranch.trim()).toBe("fix(x): y");
    const create = calls.find((c) => c.startsWith("gh pr create")) ?? "";
    expect(create).toContain("--repo example/homelab");
    expect(create).toContain("--head triage/kubepodcrashlooping-12345678");
    expect(create).toContain("--label triage-agent");
    expect(create).not.toContain("--draft");
    expect(calls.some((c) => c.includes("merge"))).toBe(false);
    expect(deps.work.read("out/pr-number")).toBe("77");
  });

  test("updates the open PR of the branch instead of opening another", async () => {
    const { deps, calls } = await prCase(
      true,
      '[{"number":12,"url":"https://github.com/example/homelab/pull/12","isDraft":false}]',
    );
    const record = await prStage(deps);
    expect(record.number).toBe(12);
    expect(record.created).toBe(false);
    expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(false);
    expect(calls.some((c) => c.startsWith("gh pr edit 12"))).toBe(true);
  });

  test("opens a draft labelled needs-human when verify never passed", async () => {
    const { deps, calls } = await prCase(false, "[]");
    const record = await prStage(deps);
    expect(record).toMatchObject({ draft: true, needsHuman: true });
    expect(calls.find((c) => c.startsWith("gh pr create"))).toContain(
      "--draft",
    );
    expect(calls).toContain(
      "gh pr edit 77 --repo example/homelab --add-label triage-agent/needs-human",
    );
  });

  test("a second push after a force push elsewhere is refused by the lease", async () => {
    const { deps, caseRoot } = await prCase(true, "[]");
    await prStage(deps);
    const upstream = join(caseRoot, "upstream");
    await git(upstream, "switch", "-q", "triage/kubepodcrashlooping-12345678");
    writeFileSync(join(upstream, "other.txt"), "x\n");
    await commitAll(upstream, "someone else");
    await git(upstream, "switch", "-q", "main");
    await expect(prStage(deps)).rejects.toThrow(/git push failed/);
  });

  test("refuses to push without a GitHub token", async () => {
    const caseRoot = fresh();
    const deps = stageDeps({
      root: caseRoot,
      env: { GITHUB_TOKEN: "" },
      exec: fakeExec().run,
    });
    await expect(prStage(deps)).rejects.toThrow(/GITHUB_TOKEN/);
  });

  test("needs-human turns the PR into a labelled draft", async () => {
    const caseRoot = fresh();
    const fake = fakeExec();
    const deps = stageDeps({ root: caseRoot, exec: fake.run });
    deps.work.writeJson("pr.json", {
      number: 5,
      url: "u",
      draft: false,
      created: true,
      needsHuman: false,
    });
    await needsHumanStage(deps);
    expect(fake.calls).toContain("gh pr ready 5 --repo example/homelab --undo");
    expect(deps.work.readJson("pr.json")).toMatchObject({
      draft: true,
      needsHuman: true,
    });
  });
});

describe("ci-watch", () => {
  const check = (name: string, bucket: string, link = ""): Check => ({
    name,
    bucket,
    link,
  });

  test("classifyChecks and runIdsOf", () => {
    expect(classifyChecks([check("a", "pass"), check("b", "skipping")])).toBe(
      "green",
    );
    expect(classifyChecks([check("a", "pass"), check("b", "pending")])).toBe(
      "pending",
    );
    expect(classifyChecks([check("a", "fail"), check("b", "pending")])).toBe(
      "red",
    );
    expect(classifyChecks([])).toBe("green");
    expect(
      runIdsOf([
        check("a", "fail", "https://github.com/o/r/actions/runs/11/job/1"),
        check("b", "fail", "https://github.com/o/r/actions/runs/11/job/2"),
        check("c", "pass", "https://github.com/o/r/actions/runs/12/job/3"),
      ]),
    ).toEqual(["11"]);
  });

  function ciDeps(responses: string[], env: Record<string, string> = {}) {
    const caseRoot = fresh();
    let i = 0;
    let clock = 0;
    const calls: string[] = [];
    const deps = stageDeps({
      root: caseRoot,
      env,
      exec: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[1] === "run")
          return { code: 0, stdout: "Error: snapshot drift", stderr: "" };
        const stdout = responses[Math.min(i++, responses.length - 1)] ?? "[]";
        return { code: 8, stdout, stderr: "" };
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    deps.work.writeJson("pr.json", {
      number: 77,
      url: "u",
      draft: false,
      created: true,
      needsHuman: false,
    });
    return { deps, calls };
  }

  test("waits for pending checks, then reports red with the failing logs", async () => {
    const { deps, calls } = ciDeps([
      '[{"name":"level 0","bucket":"pending","link":""}]',
      '[{"name":"level 0","bucket":"fail","link":"https://github.com/o/r/actions/runs/99/job/1"}]',
    ]);
    expect(await ciWatchStage(deps)).toBe("red");
    expect(calls).toContain(
      "gh run view 99 --repo example/homelab --log-failed",
    );
    expect(deps.work.read("ci.log")).toContain("snapshot drift");
    expect(deps.work.read("out/next")).toBe("retry");
  });

  test("green ends the loop", async () => {
    const { deps } = ciDeps(['[{"name":"a","bucket":"pass","link":""}]']);
    expect(await ciWatchStage(deps)).toBe("green");
    expect(deps.work.read("out/next")).toBe("done");
  });

  test("a red PR on the last attempt is exhausted", async () => {
    const { deps } = ciDeps(['[{"name":"a","bucket":"fail","link":""}]'], {
      ATTEMPT: "2",
      MAX_ATTEMPTS: "2",
    });
    await ciWatchStage(deps);
    expect(deps.work.read("out/next")).toBe("exhausted");
  });

  test("checks that never settle time out", async () => {
    const { deps } = ciDeps(['[{"name":"a","bucket":"pending","link":""}]'], {
      CI_TIMEOUT_SECONDS: "120",
    });
    expect(await ciWatchStage(deps)).toBe("timeout");
    expect(deps.work.read("out/next")).toBe("exhausted");
  });
});

describe("notify", () => {
  const base = {
    alertname: "PlexDown",
    namespace: "plex",
    workflow: "wf-1",
    workflowStatus: "Succeeded",
    failures: "",
  };
  const pr = {
    number: 7,
    url: "https://x/pull/7",
    draft: false,
    created: true,
    needsHuman: false,
  };

  test("green PR, red PR, report only, failure and no change", () => {
    expect(
      buildNotification({ ...base, triage, pr, ciState: "green" }),
    ).toMatchObject({
      title: "Fix PR ready: PlexDown (plex)",
      url: "https://x/pull/7",
      priority: 0,
    });
    expect(
      buildNotification({
        ...base,
        triage,
        pr: { ...pr, needsHuman: true },
        ciState: "red",
      }).title,
    ).toBe("Fix PR needs you: PlexDown (plex)");
    const report = buildNotification({
      ...base,
      triage: { ...triage, actionable: false },
      workflowUrl: "https://wf/x",
    });
    expect(report.title).toBe("Triage report: PlexDown (plex)");
    expect(report.message).toContain("memory limit too low");
    expect(report.priority).toBe(-1);
    const failed = buildNotification({
      ...base,
      workflowStatus: "Failed",
      failures: '[{"displayName":"plan","message":"plan rejected"}]',
    });
    expect(failed.title).toBe("Triage workflow failed: PlexDown (plex)");
    expect(failed.message).toContain("plan: plan rejected");
    expect(buildNotification({ ...base, triage, changed: false }).title).toBe(
      "No fix produced: PlexDown (plex)",
    );
  });

  test("caps the message at Pushover's limit", () => {
    const long = buildNotification({
      ...base,
      triage: { ...triage, actionable: false, summary: "x".repeat(5000) },
    });
    expect(long.message.length).toBe(1024);
  });

  test("posts to Pushover when configured and only logs otherwise", async () => {
    const posted: string[] = [];
    const fakeFetch = async (_url: string, init: RequestInit) => {
      posted.push(String(init.body));
      return new Response("{}");
    };
    const caseRoot = fresh();
    const deps = stageDeps({
      root: caseRoot,
      env: {
        PUSHOVER_TOKEN: "app",
        PUSHOVER_USER_KEY: "user",
        WORKFLOW_STATUS: "Succeeded",
      },
      fetch: fakeFetch,
    });
    deps.work.writeJson("triage.json", triage);
    deps.work.writeJson("pr.json", pr);
    deps.work.writeJson("ci.json", { state: "green" });
    const note = await notifyStage(deps);
    expect(note.title).toContain("Fix PR ready");
    expect(posted[0]).toContain("token=app");
    expect(posted[0]).toContain("url=https%3A%2F%2Fx%2Fpull%2F7");

    const quiet = stageDeps({
      root: fresh(),
      env: { WORKFLOW_STATUS: "Error" },
    });
    expect((await notifyStage(quiet)).title).toContain("Triage workflow error");
  });
});

describe("argocd-sync", () => {
  test("syncs the named Application over grpc-web", async () => {
    const fake = fakeExec();
    const deps = stageDeps({
      root: fresh(),
      env: { ARGOCD_APP: "plex" },
      exec: fake.run,
    });
    await argocdSyncStage(deps);
    expect(fake.calls).toEqual(["argocd app sync plex --grpc-web"]);
  });
});

describe("cleanup", () => {
  test("removes the workspace of a succeeded workflow and keeps a failed one for the janitor", async () => {
    const done = stageDeps({
      root: fresh(),
      env: { WORKFLOW_STATUS: "Succeeded" },
    });
    done.work.writeJson("triage.json", triage);
    expect(await cleanupStage(done)).toBe(true);
    expect(existsSync(done.work.root)).toBe(false);

    const failed = stageDeps({
      root: fresh(),
      env: { WORKFLOW_STATUS: "Failed" },
    });
    failed.work.writeJson("triage.json", triage);
    expect(await cleanupStage(failed)).toBe(false);
    expect(failed.work.has("triage.json")).toBe(true);
  });

  test("is a registered stage", () => {
    expect(isStageName("cleanup")).toBe(true);
  });
});
