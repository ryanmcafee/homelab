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
import { afterAll, test } from "bun:test";
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
  describeUnusedEntries,
  findingsFor,
  isAllowed,
  isTransientPullError,
  mergeValues,
  parseAllowlist,
  parseArgs,
  pullArgs,
  pullChart,
  readChartTree,
  sourcesInDocuments,
  treePaths,
  undeclaredPaths,
  unusedEntries,
  unwrapDefaults,
  type AllowEntry,
  type ChartSource,
  type Finding,
  type PullRun,
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

test("sourcesInDocuments refuses multi-source Helm Applications", () => {
  const app = {
    kind: "Application",
    metadata: { name: "multi" },
    spec: {
      sources: [
        {
          repoURL: "https://example.test",
          chart: "sample",
          targetRevision: "1",
        },
        { repoURL: "https://example.test/git", path: "values" },
      ],
    },
  };
  const error = assertThrows(() => sourcesInDocuments([app], "homelab"));
  assertStringIncludes(error.message, "upstream-values/unsupported-source");
});

test("sourcesInDocuments refuses unchecked Helm parameters", () => {
  for (const helm of [
    { parameters: [{ name: "unknown", value: "true" }] },
    { fileParameters: [{ name: "unknown", path: "values.txt" }] },
  ]) {
    const app = {
      kind: "Application",
      metadata: { name: "parameters" },
      spec: {
        source: {
          repoURL: "https://example.test",
          chart: "sample",
          targetRevision: "1",
          helm,
        },
      },
    };
    const error = assertThrows(() => sourcesInDocuments([app], "homelab"));
    assertStringIncludes(error.message, "upstream-values/unsupported-source");
  }
});

