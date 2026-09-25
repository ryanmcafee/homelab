import { basename, resolve, sep } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/**
 * Hard limits on what the agent may run, enforced by a PreToolUse hook in
 * every permission mode. "allow" only means "no objection": the permission
 * mode and allow list still decide.
 */
export interface Verdict {
  decision: "allow" | "deny";
  reason?: string;
}

const ALLOW: Verdict = { decision: "allow" };
const deny = (reason: string): Verdict => ({ decision: "deny", reason });

const COMMAND_BREAK = new Set([";", "&", "|", "\n", "(", ")", "`"]);

/** Splits a shell command line into simple commands (token lists). */
export function splitCommands(line: string): string[][] {
  const commands: string[][] = [];
  let command: string[] = [];
  let token = "";
  let inToken = false;
  const endToken = () => {
    if (inToken) command.push(token);
    token = "";
    inToken = false;
  };
  const endCommand = () => {
    endToken();
    if (command.length > 0) commands.push(command);
    command = [];
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end === -1 ? line.length : end;
      token += line.slice(i + 1, stop);
      inToken = true;
      i = stop;
    } else if (c === '"') {
      inToken = true;
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && i + 1 < line.length) i++;
        token += line[i] ?? "";
      }
    } else if (c === "\\" && i + 1 < line.length) {
      token += line[++i] ?? "";
      inToken = true;
    } else if (c === "$" && line[i + 1] === "(") {
      endCommand();
      i++;
    } else if (COMMAND_BREAK.has(c)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endToken();
    } else {
      token += c;
      inToken = true;
    }
  }
  endCommand();
  return commands;
}

const WRAPPERS = new Set([
  "env",
  "sudo",
  "timeout",
  "nice",
  "nohup",
  "xargs",
  "command",
  "exec",
  "time",
  "watch",
  "stdbuf",
]);

function stripWrappers(tokens: readonly string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
    } else if (WRAPPERS.has(basename(t))) {
      i++;
      while (i < tokens.length && (tokens[i] ?? "").startsWith("-")) i++;
      if (basename(t) === "timeout" && /^\d/.test(tokens[i] ?? "")) i++;
    } else {
      break;
    }
  }
  return tokens.slice(i);
}

/** Positional arguments, skipping flags and the values of `valueFlags`. */
function positionals(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--") break;
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const KUBECTL_VALUE_FLAGS = new Set([
  "-n",
  "--namespace",
  "--context",
  "--kubeconfig",
  "--cluster",
  "--user",
  "-s",
  "--server",
  "--token",
  "--as",
  "--as-group",
  "-l",
  "--selector",
  "-o",
  "--output",
  "-c",
  "--container",
  "-f",
  "--filename",
  "--request-timeout",
]);

const KUBECTL_MUTATING = new Set([
  "apply",
  "create",
  "delete",
  "edit",
  "patch",
  "replace",
  "scale",
  "autoscale",
  "annotate",
  "label",
  "set",
  "cordon",
  "uncordon",
  "drain",
  "taint",
  "cp",
  "expose",
  "run",
  "debug",
  "certificate",
]);

const ROLLOUT_READ = new Set(["status", "history"]);

function checkKubectl(args: readonly string[], depth: number): Verdict {
  const [verb, sub] = positionals(args, KUBECTL_VALUE_FLAGS);
  if (verb && KUBECTL_MUTATING.has(verb)) {
    return deny(
      `kubectl ${verb} mutates the cluster; fixes land as GitOps PRs`,
    );
  }
  if (verb === "rollout" && !(sub && ROLLOUT_READ.has(sub))) {
    return deny(`kubectl rollout ${sub ?? ""} mutates the cluster`);
  }
  const dashDash = args.indexOf("--");
  if (verb === "exec" && dashDash !== -1) {
    return checkTokens(args.slice(dashDash + 1), depth + 1);
  }
  return ALLOW;
}

const GH_VALUE_FLAGS = new Set(["-R", "--repo", "-X", "--method"]);

function ghMethod(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-X" || a === "--method")
      return (args[i + 1] ?? "").toUpperCase();
    if (a.startsWith("--method=")) return a.slice(9).toUpperCase();
  }
  const hasFields = args.some((a) =>
    /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a),
  );
  return hasFields ? "POST" : "GET";
}

function checkGh(args: readonly string[]): Verdict {
  const [group, action] = positionals(args, GH_VALUE_FLAGS);
  if (group === "pr" && action === "merge") {
    return deny("gh pr merge: merging is for a human");
  }
  if (
    group === "api" &&
    args.some((a) => /\/merge\b/.test(a)) &&
    ghMethod(args) !== "GET"
  ) {
    return deny("merging a pull request through gh api is for a human");
  }
  return ALLOW;
}

const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);

