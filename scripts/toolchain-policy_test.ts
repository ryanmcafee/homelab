import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dump, load } from "js-yaml";
import { checkBoundary } from "./toolchain-policy";

const workflow = readFileSync(
  new URL("../.github/workflows/toolchain-bootstrap.yml", import.meta.url),
  "utf8",
);
const dockerfile = readFileSync(
  new URL("../Dockerfile.toolchain", import.meta.url),
  "utf8",
);

test("committed workflow and Dockerfile satisfy the boundary", () => {
  expect(checkBoundary(workflow, dockerfile)).toEqual([]);
});

const mutations: [string, (text: string) => string][] = [
  ["write token", (s) => s.replace("contents: read", "contents: write")],
  [
    "credential persistence",
    (s) => s.replace("persist-credentials: false", "persist-credentials: true"),
  ],
  [
    "floating checkout",
    (s) => s.replace(/actions\/checkout@[a-f0-9]+/, "actions/checkout@main"),
  ],
  [
    "old host Task step",
    (s) =>
      s.replace(
        "git archive HEAD | docker build --no-cache --platform linux/amd64 --progress plain -f Dockerfile.toolchain -",
        "task toolchain:check",
      ),
  ],
  [
    "host mise action",
    (s) => `${s}\n      - uses: jdx/mise-action@${"a".repeat(40)}\n`,
  ],
  [
    "cache action",
    (s) => `${s}\n      - uses: actions/cache@${"a".repeat(40)}\n`,
  ],
  [
    "secret forwarding",
    (s) =>
      s.replace(
        "docker build --no-cache",
        "docker build --secret id=example --no-cache",
      ),
  ],
  [
    "socket mount",
    (s) =>
      s.replace(
        "docker build --no-cache",
        "docker build --mount /var/run/docker.sock --no-cache",
      ),
  ],
  [
    "SSH forwarding",
    (s) =>
      s.replace(
        "docker build --no-cache",
        "docker build --ssh default --no-cache",
      ),
  ],
  [
    "host network",
    (s) =>
      s.replace(
        "docker build --no-cache",
        "docker build --network host --no-cache",
      ),
  ],
  [
    "build credential argument",
    (s) =>
      s.replace(
        "docker build --no-cache",
        "docker build --build-arg TOKEN=sentinel --no-cache",
      ),
  ],
  ["no pipefail", (s) => s.replace("set -o pipefail", "set +o pipefail")],
  [
    "workflow token environment",
    (s) => `${s}\nenv:\n  TOKEN: harmless-sentinel\n`,
  ],
  [
    "privileged runner",
    (s) => s.replace("runs-on: ubuntu-latest", "runs-on: self-hosted"),
  ],
  [
    "write-all permissions",
    (s) =>
      s.replace("permissions:\n  contents: read", "permissions: write-all"),
  ],
  [
    "pull_request_target",
    (s) => s.replace("pull_request:", "pull_request_target:"),
  ],
];
for (const [name, mutate] of mutations) {
  test(`reject ${name}`, () => {
    expect(checkBoundary(mutate(workflow), dockerfile).length).toBeGreaterThan(
      0,
    );
  });
}
for (const [name, mutate] of [
  ["mutable base", (s: string) => s.replace(/@sha256:[a-f0-9]{64}/, "")],
  [
    "checksum ignored",
    (s: string) => s.replace("sha256sum -c - &&", "sha256sum -c -;"),
  ],
  [
    "chmod before check",
    (s: string) =>
      s.replace(
        "RUN curl -fLsS",
        "RUN chmod +x /usr/local/bin/mise && curl -fLsS",
      ),
  ],
  ["mise before download", (s: string) => `RUN mise --version\n${s}`],
  [
    "secret mount",
    (s: string) => `${s}\nRUN --mount=type=secret,id=sentinel true\n`,
  ],
] as const) {
  test(`reject Dockerfile ${name}`, () => {
    expect(checkBoundary(workflow, mutate(dockerfile)).length).toBeGreaterThan(
      0,
    );
  });
}
test("parsed YAML allows formatting changes", () => {
  expect(checkBoundary(dump(load(workflow)), dockerfile)).toEqual([]);
});
test("malformed YAML fails loudly", () => {
  expect(checkBoundary("jobs: [", dockerfile)).toEqual([
    "workflow: invalid YAML; fix parsing before boundary review",
  ]);
});