test("readChartTree refuses a pulled directory without Chart.yaml", () => {
  withTempDir((dir) => {
    write(join(dir, "values.yaml"), "replicaCount: 1\n");
    const error = assertThrows(() => readChartTree(dir));
    assertStringIncludes(error.message, "upstream-values/chart-layout");
  });
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

test("isAllowed matches a path only for the same pinned chart", () => {
  const identity = {
    repoURL: "https://argoproj.github.io/argo-helm",
    chart: "argo-cd",
    targetRevision: "9.7.1",
  };
  const allow: AllowEntry[] = [
    { ...identity, path: "configs.cm", reason: "free-form ConfigMap" },
  ];
  const finding = (path: string, overrides = {}): Finding => ({
    ruleId: UNDECLARED_VALUE_RULE_ID,
    env: "homelab",
    app: "a",
    ...identity,
    path,
    ...overrides,
  });
  assert(isAllowed(finding("configs.cm"), allow));
  assert(isAllowed(finding("configs.cm.accounts.agent"), allow));
  assertEquals(isAllowed(finding("configs.params.x"), allow), false);
  assertEquals(isAllowed(finding("configs.cmX"), allow), false);
  assertEquals(
    isAllowed(finding("configs.cm", { chart: "argo-workflows" }), allow),
    false,
  );
  assertEquals(
    isAllowed(finding("configs.cm", { repoURL: "https://other.test" }), allow),
    false,
  );
  assertEquals(
    isAllowed(finding("configs.cm", { targetRevision: "9.7.2" }), allow),
    false,
  );
});

test("unusedEntries names an allowlist entry that no longer matches anything", () => {
  const argo = {
    repoURL: "https://argoproj.github.io/argo-helm",
    chart: "argo-cd",
    targetRevision: "9.7.1",
  };
  const allow: AllowEntry[] = [
    { ...argo, path: "configs.cm", reason: "still needed" },
    {
      repoURL: "ghcr.io/spegel-org/helm-charts",
      chart: "spegel",
      targetRevision: "0.6.0",
      path: "spegel.registries",
      reason: "upstream declares it now",
    },
  ];
  const findings: Finding[] = [
    {
      ruleId: UNDECLARED_VALUE_RULE_ID,
      env: "homelab",
      app: "argocd",
      ...argo,
      path: "configs.cm.accounts.agent",
    },
  ];
  assertEquals(
    unusedEntries(findings, allow).map((e) => e.path),
    ["spegel.registries"],
  );
});

test("unusedEntries holds entries for a chart that could not be pulled", () => {
  const mosquitto = {
    repoURL: "oci.trueforge.org/truecharts",
    chart: "mosquitto",
    targetRevision: "17.17.2",
  };
  const allow: AllowEntry[] = [
    { ...mosquitto, path: "persistence", reason: "still needed" },
    { ...mosquitto, path: "service.main", reason: "still needed" },
    {
      ...mosquitto,
      targetRevision: "17.17.3",
      path: "persistence",
      reason: "different revision",
    },
    {
      repoURL: "ghcr.io/spegel-org/helm-charts",
      chart: "spegel",
      targetRevision: "0.6.0",
      path: "spegel.registries",
      reason: "upstream declares it now",
    },
  ];
  assertEquals(
    unusedEntries([], allow, new Set([cacheKey(mosquitto)])).map(
      (e) => `${e.targetRevision}:${e.path}`,
    ),
    ["17.17.3:persistence", "0.6.0:spegel.registries"],
  );
});

test("unused entry pinned to a source says to remove the obsolete exception", () => {
  const identity = {
    repoURL: "https://argoproj.github.io/argo-helm",
    chart: "argo-cd",
    targetRevision: "9.7.1",
  };
  const entry: AllowEntry = {
    ...identity,
    path: "configs.cm",
    reason: "previously needed",
  };
  const source = {
    ...identity,
    env: "homelab",
    app: "argocd",
    values: {},
  };
  const messages = describeUnusedEntries([entry], [source]);
  assertEquals(messages.length, 1);
  assertStringIncludes(messages[0], "chart declares the key now, so remove");
  assertStringIncludes(messages[0], cacheKey(entry));
});

test("unused entry with no pinned identity says to review the new revision", () => {
  const identity = {
    repoURL: "https://argoproj.github.io/argo-helm",
    chart: "argo-cd",
    targetRevision: "9.7.1",
  };
  const entry: AllowEntry = {
    ...identity,
    path: "configs.cm",
    reason: "previously needed",
  };
  const source = {
    ...identity,
    targetRevision: "9.7.2",
    env: "homelab",
    app: "argocd",
    values: {},
  };
  const messages = describeUnusedEntries([entry], [source]);
  assertEquals(messages.length, 1);
  assertStringIncludes(messages[0], `no Application pins ${cacheKey(entry)}`);
  assertStringIncludes(messages[0], "currently pinned revision(s): 9.7.2");
  assertStringIncludes(messages[0], "re-review the reason");
  assertStringIncludes(messages[0], "update targetRevision");
  assertEquals(messages[0].includes("chart declares the key now"), false);
});

test("parseAllowlist requires the complete pinned chart identity and reason", () => {
  assertThrows(
    () =>
      parseAllowlist(
        "allow:\n  - chart: x\n    targetRevision: 1\n    path: y\n    reason: z\n",
      ),
    Error,
    'missing a non-empty "repoURL"',
  );
  assertThrows(
    () =>
      parseAllowlist(
        "allow:\n  - repoURL: https://x.test\n    chart: x\n    path: y\n    reason: z\n",
      ),
    Error,
    'missing a non-empty "targetRevision"',
  );
  assertThrows(
    () =>
      parseAllowlist(
        "allow:\n  - repoURL: https://x.test\n    chart: x\n    targetRevision: v1\n    path: y\n",
      ),
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
  assertEquals(allow.length, 48);
  const pinned = new Set(
    ["homelab", "localdev"].flatMap((env) =>
      collectSources(REPO_ROOT, env).map(cacheKey),
    ),
  );
  for (const entry of allow) {
    assert(pinned.has(cacheKey(entry)), `${cacheKey(entry)} is not pinned`);
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

const RESET_TAIL =
  "read tcp 10.1.0.4:52114->203.0.113.7:443: read: connection reset by peer";
const RESET = `Error: failed to do request: Head "https://oci.trueforge.org/v2/truecharts/flaresolverr/manifests/16.18.2": ${RESET_TAIL}`;
const MANIFEST_UNKNOWN =
  'Error: failed to perform "FetchReference" on source: oci.trueforge.org/truecharts/flaresolverr:99.0.0: not found';

const flaresolverr: ChartSource = {
  env: "homelab",
  app: "flaresolverr",
  repoURL: "oci.trueforge.org/truecharts",
  chart: "flaresolverr",
  targetRevision: "16.18.2",
  values: {},
};

/** A helm stand-in that fails with each stderr in turn, then succeeds. */
function scriptedRun(failures: string[]): {
  run: PullRun;
  calls: () => number;
} {
  let calls = 0;
  const run: PullRun = async () => {
    const stderr = failures[calls++];
    return stderr === undefined
      ? { exitCode: 0, stderr: "" }
      : { exitCode: 1, stderr };
  };
  return { run, calls: () => calls };
}

const noSleep = async () => {};

const pullRoot = mkdtempSync(join(tmpdir(), "upstream-values-pull-"));
const UNTAR = join(pullRoot, "untar");
afterAll(() => rmSync(pullRoot, { recursive: true, force: true }));

test("isTransientPullError: resets, timeouts, 5xx and 429 retry; not-found does not", () => {
  for (const stderr of [
    RESET,
    'Error: Get "https://oci.trueforge.org/v2/": net/http: TLS handshake timeout',
    'Error: Get "https://ghcr.io/v2/": dial tcp 140.82.112.33:443: i/o timeout',
    "Error: unexpected status code 503: Service Unavailable",
    "Error: GET https://oci.trueforge.org/v2/token: response status code 502: Bad Gateway",
    "Error: unexpected status code 429: Too Many Requests",
    "Error: failed to fetch https://charts.example.com/index.yaml : 500 Internal Server Error",
    // A 404 in a tag or port is not a status code.
    `Error: failed to do request: Head "https://oci.example/v2/charts/widget/manifests/1.404.0": ${RESET_TAIL}`,
    `Error: failed to do request: Head "https://oci.example:404/v2/charts/widget/manifests/1.0.0": ${RESET_TAIL}`,
  ]) {
    assert(isTransientPullError(stderr), `expected transient: ${stderr}`);
  }
  for (const stderr of [
    MANIFEST_UNKNOWN,
    "Error: MANIFEST_UNKNOWN: manifest unknown; map[Tag:99.0.0]",
    "Error: failed to fetch https://charts.example.com/x-1.0.0.tgz : 404 Not Found",
    // A 404 status vetoes the retry even when a reset was logged first.
    `WARNING: ${RESET_TAIL}\nError: GET "https://oci.example/v2/charts/widget/manifests/1.0.0": response status code 404`,
    'Error: chart "x" version "9.9.9" not found in https://charts.example.com repository',
    'Error: failed to perform "FetchReference" on source: GET "https://oci.trueforge.org/v2/truecharts/nosuchchart-xyz/manifests/1.0.0": response status code 401: unauthorized: access to the requested resource is not authorized: map[]',
    // A 5xx digit run inside an address is not a status code.
    "Error: dial tcp 10.0.0.1:5000: connect: connection refused (host 10.0.0.503)",
  ]) {
    assert(!isTransientPullError(stderr), `expected non-retryable: ${stderr}`);
  }
});

test("pullChart: a transient reset is retried and the pull then succeeds", async () => {
  const { run, calls } = scriptedRun([RESET]);
  const result = await pullChart(flaresolverr, UNTAR, {
    run,
    sleep: noSleep,
  });
  assertEquals(result, { dir: join(UNTAR, "flaresolverr") });
  assertEquals(calls(), 2);
});

test("pullChart: a persistent reset fails closed after the bounded attempts", async () => {
  const { run, calls } = scriptedRun([RESET, RESET, RESET, RESET]);
  const slept: number[] = [];
  const result = await pullChart(flaresolverr, UNTAR, {
    run,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert("error" in result, "a persistent reset must not pass");
  assertStringIncludes(result.error, "after 3 attempt(s)");
  assertStringIncludes(result.error, "connection reset by peer");
  assertEquals(calls(), 3);
  assertEquals(slept, [2000, 5000]);
});

test("pullChart: a reset on a tag containing 404 is still retried", async () => {
  const tagged: ChartSource = { ...flaresolverr, targetRevision: "1.404.0" };
  const reset = `Error: failed to do request: Head "https://oci.trueforge.org/v2/truecharts/flaresolverr/manifests/1.404.0": ${RESET_TAIL}`;
  const { run, calls } = scriptedRun([reset, reset, reset]);
  const result = await pullChart(tagged, UNTAR, { run, sleep: noSleep });
  assert("error" in result, "a persistent reset must not pass");
  assertStringIncludes(result.error, "after 3 attempt(s)");
  assertEquals(calls(), 3);
});

test("pullChart: manifest unknown fails on the first attempt with no retry", async () => {
  const { run, calls } = scriptedRun([MANIFEST_UNKNOWN]);
  const result = await pullChart(flaresolverr, UNTAR, {
    run,
    sleep: noSleep,
  });
  assert("error" in result, "a missing version must not pass");
  assertStringIncludes(result.error, "not found");
  assertStringIncludes(result.error, "after 1 attempt(s)");
  assertEquals(calls(), 1);
});

test("pullChart: a non-retryable error after a transient one stops the retries", async () => {
  const { run, calls } = scriptedRun([RESET, MANIFEST_UNKNOWN]);
  const result = await pullChart(flaresolverr, UNTAR, {
    run,
    sleep: noSleep,
  });
  assert("error" in result, "a missing version must not pass");
  assertStringIncludes(result.error, "after 2 attempt(s)");
  assertEquals(calls(), 2);
});
