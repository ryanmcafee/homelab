import { describe, expect, test } from "bun:test";
import { parseAgentConfig, readConfig } from "../../src/config.ts";

const minimal = {
  ALERTMANAGER_URL: "http://am.monitoring.svc:9093",
  REPO_URL: "https://github.com/example/homelab",
  CLAUDE_CONFIG_DIR: "/home/agent/.claude",
  CLAUDE_CODE_OAUTH_TOKEN: "tok",
};

describe("readConfig", () => {
  test("applies defaults", () => {
    const config = readConfig(minimal);
    expect(config.port).toBe(8080);
    expect(config.sweepIntervalSeconds).toBe(300);
    expect(config.cooldownSeconds).toBe(86400);
    expect([...config.ignoredAlerts]).toEqual(["Watchdog", "InfoInhibitor"]);
    expect(config.repoBranch).toBe("main");
    expect(config.dryRun).toBe(false);
    expect(config.dotfilesRepo).toBeUndefined();
  });

  test("parses lists, numbers and booleans", () => {
    const config = readConfig({
      ...minimal,
      PORT: "9000",
      IGNORED_ALERTS: "Watchdog, InfoInhibitor ,GitHubPullRequestNeedsReview",
      DRY_RUN: "true",
      DOTFILES_REPO: "owner/dotfiles",
    });
    expect(config.port).toBe(9000);
    expect(config.ignoredAlerts.has("GitHubPullRequestNeedsReview")).toBe(true);
    expect(config.dryRun).toBe(true);
    expect(config.dotfilesRepo).toBe("owner/dotfiles");
  });

  test("requires the OAuth token unless DRY_RUN is set", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _omit, ...noToken } = minimal;
    expect(() => readConfig(noToken)).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(readConfig({ ...noToken, DRY_RUN: "true" }).dryRun).toBe(true);
  });

  test("rejects a dotfiles repo that is not owner/name", () => {
    expect(() =>
      readConfig({ ...minimal, DOTFILES_REPO: "https://evil/x" }),
    ).toThrow(/DOTFILES_REPO/);
  });

  test("rejects a non-http Alertmanager URL", () => {
    expect(() =>
      readConfig({ ...minimal, ALERTMANAGER_URL: "file:///etc" }),
    ).toThrow(/ALERTMANAGER_URL/);
  });
});

describe("parseAgentConfig", () => {
  test("fills defaults and keeps tool lists", () => {
    const agent = parseAgentConfig({
      model: "opus[1m]",
      allowedTools: ["Read", "Bash(kubectl get:*)"],
    });
    expect(agent).toEqual({
      model: "opus[1m]",
      maxTurns: 60,
      timeoutSeconds: 1200,
      allowedTools: ["Read", "Bash(kubectl get:*)"],
      disallowedTools: [],
    });
  });

  test("defaults the tool lists to empty, leaving them to settings.json", () => {
    expect(parseAgentConfig({ model: "opus" })).toMatchObject({
      allowedTools: [],
      disallowedTools: [],
    });
  });

  test("rejects a missing model", () => {
    expect(() => parseAgentConfig({ allowedTools: [] })).toThrow();
  });
});
