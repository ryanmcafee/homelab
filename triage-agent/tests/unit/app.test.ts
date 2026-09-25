import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import type { Alert } from "../../src/alerts.ts";
import { createApp } from "../../src/app.ts";
import { readConfig } from "../../src/config.ts";
import type { QueryFn } from "../../src/triage.ts";
import { runGit } from "../../src/workspace.ts";

const root = mkdtempSync(join(tmpdir(), "app-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function upstreamRepo(): Promise<string> {
  const dir = join(root, "upstream");
  mkdirSync(dir);
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { serena: { command: "uvx" } } }),
  );
  await runGit(["init", "-q", "-b", "main"], dir);
  await runGit(["add", "-A"], dir);
  await runGit(
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qm",
      "i",
    ],
    dir,
  );
  return dir;
}

const alert = (name: string, fingerprint: string): Alert => ({
  fingerprint,
  name,
  labels: { alertname: name, namespace: "plex", severity: "critical" },
  annotations: {},
  startsAt: "2026-09-25T10:00:00Z",
});

describe("createApp", () => {
  test("triages each new alert group once with read-only SDK options", async () => {
    const upstream = await upstreamRepo();
    const etc = join(root, "etc");
    mkdirSync(etc);
    writeFileSync(join(etc, "settings.json"), "{}");
    writeFileSync(
      join(etc, "agent.json"),
      JSON.stringify({
        model: "opus[1m]",
        maxTurns: 5,
        allowedTools: ["Read", "Bash(kubectl get:*)"],
        disallowedTools: ["Write"],
      }),
    );
    writeFileSync(
      join(etc, "mcp-servers.json"),
      JSON.stringify({
        context7: { enabled: true, command: "npx", args: ["ctx7"] },
        serena: { enabled: true, command: "uvx", args: ["serena"] },
      }),
    );
    const config = readConfig({
      ALERTMANAGER_URL: "http://am:9093",
      REPO_URL: `file://${upstream}`,
      WORKSPACE_DIR: join(root, "ws", "homelab"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      SETTINGS_PATH: join(etc, "settings.json"),
      AGENT_CONFIG_PATH: join(etc, "agent.json"),
      MCP_CONFIG_PATH: join(etc, "mcp-servers.json"),
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
      IGNORED_ALERTS: "Watchdog",
    });

    const calls: { prompt: string; options: Options }[] = [];
    const query: QueryFn = async function* (params) {
      calls.push(params);
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "## Summary\nplex is down",
        total_cost_usd: 0.1,
        num_turns: 2,
      };
    };
    const notified: string[] = [];
    const app = createApp(config, {
      query,
      logger: pino({ level: "silent" }),
      env: {},
      notify: async (text) => {
        notified.push(text);
      },
    });

    await app.start();
    app.handleAlerts([alert("PlexDown", "p1"), alert("Watchdog", "w1")]);
    app.handleAlerts([alert("PlexDown", "p1")]);
    await app.idle();

    expect(calls.length).toBe(1);
    const options = calls[0]?.options;
    expect(options).toMatchObject({
      model: "opus[1m]",
      maxTurns: 5,
      cwd: join(root, "ws", "homelab"),
      settingSources: ["user", "project"],
      permissionMode: "dontAsk",
      allowedTools: ["Read", "Bash(kubectl get:*)"],
      disallowedTools: ["Write"],
      systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(["context7"]);
    expect(calls[0]?.prompt).toContain("PlexDown");
    expect(app.reports.list()[0]?.text).toContain("plex is down");
    expect(notified[0]).toContain("PlexDown");
    expect(notified[0]).toContain("plex is down");
  });

  test("dry run records the prompt without calling the agent", async () => {
    const etc = join(root, "etc");
    const config = readConfig({
      ALERTMANAGER_URL: "http://am:9093",
      REPO_URL: `file://${join(root, "upstream")}`,
      WORKSPACE_DIR: join(root, "ws2", "homelab"),
      CLAUDE_CONFIG_DIR: join(root, "claude2"),
      SETTINGS_PATH: join(etc, "settings.json"),
      AGENT_CONFIG_PATH: join(etc, "agent.json"),
      MCP_CONFIG_PATH: join(etc, "mcp-servers.json"),
      DRY_RUN: "true",
    });
    const query: QueryFn = () => {
      throw new Error("must not run");
    };
    const app = createApp(config, {
      query,
      logger: pino({ level: "silent" }),
      env: {},
    });
    await app.start();
    app.handleAlerts([alert("PlexDown", "p1")]);
    await app.idle();
    const report = app.reports.list()[0];
    expect(report?.status).toBe("ok");
    expect(report?.text).toContain("dry run");
  });
});
