import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  errorClass,
  kindKubeconfig,
  safeCommand,
} from "./lib/openclaw-e2e-command.ts";

function fixture(context: string): string {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    "current-context": context,
    contexts: [{ name: context, context: { cluster: context, user: context } }],
    clusters: [{ name: context, cluster: { server: "https://127.0.0.1:1" } }],
    users: [{ name: context, user: {} }],
  });
}

test("real kubectl reproduces Chainsaw context loss; named Kind config fixes selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-command-test-"));
  const previous = {
    PATH: process.env.PATH,
    KUBECONFIG: process.env.KUBECONFIG,
  };
  try {
    const injected = join(dir, "chainsaw.json");
    writeFileSync(injected, fixture("chainsaw"));
    process.env.KUBECONFIG = injected;
    const old = Bun.spawnSync([
      "kubectl",
      "--context",
      "kind-homelab-localdev",
      "--request-timeout=30s",
      "get",
      "openclawinstances.openclaw.rocks",
      "openclaw",
      "-n",
      "openclaw",
      "-o",
      "json",
    ]);
    expect(old.exitCode).toBe(1);
    expect(old.stderr.toString()).toContain(
      'context "kind-homelab-localdev" does not exist',
    );
    // Only kind is faked: actual kubectl parses both kubeconfigs, without API calls.
    writeFileSync(
      join(dir, "kind"),
      `#!/usr/bin/env bun\nif (process.argv.slice(2).join(" ") !== "get kubeconfig --name homelab-localdev") process.exit(9);\nprocess.stdout.write(${JSON.stringify(fixture("kind-homelab-localdev"))});\n`,
      { mode: 0o700 },
    );
    process.env.PATH = `${dir}:${previous.PATH}`;
    const selected = kindKubeconfig(process.cwd());
    const path = selected.args[2];
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(
        safeCommand(
          [...selected.args, "config", "current-context"],
          process.cwd(),
        ).trim(),
      ).toBe("kind-homelab-localdev");
      expect(selected.args).toContain("--context");
      expect(selected.args).toContain("--request-timeout=30s");
    } finally {
      selected.cleanup();
    }
    expect(existsSync(path)).toBe(false);
    // A generic Chainsaw/production alias must not become an accepted target.
    writeFileSync(
      join(dir, "kind"),
      `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(fixture("chainsaw"))});\n`,
      { mode: 0o700 },
    );
    expect(() => kindKubeconfig(process.cwd())).toThrow(
      "class=context-missing",
    );
    writeFileSync(
      join(dir, "kind"),
      '#!/usr/bin/env bun\nprocess.stderr.write("private fixture payload"); process.exit(7);\n',
      { mode: 0o700 },
    );
    expect(() => kindKubeconfig(process.cwd())).toThrow(
      "exit 7; class=unclassified; output suppressed",
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diagnostics classify failure without printing stdout, stderr or arguments", () => {
  expect(errorClass('error: context "private payload" does not exist')).toBe(
    "context-missing",
  );
  expect(errorClass("Error from server (Forbidden): private payload")).toBe(
    "forbidden",
  );
  expect(errorClass("Error from server (NotFound): private payload")).toBe(
    "not-found",
  );
  expect(errorClass("private payload")).toBe("unclassified");
  try {
    safeCommand(
      [
        process.execPath,
        "-e",
        'console.log("private stdout"); console.error("private stderr"); process.exit(2)',
      ],
      process.cwd(),
    );
    throw new Error("expected rejection");
  } catch (error) {
    expect(String(error)).toContain(
      "exit 2; class=unclassified; output suppressed",
    );
    expect(String(error)).not.toContain("private");
  }
});