function refspecTarget(refspec: string): string {
  const spec = refspec.replace(/^\+/, "");
  const colon = spec.indexOf(":");
  const target = colon === -1 ? spec : spec.slice(colon + 1);
  return target.replace(/^refs\/heads\//, "");
}

function checkGit(args: readonly string[]): Verdict {
  const [subcommand, ...rest] = positionals(args, GIT_GLOBAL_VALUE_FLAGS);
  if (subcommand !== "push") return ALLOW;
  if (args.includes("--mirror") || args.includes("--all")) {
    return deny("git push --mirror/--all would push the default branch");
  }
  const refspecs = rest.slice(1);
  const target = refspecs
    .map(refspecTarget)
    .find((t) => PROTECTED_BRANCHES.has(t));
  return target
    ? deny(`git push to ${target}: changes land through pull requests`)
    : ALLOW;
}

const MONITORING_URL = /alertmanager|prometheus|:9093\b|:9090\b/i;

function curlMethod(args: readonly string[]): string {
  let method = "";
  let sendsData = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--request") method = args[i + 1] ?? "";
    else if (a.startsWith("--request=")) method = a.slice(10);
    else if (/^-[A-Za-z]*X/.test(a) && !a.startsWith("--")) {
      const inline = a.slice(a.indexOf("X") + 1);
      method = inline || (args[i + 1] ?? "");
    } else if (
      /^(-d|--data|--data-raw|--data-binary|--data-ascii|--json|-F|--form|-T|--upload-file)(=|$)/.test(
        a,
      ) ||
      /^-d./.test(a)
    ) {
      sendsData = true;
    }
  }
  if (method) return method.toUpperCase();
  return sendsData ? "POST" : "GET";
}

function wgetMethod(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--method") return (args[i + 1] ?? "").toUpperCase();
    if (a.startsWith("--method=")) return a.slice(9).toUpperCase();
    if (/^--(post|body)-(data|file)(=|$)/.test(a)) return "POST";
  }
  return "GET";
}

function checkHttp(program: string, args: readonly string[]): Verdict {
  const method = program === "curl" ? curlMethod(args) : wgetMethod(args);
  if (method === "GET" || method === "HEAD") return ALLOW;
  if (!args.some((a) => MONITORING_URL.test(a))) return ALLOW;
  return deny(
    `${program} ${method} against Alertmanager/Prometheus would change monitoring state (silences, admin API)`,
  );
}

function checkAmtool(args: readonly string[]): Verdict {
  const words = positionals(args, new Set());
  const i = words.indexOf("silence");
  const action = i === -1 ? undefined : words[i + 1];
  return action && ["add", "expire", "import"].includes(action)
    ? deny(`amtool silence ${action} changes Alertmanager state`)
    : ALLOW;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const MAX_DEPTH = 4;

function checkTokens(tokens: readonly string[], depth: number): Verdict {
  if (depth > MAX_DEPTH) return deny("command nesting too deep to check");
  const nested = tokens.filter((t) => /[\s;&|`$()]/.test(t));
  for (const inner of nested) {
    const verdict = checkLine(inner, depth + 1);
    if (verdict.decision === "deny") return verdict;
  }
  const [program = "", ...args] = stripWrappers(tokens);
  const name = basename(program);
  switch (name) {
    case "kubectl":
      return checkKubectl(args, depth);
    case "gh":
      return checkGh(args);
    case "git":
      return checkGit(args);
    case "curl":
    case "wget":
      return checkHttp(name, args);
    case "amtool":
      return checkAmtool(args);
    default:
      if (SHELLS.has(name)) {
        const c = args.indexOf("-c");
        if (c !== -1) return checkLine(args[c + 1] ?? "", depth + 1);
      }
      return ALLOW;
  }
}

function checkLine(line: string, depth: number): Verdict {
  for (const command of splitCommands(line)) {
    const verdict = checkTokens(command, depth);
    if (verdict.decision === "deny") return verdict;
  }
  return ALLOW;
}

export function evaluateBash(command: string): Verdict {
  return checkLine(command, 0);
}

export interface PolicyContext {
  writableRoots: readonly string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function within(path: string, roots: readonly string[]): boolean {
  const full = resolve(path);
  return roots.some((root) => {
    const r = resolve(root);
    return full === r || full.startsWith(r + sep);
  });
}

const PATH_FIELDS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

export function evaluateToolUse(
  tool: string,
  input: unknown,
  ctx: PolicyContext,
): Verdict {
  if (tool === "Bash") {
    if (!isRecord(input) || typeof input.command !== "string") {
      return deny("Bash call without a command");
    }
    return evaluateBash(input.command);
  }
  const field = PATH_FIELDS[tool];
  if (field) {
    const path = isRecord(input) ? input[field] : undefined;
    if (typeof path !== "string") return deny(`${tool} call without a path`);
    return within(path, ctx.writableRoots)
      ? ALLOW
      : deny(`${tool} outside ${ctx.writableRoots.join(", ")}`);
  }
  return ALLOW;
}

export function preToolUseHook(ctx: PolicyContext): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const verdict = evaluateToolUse(input.tool_name, input.tool_input, ctx);
    if (verdict.decision === "allow") return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason ?? "denied by policy",
      },
    };
  };
}
