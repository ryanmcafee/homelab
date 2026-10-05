/** Subprocess plumbing for the Kind-only OpenClaw live suite. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const openclawContext = "kind-homelab-localdev";

// Return only fixed labels. Rejected resources and exec output may contain credentials.
export function errorClass(stderr: string): string {
  if (
    /context .* does not exist|no context exists|cannot locate context/.test(
      stderr,
    )
  )
    return "context-missing";
  if (/\(Forbidden\)|forbidden:/.test(stderr)) return "forbidden";
  if (/\(Unauthorized\)|must be logged in/.test(stderr)) return "unauthorized";
  if (/\(NotFound\)|not found/.test(stderr)) return "not-found";
  if (/connection refused|Unable to connect to the server/.test(stderr))
    return "connection-failed";
  if (/timed out|deadline exceeded/.test(stderr)) return "timeout";
  return "unclassified";
}

export function safeCommand(
  args: string[],
  cwd: string,
  input?: string,
): string {
  const result = Bun.spawnSync(args, {
    cwd,
    env: { ...process.env },
    stdin: input === undefined ? undefined : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(
      `command ${args[0]} failed (exit ${result.exitCode}; class=${errorClass(result.stderr.toString())}; output suppressed)`,
    );
  return result.stdout.toString();
}

/**
 * Chainsaw replaces KUBECONFIG with a file whose only context is "chainsaw".
 * Obtain the named local Kind cluster's config instead of trusting that alias or
 * the host's current context. No kubeconfig or credentials are printed.
 */
export function kindKubeconfig(cwd: string): {
  args: string[];
  cleanup: () => void;
} {
  const config = safeCommand(
    ["kind", "get", "kubeconfig", "--name", "homelab-localdev"],
    cwd,
  );
  const dir = mkdtempSync(join(tmpdir(), "openclaw-e2e-"));
  const path = join(dir, "kubeconfig");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    writeFileSync(path, config, { mode: 0o600 });
    const args = [
      "kubectl",
      "--kubeconfig",
      path,
      "--context",
      openclawContext,
      "--request-timeout=30s",
    ];
    // Fail before any API operation if the named Kind context is absent.
    safeCommand([...args, "config", "view", "--minify", "-o", "name"], cwd);
    return { args, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
