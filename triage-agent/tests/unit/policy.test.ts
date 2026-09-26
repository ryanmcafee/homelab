import { describe, expect, test } from "bun:test";
import {
  evaluateBash,
  evaluateToolUse,
  preToolUseHook,
  splitCommands,
} from "../../src/policy.ts";

const denied = (command: string) => evaluateBash(command).decision === "deny";

describe("splitCommands", () => {
  test("splits on shell separators and keeps quoted text together", () => {
    expect(
      splitCommands(`kubectl get pods -n "a b" && echo 'x;y' | jq . ; ls`),
    ).toEqual([
      ["kubectl", "get", "pods", "-n", "a b"],
      ["echo", "x;y"],
      ["jq", "."],
      ["ls"],
    ]);
  });

  test("splits command substitutions into their own commands", () => {
    expect(splitCommands("echo $(kubectl delete pod x)")).toContainEqual([
      "kubectl",
      "delete",
      "pod",
      "x",
    ]);
  });
});

describe("evaluateBash: kubectl", () => {
  test.each([
    "kubectl get pods -A",
    "kubectl -n monitoring logs deploy/x --tail 50",
    "kubectl describe pod delete-me",
    "kubectl --context homelab exec -it pod -- amtool alert",
    "kubectl rollout status deploy/x",
    "kubectl rollout history deploy/x",
    "kubectl auth can-i create pods",
    "kubectl port-forward svc/x 9090",
    "kubectl top pods",
  ])("allows %s", (command) => {
    expect(denied(command)).toBe(false);
  });

  test.each([
    "kubectl apply -f x.yaml",
    "kubectl delete pod x",
    "kubectl -n foo patch deploy x -p '{}'",
    "kubectl --namespace foo edit cm x",
    "kubectl scale deploy x --replicas 0",
    "kubectl create configmap x",
    "kubectl replace -f x",
    "kubectl annotate pod x a=b",
    "kubectl label pod x a=b",
    "kubectl rollout restart deploy/x",
    "kubectl rollout undo deploy/x",
    "kubectl set image deploy/x c=y",
    "kubectl cordon worker-1",
    "kubectl drain worker-1",
    "kubectl taint nodes worker-1 k=v:NoSchedule",
    "kubectl cp file pod:/tmp",
    "/usr/local/bin/kubectl delete ns x",
    "env FOO=1 kubectl delete pod x",
    "timeout 10 kubectl delete pod x",
    "echo hi && kubectl delete pod x",
    "bash -c 'kubectl delete pod x'",
    'sh -c "kubectl -n a apply -f -"',
    "xargs kubectl delete pod",
    "kubectl exec pod -- kubectl delete pod y",
  ])("denies %s", (command) => {
    expect(denied(command)).toBe(true);
    expect(evaluateBash(command).reason).toMatch(/kubectl/);
  });
});

describe("evaluateBash: GitHub", () => {
  test.each([
    "gh pr merge 12",
    "gh pr merge --squash --auto",
    "gh -R o/r pr merge 1",
    "gh api -X PUT repos/o/r/pulls/1/merge",
    "gh api repos/o/r/pulls/1/merge --method PUT",
  ])("denies %s", (command) => {
    expect(denied(command)).toBe(true);
  });

  test.each([
    "gh pr create --title x --body y",
    "gh pr view 1",
    "gh pr checks 1",
    "gh run view 1 --log-failed",
  ])("allows %s", (command) => {
    expect(denied(command)).toBe(false);
  });
});

describe("evaluateBash: git", () => {
  test.each([
    "git push --force-with-lease origin triage/x",
    "git push --force origin triage/x",
    "git push -u origin HEAD:refs/heads/triage/x",
    "git push origin triage/main-fix",
  ])("allows %s", (command) => {
    expect(denied(command)).toBe(false);
  });

  test.each([
    "git push origin main",
    "git push origin HEAD:main",
    "git push --force origin +main",
    "git push origin HEAD:refs/heads/main",
    "git push origin master",
    "git push origin :main",
    "git push --mirror origin",
    "git push --all origin",
  ])("denies %s", (command) => {
    expect(denied(command)).toBe(true);
  });
});

