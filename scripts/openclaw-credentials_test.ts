#!/usr/bin/env -S bun test
/**
 * Credential wiring of charts/openclaw, asserted over the real `helm template`
 * output at the chart's committed values (docs/apps/openclaw.md).
 *
 * These tests exist for what they deny. A rendered Instance that boots proves
 * nothing about which provider pays for the agent's tokens, so every case below
 * asserts the EXACT set of environment variables, not just that the expected one
 * is present. tests/policy/openclaw.rego covers the same contract structurally
 * over every rendered environment; this covers the chart's own defaults, which a
 * policy over rendered manifests cannot see.
 *
 *   bun test scripts/openclaw-credentials_test.ts
 */

import { test } from "bun:test";
import { assert, assertEquals } from "./lib/assert.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

const CHART = "charts/openclaw";

// Every variable that moves spend to per-token API billing. None may appear
// unless its own adapters.apiKeys toggle put it there.
const METERED = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"];

// The variable charts/paperclip uses for the same subscription credential.
// OpenClaw's native Anthropic provider never reads it, so it must never be
// wired here.
const DEAD = "CLAUDE_CODE_OAUTH_TOKEN";

const SUBSCRIPTION = "ANTHROPIC_OAUTH_TOKEN";

type EnvEntry = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name?: string; key?: string; optional?: boolean };
  };
};

type Instance = {
  kind: string;
  spec: {
    env?: EnvEntry[];
    envFrom?: unknown[];
    config?: {
      raw?: { models?: { providers?: Record<string, { apiKey?: string }> } };
    };
  };
};

/** render runs `helm template` on charts/openclaw and returns the Instance. */
async function render(
  sets: string[] = [],
): Promise<{ instance: Instance; text: string }> {
  const args = [
    "template",
    "openclaw",
    CHART,
    "--set",
    "hostname=openclaw.homelab.local",
    "--set",
    "image.tag=2026.9.6",
    ...sets.flatMap((s) => ["--set", s]),
  ];
  const proc = Bun.spawn(["helm", ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  assertEquals(code, 0, `helm template failed: ${stderr}`);
  const instance = parseYaml(text) as Instance;
  assertEquals(instance.kind, "OpenClawInstance");
  return { instance, text };
}

function envNames(instance: Instance): string[] {
  return (instance.spec.env ?? []).map((e) => e.name).sort();
}

/** assertWiredByReference proves a credential is a rotatable, optional ref. */
function assertWiredByReference(instance: Instance, name: string): void {
  const entry = (instance.spec.env ?? []).find((e) => e.name === name);
  assert(entry !== undefined, `${name} is not declared under spec.env`);
  assertEquals(
    entry.value,
    undefined,
    `${name} must not carry a literal value`,
  );
  const ref = entry.valueFrom?.secretKeyRef;
  assert(ref !== undefined, `${name} must come from a secretKeyRef`);
  assertEquals(ref.name, "openclaw-api-keys", `${name} reads the wrong Secret`);
  assertEquals(
    ref.key,
    name,
    `${name} must read the Secret field of the same name`,
  );
  assertEquals(
    ref.optional,
    true,
    `${name} must be optional so a missing field leaves it unset`,
  );
}

test("default values wire the subscription token and nothing else", async () => {
  const { instance } = await render();
  assertEquals(envNames(instance), [SUBSCRIPTION]);
  assertWiredByReference(instance, SUBSCRIPTION);
});

test("default values expose no metered API key and no discarded variable", async () => {
  const { text } = await render();
  for (const name of [...METERED, DEAD]) {
    assert(!text.includes(name), `default render must not mention ${name}`);
  }
});

test("enabling the anthropic toggle adds exactly ANTHROPIC_API_KEY", async () => {
  const { instance, text } = await render([
    "adapters.apiKeys.anthropic.enabled=true",
  ]);
  assertEquals(envNames(instance), ["ANTHROPIC_API_KEY", SUBSCRIPTION]);
  assertWiredByReference(instance, "ANTHROPIC_API_KEY");
  assert(
    !text.includes("OPENAI_API_KEY"),
    "the anthropic toggle must not wire OpenAI",
  );
  assert(
    !text.includes("CODEX_API_KEY"),
    "the anthropic toggle must not wire Codex",
  );
});

test("enabling the openai toggle adds exactly OPENAI_API_KEY", async () => {
  const { instance, text } = await render([
    "adapters.apiKeys.openai.enabled=true",
  ]);
  assertEquals(envNames(instance), [SUBSCRIPTION, "OPENAI_API_KEY"]);
  assertWiredByReference(instance, "OPENAI_API_KEY");
  assert(
    !text.includes("ANTHROPIC_API_KEY"),
    "the openai toggle must not wire Anthropic",
  );
});

test("both toggles on wire both keys and still nothing else", async () => {
  const { instance } = await render([
    "adapters.apiKeys.anthropic.enabled=true",
    "adapters.apiKeys.openai.enabled=true",
  ]);
  assertEquals(envNames(instance), [
    "ANTHROPIC_API_KEY",
    SUBSCRIPTION,
    "OPENAI_API_KEY",
  ]);
});

test("no toggle combination ever renders a whole-Secret env reference", async () => {
  for (const sets of [
    [],
    ["adapters.apiKeys.anthropic.enabled=true"],
    ["adapters.apiKeys.openai.enabled=true"],
    [
      "adapters.apiKeys.anthropic.enabled=true",
      "adapters.apiKeys.openai.enabled=true",
    ],
  ]) {
    const { instance, text } = await render(sets);
    assertEquals(
      instance.spec.envFrom,
      undefined,
      `envFrom rendered for ${sets.join(",")}`,
    );
    assert(
      !text.includes("envFrom"),
      `envFrom appears in the render for ${sets.join(",")}`,
    );
    assert(
      !text.includes("secretRef"),
      `a whole-Secret ref appears for ${sets.join(",")}`,
    );
  }
});

test("the provider allowlist names only variables the Instance declares", async () => {
  for (const sets of [
    [],
    ["adapters.apiKeys.anthropic.enabled=true"],
    ["adapters.apiKeys.openai.enabled=true"],
  ]) {
    const { instance } = await render(sets);
    const providers = instance.spec.config?.raw?.models?.providers ?? {};
    const declared = new Set(envNames(instance));
    for (const [provider, config] of Object.entries(providers)) {
      const referenced = config.apiKey?.match(/^\$\{([A-Z0-9_]+)\}$/)?.[1];
      assert(
        referenced !== undefined,
        `provider ${provider} has no interpolated apiKey`,
      );
      assert(
        declared.has(referenced),
        `provider ${provider} reads undeclared ${referenced}`,
      );
    }
  }
});

test("the subscription token outranks an enabled anthropic API key", async () => {
  // OpenClaw resolves anthropic as [ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY]
  // (src/secrets/provider-env-vars.ts), so turning the API key on for a specific
  // model must not silently repoint the provider at metered billing.
  const { instance } = await render([
    "adapters.apiKeys.anthropic.enabled=true",
  ]);
  const providers = instance.spec.config?.raw?.models?.providers ?? {};
  assertEquals(providers.anthropic?.apiKey, `\${${SUBSCRIPTION}}`);
});

test("clearing the credentials Secret name wires no credential at all", async () => {
  const { instance } = await render(["adapters.secretName="]);
  assertEquals(instance.spec.env, undefined);
});
