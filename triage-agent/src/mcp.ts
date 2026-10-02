import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const serverSchema = z.object({
  enabled: z.boolean(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

const configSchema = z.record(z.string().min(1), serverSchema);

const projectSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).default({}),
});

export interface SkippedServer {
  name: string;
  reason: string;
}

export interface LoadedMcpServers {
  servers: Record<string, McpStdioServerConfig>;
  skipped: SkippedServer[];
}

type Env = Record<string, string | undefined>;

const VARIABLE = /\$\{([A-Z0-9_]+)\}/g;

function missingVariables(values: readonly string[], env: Env): string[] {
  return values.flatMap((v) =>
    [...v.matchAll(VARIABLE)]
      .map((m) => m[1] ?? "")
      .filter((name) => !env[name]),
  );
}

function expand(value: string, env: Env): string {
  return value.replace(VARIABLE, (_, name: string) => env[name] ?? "");
}

/**
 * Turns the chart's mcp-servers.json into the SDK `mcpServers` option. `${VAR}`
 * in args or env comes from the process environment; a server that references
 * an unset variable is skipped, so optional credentials switch it off.
 */
export function loadMcpServers(
  raw: unknown,
  env: Env,
  projectServers: ReadonlySet<string>,
): LoadedMcpServers {
  const servers: Record<string, McpStdioServerConfig> = {};
  const skipped: SkippedServer[] = [];
  for (const [name, server] of Object.entries(configSchema.parse(raw))) {
    const missing = missingVariables(
      [...server.args, ...Object.values(server.env)],
      env,
    );
    if (!server.enabled) {
      skipped.push({ name, reason: "disabled" });
    } else if (projectServers.has(name)) {
      skipped.push({ name, reason: "registered by the project .mcp.json" });
    } else if (missing.length > 0) {
      skipped.push({ name, reason: `unset: ${missing.join(", ")}` });
    } else {
      servers[name] = {
        type: "stdio",
        command: server.command,
        args: server.args.map((a) => expand(a, env)),
        env: Object.fromEntries(
          Object.entries(server.env).map(([k, v]) => [k, expand(v, env)]),
        ),
      };
    }
  }
  return { servers, skipped };
}

export function readProjectMcpServerNames(repoDir: string): Set<string> {
  const path = join(repoDir, ".mcp.json");
  if (!existsSync(path)) return new Set();
  const parsed = projectSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  return new Set(Object.keys(parsed.mcpServers));
}