describe("evaluateBash: Alertmanager and Prometheus", () => {
  test.each([
    "curl -s http://kube-prometheus-stack-alertmanager.monitoring.svc:9093/api/v2/alerts",
    "curl -sG http://prometheus-operated.monitoring.svc:9090/api/v1/query --data-urlencode 'query=up'",
    "curl -X GET http://localhost:9093/api/v2/silences",
    "curl -X POST https://api.github.com/repos/o/r/issues",
    "wget -qO- http://localhost:9090/api/v1/targets",
  ])("allows %s", (command) => {
    expect(denied(command)).toBe(false);
  });

  test.each([
    "curl -X POST http://kube-prometheus-stack-alertmanager.monitoring.svc:9093/api/v2/silences -d '{}'",
    "curl -XDELETE http://localhost:9093/api/v2/silence/abc",
    "curl --request PUT http://alertmanager:9093/api/v2/alerts",
    "curl -d @s.json http://localhost:9093/api/v2/silences",
    "curl --json '{}' http://am.monitoring.svc:9093/api/v2/silences",
    "curl -X POST http://prometheus-operated.monitoring.svc:9090/api/v1/admin/tsdb/delete_series",
    "curl -XPOST localhost:9090/-/quit",
    "wget --method=DELETE http://localhost:9093/api/v2/silence/x",
    "wget --post-data='{}' http://prometheus:9090/api/v1/admin/tsdb/snapshot",
    "kubectl exec am-0 -- amtool silence add alertname=x",
    "kubectl exec am-0 -- amtool --alertmanager.url=http://localhost:9093 silence expire abc",
  ])("denies %s", (command) => {
    expect(denied(command)).toBe(true);
  });
});

describe("evaluateToolUse", () => {
  const ctx = { writableRoots: ["/work"] };

  test("checks Bash commands", () => {
    expect(
      evaluateToolUse("Bash", { command: "kubectl delete pod x" }, ctx)
        .decision,
    ).toBe("deny");
    expect(
      evaluateToolUse("Bash", { command: "kubectl get pods" }, ctx).decision,
    ).toBe("allow");
  });

  test("limits Edit and Write to the writable roots", () => {
    expect(
      evaluateToolUse("Edit", { file_path: "/work/repo/charts/x.yaml" }, ctx)
        .decision,
    ).toBe("allow");
    expect(
      evaluateToolUse("Write", { file_path: "/etc/passwd" }, ctx).decision,
    ).toBe("deny");
    expect(
      evaluateToolUse("Write", { file_path: "/work/../etc/passwd" }, ctx)
        .decision,
    ).toBe("deny");
    expect(
      evaluateToolUse("NotebookEdit", { notebook_path: "/work/a.ipynb" }, ctx)
        .decision,
    ).toBe("allow");
  });

  test("denies malformed input for guarded tools", () => {
    expect(evaluateToolUse("Bash", {}, ctx).decision).toBe("deny");
    expect(evaluateToolUse("Write", null, ctx).decision).toBe("deny");
  });

  test("leaves other tools to the permission mode", () => {
    expect(evaluateToolUse("Read", { file_path: "/etc/x" }, ctx).decision).toBe(
      "allow",
    );
  });
});

describe("preToolUseHook", () => {
  test("returns a deny decision with the reason", async () => {
    const hook = preToolUseHook({ writableRoots: ["/work"] });
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "gh pr merge 1" },
        tool_use_id: "t1",
        session_id: "s",
        transcript_path: "/tmp/t",
        cwd: "/work/repo",
      },
      "t1",
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  test("returns nothing for an allowed call", async () => {
    const hook = preToolUseHook({ writableRoots: ["/work"] });
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "kubectl get pods" },
        tool_use_id: "t1",
        session_id: "s",
        transcript_path: "/tmp/t",
        cwd: "/work/repo",
      },
      "t1",
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({});
  });
});
