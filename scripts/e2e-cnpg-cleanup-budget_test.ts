import { test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "./lib/assert.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

type Resource = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string };
  spec?: { stopDelay?: number; smartShutdownTimeout?: number };
};
type Operation = { apply?: { resource?: Resource } };
type ChainsawTest = {
  spec?: {
    timeouts?: { cleanup?: string };
    steps?: { try?: Operation[] }[];
  };
};

const e2eDir = new URL("../tests/e2e/", import.meta.url).pathname;
const cnpgDefaultStopDelaySeconds = 1800;
const cnpgDefaultSmartShutdownSeconds = 180;

function durationSeconds(value: string): number {
  const match = value.match(/^(\d+)(s|m)$/);
  if (!match) throw new Error(`unsupported chainsaw duration "${value}"`);
  return Number(match[1]) * (match[2] === "m" ? 60 : 1);
}

const suiteConfig = parseYaml(
  readFileSync(join(e2eDir, ".chainsaw.yaml"), "utf8"),
) as { spec: { timeouts: { cleanup: string } } };

const appliedClusters = readdirSync(e2eDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const file = join(e2eDir, entry.name, "chainsaw-test.yaml");
    if (!existsSync(file)) return [];
    const doc = parseYaml(readFileSync(file, "utf8")) as ChainsawTest;
    const cleanup =
      doc.spec?.timeouts?.cleanup ?? suiteConfig.spec.timeouts.cleanup;
    return (doc.spec?.steps ?? [])
      .flatMap((step) => step.try ?? [])
      .map((op) => op.apply?.resource)
      .filter(
        (r): r is Resource =>
          r?.kind === "Cluster" &&
          (r.apiVersion ?? "").startsWith("postgresql.cnpg.io/"),
      )
      .map((cluster) => ({ suite: entry.name, cleanup, cluster }));
  });

test("the e2e suites apply at least one CloudNativePG Cluster", () => {
  assert(appliedClusters.length > 0, "no CNPG Cluster found under tests/e2e");
});

test("every e2e CNPG Cluster can shut down inside the chainsaw cleanup timeout", () => {
  for (const { suite, cleanup, cluster } of appliedClusters) {
    const name = `${suite}/${cluster.metadata?.name}`;
    const stopDelay = cluster.spec?.stopDelay ?? cnpgDefaultStopDelaySeconds;
    const smart =
      cluster.spec?.smartShutdownTimeout ?? cnpgDefaultSmartShutdownSeconds;
    const budget = durationSeconds(cleanup);
    assert(
      stopDelay < budget,
      `${name}: stopDelay ${stopDelay}s does not fit the ${cleanup} cleanup timeout; set spec.stopDelay`,
    );
    assert(
      smart < stopDelay,
      `${name}: smartShutdownTimeout ${smart}s must be below stopDelay ${stopDelay}s or CNPG never reaches fast shutdown`,
    );
  }
});
