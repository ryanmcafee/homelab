import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registryProxyUrl, registryUpstreams } from "./localdev-kind.ts";

const image = "registry.example.test/team/redis:broken";
const reason = `Failed to pull image "${image}": unexpected status from HEAD request to https://registry.example.test/v2/team/redis/manifests/broken: 429 Too Many Requests`;
const pods = [
  {
    metadata: { name: "redis-pull" },
    spec: {
      nodeName: "fixture-worker",
      containers: [{ name: "redis", image }],
    },
    status: {
      phase: "Pending",
      conditions: [{ type: "Ready", status: "False" }],
      containerStatuses: [
        {
          name: "redis",
          ready: false,
          state: {
            waiting: {
              reason: "ImagePullBackOff",
              message: "Back-off pulling image",
            },
          },
        },
      ],
    },
  },
  {
    metadata: { name: "readiness-gate" },
    spec: {
      nodeName: "fixture-worker",
      containers: [
        { name: "server", image: "registry.example.test/server:v1" },
      ],
    },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "False" }],
      containerStatuses: [{ name: "server", ready: true }],
    },
  },
  {
    metadata: { name: "unscheduled" },
    spec: {
      initContainers: [
        { name: "init", image: "registry.example.test/init:v2" },
      ],
    },
    status: { phase: "Pending" },
  },
  {
    metadata: { name: "healthy" },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ ready: true }],
    },
  },
];

/** Execute the real install entrypoint; only its external CLIs are fixtures. */
async function install(mode = "pull") {
  const dir = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "bootstrap-test-"),
  );
  const calls = join(dir, "calls.jsonl");
  const stub = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const tool = process.argv[1].split('/').pop();
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([tool, ...args]) + '\\n');
if (tool === 'helm') {
  if (args.includes('prometheus-operator-crds')) process.exit(0);
  console.error('ORIGINAL: helm bootstrap deadline exceeded'); process.exit(23);
}
if (${JSON.stringify(mode)} === 'commands-fail') { console.error('diagnostic access refused'); process.exit(41); }
if (tool === 'docker') { console.log('HTTP/1.1 200 OK\\n{}'); process.exit(0); }
if (args.includes('pods') && args.includes('json')) {
  console.log(${JSON.stringify(mode === "bad-json" ? "not json" : JSON.stringify({ items: pods }))}); process.exit(0);
}
if (args.includes('events')) {
  if (args.includes('involvedObject.name=redis-pull')) {
    if (${JSON.stringify(mode)} === 'event-fails') { console.error('event query failed'); process.exit(42); }
    console.log(${JSON.stringify(reason)});
  } else { console.log('later pod event remains visible'); }
  process.exit(0);
}
if (args.includes('nodes')) { console.log('fixture-worker'); process.exit(0); }
console.log('fixture diagnostic');
`;
  try {
    for (const tool of ["helm", "kubectl", "docker"]) {
      if (mode === "missing-kubectl" && tool === "kubectl") continue;
      const path = join(dir, tool);
      await writeFile(path, stub);
      await chmod(path, 0o755);
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "scripts/localdev-argocd.ts",
        "install",
        "--repo-root",
        resolve("."),
        "--revision",
        "fixture",
      ],
      {
        env: { ...process.env, PATH: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      output: stdout + stderr,
      code,
      calls: (await Bun.file(calls).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("bootstrap failure surfaces kubelet pull reason and every not-Ready pod", async () => {
  const result = await install();
  expect(result.code).toBe(1);
  expect(result.output).toContain(reason);
  expect(result.output).toContain(image);
  expect(result.output).toContain("ImagePullBackOff");
  expect(result.output).toContain("registry.example.test/init:v2");
  for (const name of ["redis-pull", "readiness-gate", "unscheduled"]) {
    expect(
      result.calls.some((args) => args.includes(`involvedObject.name=${name}`)),
    ).toBe(true);
  }
  expect(
    result.calls.some((args) => args.includes("involvedObject.name=healthy")),
  ).toBe(false);
  expect(result.output).toContain("ORIGINAL: helm bootstrap deadline exceeded");
  expect(result.output).toContain("helm upgrade --install exited 23");
  expect(result.calls.some((args) => args.includes("apply"))).toBe(false);
});

test("bootstrap probes mirror reachability inside the Kind node", async () => {
  const result = await install();
  expect(
    result.calls.some(
      (args) =>
        args[0] === "docker" &&
        args[1] === "exec" &&
        args[2] === "fixture-worker" &&
        args.includes("curl") &&
        args.some((arg) => arg.endsWith("/v2/")),
    ),
  ).toBe(true);
  expect(result.output).toContain("HTTP/1.1 200 OK");
});

for (const mode of ["commands-fail", "bad-json", "missing-kubectl"]) {
  test(`bootstrap retains original failure when diagnostics ${mode}`, async () => {
    const result = await install(mode);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "ORIGINAL: helm bootstrap deadline exceeded",
    );
    expect(result.output).toContain("helm upgrade --install exited 23");
    if (mode !== "missing-kubectl")
      expect(result.calls.some((args) => args[0] === "kubectl")).toBe(true);
    else expect(result.output).toContain("kubectl: command not found");
    expect(result.calls.some((args) => args.includes("apply"))).toBe(false);
  });
}

test("one pod event failure does not prevent later pod or mirror diagnostics", async () => {
  const result = await install("event-fails");
  expect(result.code).toBe(1);
  expect(result.output).toContain("event query failed");
  expect(result.output).toContain("later pod event remains visible");
  expect(result.output).toContain("HTTP/1.1 200 OK");
  expect(result.output).toContain("helm upgrade --install exited 23");
});

test("mirror probes follow configured upstreams and all reads pin the Kind context", async () => {
  const result = await install();
  for (const upstream of registryUpstreams) {
    expect(
      result.calls.some(
        (args) =>
          args[0] === "docker" &&
          args.includes(registryProxyUrl(upstream.name) + "/v2/"),
      ),
    ).toBe(true);
  }
  for (const args of result.calls.filter((args) => args[0] === "kubectl")) {
    expect(args.slice(1, 3)).toEqual(["--context", "kind-homelab-localdev"]);
  }
});
