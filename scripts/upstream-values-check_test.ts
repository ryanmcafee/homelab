#!/usr/bin/env -S bun test
/**
 * Unit tests for upstream-values-check.ts.
 *
 * The seeded-bad-key test is the point of the file: a fixture chart that
 * declares `spegel.mirroredRegistries` and an Application that sets
 * `spegel.registries` has to produce exactly one finding, and the bad key must
 * not be covered by the real allowlist. The last two tests read the committed
 * allowlist and .github/workflows/upgrade.yml, so an allowlist that stops
 * parsing, or a workflow whose paths filter no longer names this script, fails
 * here rather than silently ceasing to run.
 *
 *   bun test scripts/upstream-values-check_test.ts
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";
import {
  ALLOWLIST_PATH,
  UNDECLARED_VALUE_RULE_ID,
  ancestorsOf,
  cacheKey,
  chartRef,
  collectSources,
  declaredPaths,
  findingsFor,
  isAllowed,
  mergeValues,
  parseAllowlist,
  parseArgs,
  pullArgs,
  readChartTree,
  sourcesInDocuments,
  treePaths,
  undeclaredPaths,
  unusedEntries,
  unwrapDefaults,
  type AllowEntry,
  type Finding,
} from "./upstream-values-check.ts";

const REPO_ROOT = join(import.meta.dir, "..");

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "upstream-values-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("chartRef spells an ArgoCD OCI repository the way helm needs it", () => {
  assertEquals(chartRef("ghcr.io/spegel-org/helm-charts", "spegel"), {
    ref: "oci://ghcr.io/spegel-org/helm-charts/spegel",
    repo: "",
  });
  assertEquals(chartRef("oci://oci.trueforge.org/truecharts", "radarr"), {
    ref: "oci://oci.trueforge.org/truecharts/radarr",
    repo: "",
  });
  assertEquals(chartRef("https://helm.cilium.io/", "cilium"), {
    ref: "cilium",
    repo: "https://helm.cilium.io",
  });
});

test("declaredPaths marks an empty map or null as open and a populated map as set", () => {
  const paths = declaredPaths({
    resources: {},
    tolerations: null,
    spegel: { logLevel: "INFO", mirroredRegistries: [] },
  });
  assertEquals(paths.get("resources"), "open");
  assertEquals(paths.get("tolerations"), "open");
  assertEquals(paths.get("spegel"), "set");
  assertEquals(paths.get("spegel.logLevel"), "set");
  assertEquals(paths.get("spegel.mirroredRegistries"), "set");
});

test("declaredPaths treats a list as a leaf, because helm replaces it wholesale", () => {
  const paths = declaredPaths({ registries: [{ host: "docker.io" }] });
  assertEquals(paths.get("registries"), "set");
  assertEquals(paths.has("registries.host"), false);
  assertEquals(paths.has("registries.0"), false);
});

test("ancestorsOf walks from the nearest parent to the root", () => {
  assertEquals(ancestorsOf("a.b.c.d"), ["a.b.c", "a.b", "a"]);
  assertEquals(ancestorsOf("a"), []);
});

test("undeclaredPaths accepts anything below an unconstrained default", () => {
  const declared = declaredPaths({ resources: {}, podAnnotations: null });
  const found = undeclaredPaths(
    {
      resources: { limits: { cpu: "100m" }, requests: { memory: "32Mi" } },
      podAnnotations: { "checksum/config": "abc" },
    },
    declared,
  );
  assertEquals(found, []);
});

test("undeclaredPaths reports a key whose sibling-bearing parent is populated", () => {
  const declared = declaredPaths({
    spegel: { logLevel: "INFO", mirroredRegistries: [] },
  });
  const found = undeclaredPaths(
    { spegel: { logLevel: "DEBUG", registries: ["https://docker.io"] } },
    declared,
  );
  assertEquals(found, ["spegel.registries"]);
});

test("undeclaredPaths stops at the shallowest undeclared path", () => {
  const declared = declaredPaths({ known: { a: 1 } });
  const found = undeclaredPaths(
    { known: { typo: { deep: { deeper: 1 } } } },
    declared,
  );
  assertEquals(found, ["known.typo"]);
});

test("unwrapDefaults unwraps istio's sole underscore-prefixed root key", () => {
  const unwrapped = unwrapDefaults({
    _internal_defaults_do_not_set: { pilot: { autoscaleMin: 1 }, global: {} },
  });
  assertEquals(Object.keys(unwrapped as object).sort(), ["global", "pilot"]);
});

test("unwrapDefaults leaves a normal document alone", () => {
  const values = { image: { tag: "v1" } };
  assertEquals(unwrapDefaults(values), values);
  // Underscore-prefixed, but not the only key: not a wrapper.
  const mixed = { _internal: {}, image: {} };
  assertEquals(unwrapDefaults(mixed), mixed);
});

test("treePaths merges a library dependency at the root and a subchart under its key", () => {
  const paths = treePaths({
    values: { image: { tag: "v1" } },
    dependencies: [
      {
        key: "common",
        library: true,
        tree: { values: { TZ: "UTC", persistence: {} }, dependencies: [] },
      },
      {
        key: "grafana",
        library: false,
        tree: { values: { adminPassword: "x" }, dependencies: [] },
      },
    ],
  });
  assertEquals(paths.get("TZ"), "set");
  assertEquals(paths.get("persistence"), "open");
  assertEquals(paths.get("grafana.adminPassword"), "set");
  assertEquals(paths.has("common.TZ"), false);
});

test("treePaths uses the dependency alias when Chart.yaml sets one", () => {
  withTempDir((dir) => {
    write(
      join(dir, "Chart.yaml"),
      "name: parent\ndependencies:\n  - name: redis\n    alias: cache\n",
    );
    write(join(dir, "values.yaml"), "image: {}\n");
    write(join(dir, "charts/redis/Chart.yaml"), "name: redis\n");
    write(join(dir, "charts/redis/values.yaml"), "architecture: standalone\n");
    const paths = treePaths(readChartTree(dir));
    assertEquals(paths.get("cache.architecture"), "set");
    assertEquals(paths.has("redis.architecture"), false);
  });
});

test("readChartTree reads a chart with neither values.yaml nor charts/", () => {
  withTempDir((dir) => {
    write(join(dir, "Chart.yaml"), "name: bare\n");
    const tree = readChartTree(dir);
    assertEquals(tree.values, null);
    assertEquals(tree.dependencies, []);
  });
});

test("sourcesInDocuments merges helm.values under helm.valuesObject", () => {
  const sources = sourcesInDocuments(
    [
      {
        kind: "Application",
        metadata: { name: "spegel" },
        spec: {
          source: {
            repoURL: "ghcr.io/spegel-org/helm-charts",
            chart: "spegel",
            targetRevision: "0.6.0",
            helm: {
              values: "spegel:\n  logLevel: INFO\n",
              valuesObject: { spegel: { registries: ["https://docker.io"] } },
            },
          },
        },
      },
    ],
    "homelab",
  );
  assertEquals(sources.length, 1);
  assertEquals(sources[0].values, {
    spegel: { logLevel: "INFO", registries: ["https://docker.io"] },
  });
});

test("sourcesInDocuments skips git-path sources and chart sources with no values", () => {
  const sources = sourcesInDocuments(
    [
      {
        kind: "Application",
        metadata: { name: "git" },
        spec: {
          source: {
            repoURL: "https://github.com/x/y",
            path: "charts/addons",
            targetRevision: "main",
          },
        },
      },
      {
        kind: "Application",
        metadata: { name: "crds" },
        spec: {
          source: {
            repoURL: "https://example.test",
            chart: "crds",
            targetRevision: "1.0.0",
          },
        },
      },
      { kind: "ConfigMap", metadata: { name: "not-an-app" } },
      null,
    ],
    "homelab",
  );
  assertEquals(sources, []);
});

test("mergeValues deep-merges maps and replaces lists", () => {
  assertEquals(mergeValues({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } }), {
    a: { b: 1, c: 3, d: 4 },
  });
  assertEquals(mergeValues({ list: [1, 2] }, { list: [3] }), { list: [3] });
  assertEquals(mergeValues({ a: 1 }, null), { a: 1 });
  assertEquals(mergeValues(null, { a: 1 }), { a: 1 });
});

test("a seeded bad key fails, then passes when the chart declares it", () => {
  withTempDir((dir) => {
    // A fixture chart standing in for spegel 0.6.0: the key is
    // `mirroredRegistries`, and `spegel` has real children, so nothing below
    // it is free-form.
    write(join(dir, "chart/Chart.yaml"), "name: spegel\nversion: 0.6.0\n");
    write(
      join(dir, "chart/values.yaml"),
      "resources: {}\nspegel:\n  logLevel: INFO\n  mirroredRegistries: []\n",
    );
    write(
      join(dir, "tests/snapshots/homelab/addons.yaml"),
      [
        "apiVersion: argoproj.io/v1alpha1",
        "kind: Application",
        "metadata:",
        "  name: spegel",
        "spec:",
        "  source:",
        "    repoURL: ghcr.io/spegel-org/helm-charts",
        "    chart: spegel",
        "    targetRevision: 0.6.0",
        "    helm:",
        "      values: |",
        "        resources:",
        "          limits:",
        "            cpu: 100m",
        "        spegel:",
        "          logLevel: INFO",
        "          registries:",
        "            - https://docker.io",
        "",
      ].join("\n"),
    );

    const sources = collectSources(dir, "homelab");
    assertEquals(sources.length, 1);

    const declared = new Map([
      [cacheKey(sources[0]), treePaths(readChartTree(join(dir, "chart")))],
    ]);
    const findings = findingsFor(sources, declared);

    // `resources.limits.cpu` is accepted: `resources: {}` is unconstrained.
    assertEquals(
      findings.map((f) => f.path),
      ["spegel.registries"],
    );
    assertEquals(findings[0].app, "spegel");
    assertEquals(findings[0].ruleId, UNDECLARED_VALUE_RULE_ID);
    assertEquals(findings[0].chart, "spegel");
    assertEquals(findings[0].targetRevision, "0.6.0");

    // The seeded key must fail against the allowlist this repository ships,
    // or the test would be proving nothing.
    const allow = parseAllowlist(
      readFileSync(join(REPO_ROOT, ALLOWLIST_PATH), "utf8"),
    );
    assertEquals(findings.filter((f) => !isAllowed(f, allow)).length, 1);

    write(
      join(dir, "chart/values.yaml"),
      "resources: {}\nspegel:\n  logLevel: INFO\n  mirroredRegistries: []\n  registries: []\n",
    );
    const withDeclaredKey = new Map([
      [cacheKey(sources[0]), treePaths(readChartTree(join(dir, "chart")))],
    ]);
    assertEquals(findingsFor(sources, withDeclaredKey), []);
  });
});

test("isAllowed matches an entry's path and everything under it, within one chart", () => {
  const allow: AllowEntry[] = [
    { chart: "argo-cd", path: "configs.cm", reason: "free-form ConfigMap" },
  ];
  const finding = (chart: string, path: string): Finding => ({
    ruleId: UNDECLARED_VALUE_RULE_ID,
    env: "homelab",
    app: "a",
    chart,
    targetRevision: "1",
    path,
  });
  assert(isAllowed(finding("argo-cd", "configs.cm"), allow));
  assert(isAllowed(finding("argo-cd", "configs.cm.accounts.agent"), allow));
  assertEquals(isAllowed(finding("argo-cd", "configs.params.x"), allow), false);
  assertEquals(isAllowed(finding("argo-cd", "configs.cmX"), allow), false);
  assertEquals(
    isAllowed(finding("argo-workflows", "configs.cm"), allow),
    false,
  );
});

test("unusedEntries names an allowlist entry that no longer matches anything", () => {
  const allow: AllowEntry[] = [
    { chart: "argo-cd", path: "configs.cm", reason: "still needed" },
    {
      chart: "spegel",
      path: "spegel.registries",
      reason: "upstream declares it now",
    },
  ];
  const findings: Finding[] = [
    {
      ruleId: UNDECLARED_VALUE_RULE_ID,
      env: "homelab",
      app: "argocd",
      chart: "argo-cd",
      targetRevision: "9.7.1",
      path: "configs.cm.accounts.agent",
    },
  ];
  assertEquals(
    unusedEntries(findings, allow).map((e) => e.path),
    ["spegel.registries"],
  );
});

test("unusedEntries holds entries for a chart that could not be pulled", () => {
  const allow: AllowEntry[] = [
    { chart: "mosquitto", path: "persistence", reason: "still needed" },
    { chart: "mosquitto", path: "service.main", reason: "still needed" },
    {
      chart: "spegel",
      path: "spegel.registries",
      reason: "upstream declares it now",
    },
  ];
  assertEquals(
    unusedEntries([], allow, new Set(["mosquitto"])).map((e) => e.path),
    ["spegel.registries"],
  );
});

test("parseAllowlist rejects an entry with no reason", () => {
  assertThrows(
    () => parseAllowlist("allow:\n  - chart: x\n    path: y\n"),
    Error,
    'missing a non-empty "reason"',
  );
  assertThrows(
    () => parseAllowlist("entries: []\n"),
    Error,
    'expected a top-level "allow" list',
  );
});

test("pullArgs passes an http repository with --repo and an OCI ref without one", () => {
  const source = {
    env: "homelab",
    app: "a",
    chart: "cilium",
    targetRevision: "1.19.5",
    values: {},
    repoURL: "https://helm.cilium.io/",
  };
  assertEquals(pullArgs(source, "/tmp/x"), [
    "pull",
    "cilium",
    "--version",
    "1.19.5",
    "--repo",
    "https://helm.cilium.io",
    "--untar",
    "--untardir",
    "/tmp/x",
  ]);
  const oci = {
    ...source,
    chart: "spegel",
    targetRevision: "0.6.0",
    repoURL: "ghcr.io/spegel-org/helm-charts",
  };
  assertEquals(pullArgs(oci, "/tmp/x"), [
    "pull",
    "oci://ghcr.io/spegel-org/helm-charts/spegel",
    "--version",
    "0.6.0",
    "--untar",
    "--untardir",
    "/tmp/x",
  ]);
});

test("parseArgs defaults to every environment and rejects an unknown flag", () => {
  assertEquals(parseArgs([]).envs, ["homelab", "localdev"]);
  assertEquals(parseArgs(["--env", "homelab"]).envs, ["homelab"]);
  assertEquals(parseArgs(["--env=homelab,localdev"]).envs, [
    "homelab",
    "localdev",
  ]);
  assert(parseArgs(["--json"]).json);
  assertThrows(() => parseArgs(["--nope"]), Error, "unknown argument");
  assertThrows(
    () => parseArgs(["--env", ""]),
    Error,
    "at least one environment",
  );
});

test("collectSources fails loudly for an environment with no snapshot", () => {
  withTempDir((dir) => {
    assertThrows(
      () => collectSources(dir, "nosuchenv"),
      Error,
      "no rendered snapshot",
    );
  });
});

test("the committed allowlist parses and every entry carries a reason", () => {
  const allow = parseAllowlist(
    readFileSync(join(REPO_ROOT, ALLOWLIST_PATH), "utf8"),
  );
  for (const entry of allow) {
    assert(
      entry.reason.length > 20,
      `${entry.chart}:${entry.path} needs a real reason, got ${JSON.stringify(entry.reason)}`,
    );
  }
});

test("upgrade.yml runs this check and its paths filter names the script", () => {
  const workflow = readFileSync(
    join(REPO_ROOT, ".github/workflows/upgrade.yml"),
    "utf8",
  );
  assertStringIncludes(workflow, "task upstream:values");
  assertStringIncludes(workflow, "scripts/upstream-values-check.ts");
  assertStringIncludes(workflow, ALLOWLIST_PATH);
});
