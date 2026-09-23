#!/usr/bin/env -S bun test
import { test } from "bun:test";

/**
 * Unit tests for the pure logic in localdev-kind.ts.
 *
 * Nothing here needs Docker or Kind: these cover the hosts.toml rendering,
 * the registry upstream table, version parsing from a YAML string, the kind
 * image tag derivation, the Cilium values extraction, the cache dir
 * resolution and the argument parser.
 *
 *   bun test scripts/localdev-kind_test.ts
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "./lib/assert.ts";
import { parse as parseYaml } from "./lib/yaml.ts";
import {
  CERTS_D,
  DEFAULT_CILIUM_KIND_VALUES,
  assignGeneratedValues,
  generatedSecretStubs,
  DEFAULT_CLUSTER,
  extractCiliumValues,
  formatCommand,
  formatStatusTable,
  hostsTomlPath,
  kindBundledStorageObjects,
  kindNodeImage,
  kubectlDeleteArgs,
  parseArgs,
  parseVersions,
  registryContainerName,
  registryProxyUrl,
  registryUpstreams,
  renderHostsToml,
  resolveCacheDir,
  UsageError,
} from "./localdev-kind.ts";

// ----------------------------------------------------------------------------
// hosts.toml
// ----------------------------------------------------------------------------
test("renderHostsToml: proxy first, upstream as the fallback server", () => {
  const toml = renderHostsToml("ghcr.io", "http://kind-registry-ghcr:5000");
  assertStringIncludes(toml, 'server = "https://ghcr.io"');
  assertStringIncludes(toml, '[host."http://kind-registry-ghcr:5000"]');
  assertStringIncludes(toml, 'capabilities = ["pull", "resolve"]');
  // `server` must come before the host table: TOML top-level keys cannot
  // follow a table header.
  assert(toml.indexOf("server =") < toml.indexOf("[host."));
  assert(toml.endsWith("\n"));
});

test("renderHostsToml: docker.io uses its real API host as server", () => {
  // https://docker.io is not a registry endpoint; the fallback must be the
  // same host the proxy fronts.
  const toml = renderHostsToml(
    "docker.io",
    "http://kind-registry-docker:5000",
    "https://registry-1.docker.io",
  );
  assertStringIncludes(toml, 'server = "https://registry-1.docker.io"');
  assert(!toml.includes('"https://docker.io"'));
});

test("hostsTomlPath: certs.d/<host>/hosts.toml", () => {
  assertEquals(
    hostsTomlPath("registry.k8s.io"),
    `${CERTS_D}/registry.k8s.io/hosts.toml`,
  );
  assertEquals(CERTS_D, "/etc/containerd/certs.d");
});

// ----------------------------------------------------------------------------
// Upstream table
// ----------------------------------------------------------------------------
test("registryUpstreams: the five upstreams from the plan, unique names and hosts", () => {
  const hosts = registryUpstreams.map((u) => u.host);
  assertEquals(hosts, [
    "docker.io",
    "ghcr.io",
    "quay.io",
    "registry.k8s.io",
    "lscr.io",
  ]);
  assertEquals(
    new Set(registryUpstreams.map((u) => u.name)).size,
    registryUpstreams.length,
  );
  const docker = registryUpstreams.find((u) => u.host === "docker.io")!;
  assertEquals(docker.upstream, "https://registry-1.docker.io");
  for (const u of registryUpstreams) {
    assert(u.upstream.startsWith("https://"), u.upstream);
    if (u.host !== "docker.io") assertEquals(u.upstream, `https://${u.host}`);
  }
});

test("registryContainerName / registryProxyUrl: valid docker names on port 5000", () => {
  for (const u of registryUpstreams) {
    const name = registryContainerName(u.name);
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name), name);
    assertEquals(registryProxyUrl(u.name), `http://${name}:5000`);
  }
  assertEquals(registryContainerName("docker"), "kind-registry-docker");
});

// ----------------------------------------------------------------------------
// versions.yaml
// ----------------------------------------------------------------------------
const VERSIONS_FIXTURE = `# Centralized version registry
charts:
  # renovate: datasource=helm depName=cilium registryUrl=https://helm.cilium.io/
  cilium: "1.19.5"
  onepassword-connect: "2.4.1"
images:
  curl: "8.22.0"
  kind-node: "v1.36.1"
tools:
  helm: "4.2.0"
`;

test("parseVersions: reads the three pins from a versions.yaml string", () => {
  assertEquals(parseVersions(VERSIONS_FIXTURE), {
    kindNode: "v1.36.1",
    cilium: "1.19.5",
    onepasswordConnect: "2.4.1",
  });
});

test("parseVersions: a missing pin names the key", () => {
  const err = assertThrows(
    () =>
      parseVersions(
        'charts:\n  cilium: "1.19.5"\nimages: {}\n',
        "versions.yaml",
      ),
    Error,
  );
  assertStringIncludes(err.message, "images.kind-node");
  const err2 = assertThrows(
    () => parseVersions("images:\n  kind-node: ''\n"),
    Error,
  );
  assertStringIncludes(err2.message, "images.kind-node");
});

test("kindNodeImage: kindest/node with a normalised v prefix", () => {
  assertEquals(kindNodeImage("v1.36.1"), "kindest/node:v1.36.1");
  assertEquals(kindNodeImage("1.36.1"), "kindest/node:v1.36.1");
  assertEquals(kindNodeImage(" v1.36.1\n"), "kindest/node:v1.36.1");
});

// ----------------------------------------------------------------------------
// Cilium values
// ----------------------------------------------------------------------------
test("extractCiliumValues: returns cilium.values as YAML", () => {
  const doc = `cilium:
  enabled: true
  chart:
    version: "1.19.5"
  values:
    ipam:
      mode: kubernetes
    kubeProxyReplacement: false
    hubble:
      enabled: false
`;
  const out = extractCiliumValues(doc)!;
  assert(out !== null);
  assertEquals(parseYaml(out), {
    ipam: { mode: "kubernetes" },
    kubeProxyReplacement: false,
    hubble: { enabled: false },
  });
  // Only the values map is emitted, never the surrounding Application config.
  assert(!out.includes("enabled: true"));
  assert(!out.includes("chart"));
});

test("extractCiliumValues: null when the key is absent, null or empty", () => {
  assertEquals(extractCiliumValues("cilium:\n  enabled: false\n"), null);
  assertEquals(extractCiliumValues("cilium:\n  values: null\n"), null);
  assertEquals(extractCiliumValues("cilium:\n  values: {}\n"), null);
  assertEquals(extractCiliumValues("cilium:\n  values: [a]\n"), null);
  assertEquals(extractCiliumValues("other: 1\n"), null);
});

test("DEFAULT_CILIUM_KIND_VALUES: matches the plan's Kind values", () => {
  const v = parseYaml(DEFAULT_CILIUM_KIND_VALUES) as Record<string, unknown>;
  assertEquals(v.ipam, { mode: "kubernetes" });
  assertEquals(v.kubeProxyReplacement, false);
  assertEquals(v.cni, { exclusive: false });
  assertEquals(v.socketLB, { hostNamespaceOnly: true });
  assertEquals((v.operator as Record<string, unknown>).replicas, 1);
  assertEquals(v.hubble, { enabled: false });
  assertEquals(v.image, { pullPolicy: "IfNotPresent" });
  assert("resources" in v);
});

// ----------------------------------------------------------------------------
// Cache dir
// ----------------------------------------------------------------------------
test("resolveCacheDir: explicit override, XDG, then ~/.cache", () => {
  assertEquals(
    resolveCacheDir({ HOMELAB_KIND_CACHE_DIR: "/tmp/kc" }, "/home/u"),
    "/tmp/kc",
  );
  assertEquals(
    resolveCacheDir({ XDG_CACHE_HOME: "/xdg" }, "/home/u"),
    "/xdg/homelab-kind-registry",
  );
  assertEquals(
    resolveCacheDir({}, "/home/u"),
    "/home/u/.cache/homelab-kind-registry",
  );
  // Empty values do not count as set.
  assertEquals(
    resolveCacheDir(
      { HOMELAB_KIND_CACHE_DIR: "  ", XDG_CACHE_HOME: "" },
      "/home/u",
    ),
    "/home/u/.cache/homelab-kind-registry",
  );
});

// ----------------------------------------------------------------------------
// Args
// ----------------------------------------------------------------------------
test("parseArgs: defaults and the context derived from the cluster", () => {
  const a = parseArgs(["up"]);
  assertEquals(a.command, "up");
  assertEquals(a.cluster, DEFAULT_CLUSTER);
  assertEquals(a.context, `kind-${DEFAULT_CLUSTER}`);
  assertEquals(a.dryRun, false);
  assertEquals(a.noRegistry, false);
  const b = parseArgs(["up", "--cluster", "foo", "--dry-run", "--no-registry"]);
  assertEquals(b.cluster, "foo");
  assertEquals(b.context, "kind-foo");
  assertEquals(b.dryRun, true);
  assertEquals(b.noRegistry, true);
  const c = parseArgs(["--cluster=foo", "--context=bar", "cilium"]);
  assertEquals(c.command, "cilium");
  assertEquals(c.context, "bar");
});

test("parseArgs: registry actions default to up", () => {
  assertEquals(parseArgs(["registry"]).registryAction, "up");
  assertEquals(parseArgs(["registry", "status"]).registryAction, "status");
  assertEquals(
    parseArgs(["registry", "down", "--dry-run"]).registryAction,
    "down",
  );
  assertThrows(
    () => parseArgs(["registry", "restart"]),
    UsageError,
    "registry action",
  );
});

test("parseArgs: down --purge-cache, and the flag is rejected elsewhere", () => {
  assertEquals(parseArgs(["down", "--purge-cache"]).purgeCache, true);
  assertThrows(
    () => parseArgs(["up", "--purge-cache"]),
    UsageError,
    "--purge-cache",
  );
});

test("parseArgs: usage errors", () => {
  assertThrows(() => parseArgs([]), UsageError, "missing subcommand");
  assertThrows(() => parseArgs(["reboot"]), UsageError, "Unknown subcommand");
  assertThrows(() => parseArgs(["up", "--bogus"]), UsageError, "Unknown flag");
  assertThrows(
    () => parseArgs(["up", "--cluster"]),
    UsageError,
    "requires a value",
  );
  assertThrows(
    () => parseArgs(["up", "--cluster", "--dry-run"]),
    UsageError,
    "requires a value",
  );
  assertThrows(
    () => parseArgs(["up", "extra"]),
    UsageError,
    "Unexpected argument",
  );
});

test("parseArgs: --help needs no subcommand", () => {
  assertEquals(parseArgs(["--help"]).help, true);
  assertEquals(parseArgs(["-h"]).help, true);
  assertEquals(parseArgs(["up", "--help"]).help, true);
});

// ----------------------------------------------------------------------------
// Display helpers
// ----------------------------------------------------------------------------
test("formatCommand: quotes only what the shell would mangle", () => {
  assertEquals(formatCommand(["kind", "get", "clusters"]), "kind get clusters");
  assertEquals(
    formatCommand([
      "docker",
      "exec",
      "-i",
      "n",
      "sh",
      "-c",
      "mkdir -p /a && cat > /a/b",
    ]),
    "docker exec -i n sh -c 'mkdir -p /a && cat > /a/b'",
  );
  assertEquals(formatCommand(["x", "it's"]), "x 'it'\\''s'");
});

test("formatStatusTable: aligned columns with a header", () => {
  const table = formatStatusTable([
    {
      name: "kind-registry-docker",
      upstream: "https://registry-1.docker.io",
      state: "running",
      size: "1.2G",
    },
    {
      name: "kind-registry-ghcr",
      upstream: "https://ghcr.io",
      state: "absent",
      size: "-",
    },
  ]);
  const lines = table.split("\n");
  assertEquals(lines.length, 3);
  assertStringIncludes(lines[0], "NAME");
  assertStringIncludes(lines[0], "CACHE");
  assertStringIncludes(lines[1], "running");
  assertEquals(lines[1].indexOf("https://"), lines[2].indexOf("https://"));
});

// ----------------------------------------------------------------------------
// Kind's bundled local-path-provisioner
// ----------------------------------------------------------------------------
test("kindBundledStorageObjects: only what the chart does not re-create by name", () => {
  // Names from kind v0.33.0 const_storage.go. The chart (containeroo
  // local-path-provisioner) names its RBAC objects `local-path-provisioner`
  // and its class `local-path`, so the bundled ones would otherwise linger.
  const refs = kindBundledStorageObjects.map(
    (o) => `${o.namespace ?? "-"}/${o.kind}/${o.name}`,
  );
  assertEquals(refs, [
    "local-path-storage/deployment/local-path-provisioner",
    "local-path-storage/serviceaccount/local-path-provisioner-service-account",
    "local-path-storage/role/local-path-provisioner-role",
    "local-path-storage/rolebinding/local-path-provisioner-bind",
    "-/clusterrole/local-path-provisioner-role",
    "-/clusterrolebinding/local-path-provisioner-bind",
    "-/storageclass/standard",
  ]);
  // Adopted by server-side apply, never deleted.
  assert(!refs.some((r) => r.includes("configmap")));
  assert(!refs.some((r) => r.includes("namespace/")));
});

test("kubectlDeleteArgs: one delete per namespace, --ignore-not-found for re-runs", () => {
  const args = kubectlDeleteArgs(kindBundledStorageObjects);
  assertEquals(args, [
    [
      "delete",
      "-n",
      "local-path-storage",
      "--ignore-not-found",
      "deployment/local-path-provisioner",
      "serviceaccount/local-path-provisioner-service-account",
      "role/local-path-provisioner-role",
      "rolebinding/local-path-provisioner-bind",
    ],
    [
      "delete",
      "--ignore-not-found",
      "clusterrole/local-path-provisioner-role",
      "clusterrolebinding/local-path-provisioner-bind",
      "storageclass/standard",
    ],
  ]);
  assertEquals(kubectlDeleteArgs([]), []);
});

// ----------------------------------------------------------------------------
// Generated fake Secrets
// ----------------------------------------------------------------------------
const STUBS = `---
apiVersion: v1
kind: Namespace
metadata:
  name: observability
---
apiVersion: v1
kind: Secret
metadata:
  name: clickhouse-otel
  namespace: observability
  annotations:
    homelab.local/generated-key: password
    homelab.local/generated-group: clickhouse-otel
---
apiVersion: v1
kind: Secret
metadata:
  name: clickhouse-grafana
  namespace: observability
  annotations:
    homelab.local/generated-key: password
    homelab.local/generated-group: clickhouse-grafana
---
apiVersion: v1
kind: Secret
metadata:
  name: clickhouse-grafana
  namespace: monitoring
  annotations:
    homelab.local/generated-key: password
    homelab.local/generated-group: clickhouse-grafana
---
apiVersion: v1
kind: Secret
metadata:
  name: plex
  namespace: media
stringData:
  plex-claim-token: claim-localdev
`;

test("generatedSecretStubs: only annotated Secrets, with key and group", () => {
  assertEquals(generatedSecretStubs(STUBS), [
    {
      namespace: "observability",
      name: "clickhouse-otel",
      key: "password",
      group: "clickhouse-otel",
    },
    {
      namespace: "observability",
      name: "clickhouse-grafana",
      key: "password",
      group: "clickhouse-grafana",
    },
    {
      namespace: "monitoring",
      name: "clickhouse-grafana",
      key: "password",
      group: "clickhouse-grafana",
    },
  ]);
});

test("generatedSecretStubs: an annotated Secret without a key is rejected", () => {
  assertThrows(() =>
    generatedSecretStubs(
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\n  namespace: y\n  annotations:\n    homelab.local/generated-group: g\n",
    ),
  );
});

test("assignGeneratedValues: one value per group, existing values win", () => {
  const stubs = generatedSecretStubs(STUBS);
  let n = 0;
  const values = assignGeneratedValues(
    stubs,
    { "monitoring/clickhouse-grafana": "kept" },
    () => `random-${++n}`,
  );
  assertEquals(values, {
    "observability/clickhouse-otel": "random-1",
    "observability/clickhouse-grafana": "kept",
    "monitoring/clickhouse-grafana": "kept",
  });
});
