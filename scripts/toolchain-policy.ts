#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

type ObjectMap = Record<string, unknown>;
const command =
  "set -o pipefail\ngit archive HEAD | docker build --no-cache --platform linux/amd64 --progress plain -f Dockerfile.toolchain -";

// Deliberately allowlist this tiny workflow: new execution surfaces need review.
export function checkBoundary(workflow: string, dockerfile: string): string[] {
  const errors: string[] = [];
  function object(value: unknown, label: string, keys: string[]): ObjectMap {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${label}: expected a mapping`);
      return {};
    }
    const result = value as ObjectMap;
    for (const key of Object.keys(result)) {
      if (!keys.includes(key)) errors.push(`${label}: unapproved field ${key}`);
    }
    return result;
  }
  function require(condition: boolean, message: string) {
    if (!condition) errors.push(message);
  }
  let parsed: unknown;
  try {
    parsed = load(workflow);
  } catch {
    return ["workflow: invalid YAML; fix parsing before boundary review"];
  }
  const root = object(parsed, "workflow", [
    "name",
    "on",
    "permissions",
    "concurrency",
    "jobs",
  ]);
  const permissions = object(root.permissions, "permissions", ["contents"]);
  require(permissions.contents ===
    "read", "permissions: use only contents: read");
  const events = object(root.on, "triggers", [
    "pull_request",
    "push",
    "workflow_dispatch",
  ]);
  require("pull_request" in
    events, "triggers: retain pull_request verification");
  const jobs = object(root.jobs, "jobs", ["cold-install"]);
  const job = object(jobs["cold-install"], "cold-install", [
    "runs-on",
    "timeout-minutes",
    "steps",
  ]);
  require(job["runs-on"] ===
    "ubuntu-latest", "cold-install: use the hosted ubuntu-latest runner");
  require(job["timeout-minutes"] ===
    20, "cold-install: retain the 20 minute timeout");
  const steps = Array.isArray(job.steps) ? job.steps : [];
  require(steps.length ===
    2, "steps: allow only checkout and literal Docker build; remove host mise/Task/cache steps");
  const checkout = object(steps[0], "checkout", ["uses", "with"]);
  require(typeof checkout.uses === "string" &&
    /^actions\/checkout@[a-f0-9]{40}$/.test(
      checkout.uses,
    ), "checkout: pin actions/checkout to a full commit SHA");
  const options = object(checkout.with, "checkout.with", [
    "persist-credentials",
  ]);
  require(options["persist-credentials"] ===
    false, "checkout: set persist-credentials: false");
  const build = object(steps[1], "build", ["name", "shell", "run"]);
  require(build.shell === "bash", "build: use bash with pipefail");
  require(typeof build.run === "string" &&
    build.run.trim() ===
      command, "build: use the literal pipefail git archive HEAD | docker build command; no credentials, caches, mounts, SSH, host networking or extra host execution");
  const instructions = dockerfile
    .replace(/\\\r?\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const bases = instructions.filter((line) => /^FROM\s/i.test(line));
  require(bases.length === 1 &&
    /^FROM ubuntu:24\.04@sha256:[a-f0-9]{64}$/.test(
      bases[0] ?? "",
    ), "Dockerfile: pin the single Ubuntu 24.04 base by verified SHA-256 digest");
  require(!instructions.some((line) =>
    /^(ARG|ADD)\s|--mount[=\s]|--network[=\s]|--security[=\s]/i.test(line),
  ), "Dockerfile: no build arguments, remote ADD, mounts or network/security entitlements");
  const download = instructions.findIndex((line) =>
    /^RUN curl .*\/mise\/releases\/download\//.test(line),
  );
  const verifiedDownload =
    /^RUN curl -fLsS https:\/\/github\.com\/jdx\/mise\/releases\/download\/v(\d+\.\d+\.\d+)\/mise-v\1-linux-x64 +-o \/usr\/local\/bin\/mise && +echo '[a-f0-9]{64} {2}\/usr\/local\/bin\/mise' \| sha256sum -c - && +chmod \+x \/usr\/local\/bin\/mise$/;
  require(download >= 0 &&
    verifiedDownload.test(
      instructions[download] ?? "",
    ), "Dockerfile: download versioned mise, verify SHA-256 successfully, then chmod using &&");
  require(!instructions
    .slice(0, download)
    .some((line) =>
      /\bmise\b/.test(line),
    ), "Dockerfile: never execute mise before checksum verification");
  return errors;
}

if (import.meta.main) {
  const errors = checkBoundary(
    readFileSync(".github/workflows/toolchain-bootstrap.yml", "utf8"),
    readFileSync("Dockerfile.toolchain", "utf8"),
  );
  for (const error of errors) console.error(`toolchain boundary: ${error}`);
  if (errors.length) process.exit(1);
  console.log("toolchain boundary: PASS");
}
