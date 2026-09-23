#!/usr/bin/env bun

/**
 * cmp-parity-test.ts
 *
 * ArgoCD CMP image parity test.
 *
 * Proves that the pinned `ghcr.io/ryanmcafee/homelab-cmp:<tag>` container image
 * (the sidecar `cmp/plugin.yaml` actually invokes in-cluster) produces the same
 * `homelab config export` output as the current Go source in this checkout, for
 * every format the CMP renders (helm-addons, helm-apps). If the image is stale —
 * source changed since the last `task cmp:bump` + image build/push — this test
 * fails loudly instead of ArgoCD silently syncing drifted manifests.
 *
 * Checks performed:
 *   1. The CMP image tag is consistent: charts/bootstrap/values.yaml's
 *      argocd.values.repoServer.initContainers[0].image and
 *      argocd.values.repoServer.extraContainers[0].image must both equal
 *      configuration/versions.yaml's images.homelab-cmp.
 *   2. For each of helm-addons / helm-apps, `homelab config export` run inside
 *      the pinned container (mirroring cmp/plugin.yaml's working directory and
 *      relative --config-root) must byte-for-byte match the same command run
 *      via `go run ./cmd/homelab` against the current source tree.
 *   3. `homelab --version` is captured from both sides for informational
 *      comparison (best-effort only — Dockerfile.cmp does not pass -ldflags, so
 *      both currently report "dev" regardless of source drift).
 *
 * Tag bumped in this change: cmp-image.yml pushes the image only on a merge to
 * main, so a PR that bumps images.homelab-cmp pins a tag that does not exist in
 * the registry yet and `docker pull` reports "manifest unknown". That is not
 * drift. When the pull fails that way, the pinned tag is compared with the base
 * ref's (--base-ref, default origin/main): a different tag means the bump is
 * part of this change and the check passes, the same tag means the image is
 * genuinely missing and it fails. Any other pull failure still fails.
 *
 * Usage:
 *   task test:cmp-parity
 *   bun scripts/cmp-parity-test.ts --help
 *   bun scripts/cmp-parity-test.ts --dry-run
 *   bun scripts/cmp-parity-test.ts --tag 0.1.8
 *   bun scripts/cmp-parity-test.ts --base-ref origin/main
 *   bun scripts/cmp-parity-test.ts --no-pull --keep-artifacts
 *
 * Exit codes: 0 = image matches source; 1 = mismatch (drift or tag inconsistency)
 *             or a check could not be completed; 2 = argument error.
 */

import {
  mkdtemp,
  readFile,
  rm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNotFound } from "./lib/errors.ts";
import { parse as parseYaml } from "./lib/yaml.ts";

// ============================================================================
// Logging
// ============================================================================
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.log(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.log(`${green("OK")}    ${msg}`),
  warn: (msg: string) => console.log(`${yellow("WARN")}  ${msg}`),
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
};

// ============================================================================
// Constants
// ============================================================================
const IMAGE_REPO = "ghcr.io/ryanmcafee/homelab-cmp";
const DEFAULT_BASE_REF = "origin/main";
const BOOTSTRAP_VALUES = "charts/bootstrap/values.yaml";
const VERSIONS_YAML = "configuration/versions.yaml";
const ENV_FILE_REL = "configuration/environments/homelab.yaml.example";
const CONFIG_ROOT_REL = "configuration";
type ExportFormat = "helm-addons" | "helm-apps";
interface FormatSpec {
  format: ExportFormat;
  chartDir: string; // relative to repo root, e.g. charts/addons
}
const FORMATS: FormatSpec[] = [
  { format: "helm-addons", chartDir: "charts/addons" },
  { format: "helm-apps", chartDir: "charts/applications" },
];

// ============================================================================
// CLI args
// ============================================================================
interface Args {
  help: boolean;
  dryRun: boolean;
  tag: string | null;
  noPull: boolean;
  keepArtifacts: boolean;
  baseRef: string;
  platform: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    dryRun: false,
    tag: null,
    noPull: false,
    keepArtifacts: false,
    baseRef: DEFAULT_BASE_REF,
    platform: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-pull") args.noPull = true;
    else if (a === "--keep-artifacts") args.keepArtifacts = true;
    else if (a === "--tag") {
      const v = argv[i + 1];
      if (!v) {
        log.error("--tag requires a value");
        process.exit(2);
      }
      args.tag = v;
      i++;
    } else if (a.startsWith("--tag=")) {
      args.tag = a.slice("--tag=".length);
    } else if (a === "--base-ref") {
      const v = argv[i + 1];
      if (!v) {
        log.error("--base-ref requires a value");
        process.exit(2);
      }
      args.baseRef = v;
      i++;
    } else if (a.startsWith("--base-ref=")) {
      args.baseRef = a.slice("--base-ref=".length);
    } else if (a === "--platform") {
      const v = argv[i + 1];
      if (!v) {
        log.error("--platform requires a value");
        process.exit(2);
      }
      args.platform = v;
      i++;
    } else if (a.startsWith("--platform=")) {
      args.platform = a.slice("--platform=".length);
    } else {
      log.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`cmp-parity-test.ts — ArgoCD CMP image parity test

Proves the pinned CMP container image (ghcr.io/ryanmcafee/homelab-cmp:<tag>)
produces the same \`homelab config export\` output as the current Go source,
for every format the CMP renders (helm-addons, helm-apps).

Usage:
  task test:cmp-parity
  bun scripts/cmp-parity-test.ts [flags]

Flags:
  --help, -h         Show this help and exit 0
  --dry-run          Print the planned checks and exit 0 (no docker/go invoked)
  --tag <tag>        Override the image tag to test (default: read from
                      ${BOOTSTRAP_VALUES} / ${VERSIONS_YAML})
  --base-ref <ref>   Git ref to compare the pinned tag against when the image
                      is not in the registry yet (default: ${DEFAULT_BASE_REF})
  --platform <p>     Pass --platform to docker pull/run. The CMP image is built
                      linux/amd64 only, so an arm64 workstation needs
                      --platform linux/amd64 (CI runs amd64 and needs nothing)
  --no-pull          Skip \`docker pull\` (use whatever image is already local)
  --keep-artifacts   Do not delete the temp artifact dir on exit

Exit codes:
  0  Image output matches source for every format; tags consistent. Also 0 when
     the pinned tag does not exist in the registry yet *and* it differs from
     --base-ref's tag, i.e. this change bumped it and cmp-image.yml will build
     it on merge.
  1  Drift detected, tag inconsistency, the pinned tag is missing from the
     registry without having been bumped, or a check could not run (e.g. no
     Docker daemon)
  2  Argument error
`);
}

// ============================================================================
// Shell helper
// ============================================================================
async function run(
  cmd: string[],
  opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { stdout, stderr, code };
}

async function writeFile(path: string, content: string): Promise<void> {
  await fsWriteFile(path, content);
}

async function unifiedDiff(
  expectedPath: string,
  actualPath: string,
): Promise<string> {
  const r = await run(["diff", "-u", expectedPath, actualPath]);
  // diff exits 1 when files differ — that's the expected case here.
  return r.stdout || r.stderr || "(no diff output)";
}

// ============================================================================
// Repo root discovery
// ============================================================================
async function findRepoRoot(): Promise<string> {
  const r = await run(["git", "rev-parse", "--show-toplevel"]);
  if (r.code !== 0) {
    throw new Error(`git rev-parse --show-toplevel failed:\n${r.stderr}`);
  }
  return r.stdout.trim();
}

// ============================================================================
// YAML helpers
// ============================================================================
// biome-ignore lint/suspicious/noExplicitAny: walks arbitrary parsed YAML
function dig(obj: any, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur === undefined || cur === null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function tagOf(image: string): string {
  const idx = image.lastIndexOf(":");
  if (idx < 0) {
    throw new Error(`image reference has no tag: ${image}`);
  }
  return image.slice(idx + 1);
}

interface TagCheck {
  ok: boolean;
  initImage: string;
  extraImage: string;
  versionsTag: string;
  detail?: string;
}

async function checkImageTagConsistency(repoRoot: string): Promise<TagCheck> {
  const bootstrapText = await readFile(
    `${repoRoot}/${BOOTSTRAP_VALUES}`,
    "utf8",
  );
  const bootstrap = parseYaml(bootstrapText);
  const initContainers = dig(bootstrap, [
    "argocd",
    "values",
    "repoServer",
    "initContainers",
  ]) as Array<{ image?: string }> | undefined;
  const extraContainers = dig(bootstrap, [
    "argocd",
    "values",
    "repoServer",
    "extraContainers",
  ]) as Array<{ image?: string }> | undefined;

  const initImg = initContainers?.[0]?.image;
  const extraImg = extraContainers?.[0]?.image;
  if (!initImg || !extraImg) {
    return {
      ok: false,
      initImage: initImg ?? "(missing)",
      extraImage: extraImg ?? "(missing)",
      versionsTag: "",
      detail: `Could not find argocd.values.repoServer.{initContainers[0],extraContainers[0]}.image in ${BOOTSTRAP_VALUES}`,
    };
  }

  const versionsText = await readFile(`${repoRoot}/${VERSIONS_YAML}`, "utf8");
  const versions = parseYaml(versionsText);
  const versionsTag = dig(versions, ["images", "homelab-cmp"]) as
    | string
    | undefined;
  if (!versionsTag) {
    return {
      ok: false,
      initImage: initImg,
      extraImage: extraImg,
      versionsTag: "(missing)",
      detail: `Could not find images.homelab-cmp in ${VERSIONS_YAML}`,
    };
  }

  const initTag = tagOf(initImg);
  const extraTag = tagOf(extraImg);
  if (initTag !== versionsTag || extraTag !== versionsTag) {
    return {
      ok: false,
      initImage: initImg,
      extraImage: extraImg,
      versionsTag,
      detail:
        `Tag mismatch: ${BOOTSTRAP_VALUES} initContainers[0]=${initTag}, extraContainers[0]=${extraTag}, ` +
        `but ${VERSIONS_YAML} images.homelab-cmp=${versionsTag}`,
    };
  }

  return { ok: true, initImage: initImg, extraImage: extraImg, versionsTag };
}

// ============================================================================
// Docker helpers
// ============================================================================
async function dockerAvailable(): Promise<boolean> {
  const r = await run(["docker", "info"]);
  return r.code === 0;
}

/** platformArgs renders the optional --platform flag for a docker invocation. */
function platformArgs(platform: string | null): string[] {
  return platform ? ["--platform", platform] : [];
}

async function dockerPull(
  image: string,
  platform: string | null,
): Promise<{ stdout: string; stderr: string; code: number }> {
  log.info(
    `Pulling ${image}${platform ? ` (--platform ${platform})` : ""} ...`,
  );
  return await run(["docker", "pull", ...platformArgs(platform), image]);
}

/**
 * Reports whether a `docker pull` failure means "this tag does not exist in the
 * registry" rather than a transport, auth or daemon problem.
 *
 * The wording depends on the daemon and the registry, so every shape seen in
 * practice is matched:
 *   - "manifest unknown" — registry API v2, and GHCR's
 *     "manifest for <ref> not found: manifest unknown"
 *   - 'failed to resolve reference "<ref>": <ref>: not found' — the
 *     containerd-backed image store (Docker 25+; Docker 29.2 produces exactly
 *     this and nothing else, which is why the first two patterns alone let a
 *     bumped tag read as a hard failure)
 *
 * Deliberately NOT matched: "denied", "unauthorized", and docker's
 * "repository does not exist or may require 'docker login'". Those are
 * ambiguous between "absent" and "no credentials", and a missing-credentials
 * run must fail rather than be excused as a bumped tag.
 */
export function isUnknownTagError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  // A platform mismatch also ends in "not found" ("no matching manifest for
  // linux/arm64/v8 ... : not found"), but the tag exists — it just has no
  // build for this architecture. Excusing it would report a present image as
  // absent, so it is ruled out first.
  if (isPlatformMismatchError(stderr)) return false;
  if (s.includes("manifest unknown")) return true;
  if (s.includes("manifest for") && s.includes("not found")) return true;
  if (s.includes("failed to resolve reference") && s.includes("not found")) {
    return true;
  }
  return false;
}

/**
 * Reports whether a `docker pull` failure means the tag exists but has no image
 * for the daemon's architecture. The CMP image is built by cmp-image.yml on an
 * ubuntu runner without a `platforms:` list, so it is linux/amd64 only, and a
 * pull on an arm64 workstation fails this way. The fix is --platform, not a
 * rebuild, so it gets its own message.
 */
export function isPlatformMismatchError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("no match for platform") ||
    s.includes("no matching manifest for")
  );
}

export type MissingTagDecision = "bumped" | "missing";

/**
 * Decides what a missing image tag means.
 *
 * cmp-image.yml pushes the image only on a merge to main, so a PR that bumps
 * images.homelab-cmp necessarily pins a tag the registry does not have yet.
 * That is the bump working as designed, not drift, and parity is verified on
 * main by the next run. The same tag missing, however, means the image was
 * never built and the cluster would pull nothing — a real failure.
 *
 * A base tag of null (the ref could not be read) is treated as "missing": this
 * check must not pass because it could not find out.
 */
export function decideMissingTag(opts: {
  pinned: string;
  base: string | null;
}): MissingTagDecision {
  const base = opts.base?.trim();
  if (!base) return "missing";
  return opts.pinned.trim() === base ? "missing" : "bumped";
}

/**
 * Reads images.homelab-cmp from a git ref's configuration/versions.yaml.
 * Returns null when the ref (or the key) is unavailable; the caller treats that
 * as a failure rather than a pass.
 */
async function baseRefCmpTag(
  repoRoot: string,
  baseRef: string,
): Promise<string | null> {
  const r = await run(["git", "show", `${baseRef}:${VERSIONS_YAML}`], {
    cwd: repoRoot,
  });
  if (r.code !== 0) {
    log.warn(
      `could not read ${VERSIONS_YAML} at ${baseRef}: ${
        r.stderr.trim() || `exit ${r.code}`
      }`,
    );
    return null;
  }
  try {
    const tag = dig(parseYaml(r.stdout), ["images", "homelab-cmp"]);
    return typeof tag === "string" && tag.trim() !== "" ? tag.trim() : null;
  } catch (err) {
    log.warn(
      `could not parse ${VERSIONS_YAML} at ${baseRef}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Runs `homelab config export` inside the pinned CMP container, mirroring the
 * working directory and relative --config-root that cmp/plugin.yaml actually
 * uses (CONFIG_ROOT="../../configuration" from inside charts/<x>/), so that a
 * working-directory or relative-path assumption drift is caught too — not just
 * source vs. binary drift.
 */
async function exportFromContainer(
  image: string,
  repoRoot: string,
  spec: FormatSpec,
  platform: string | null,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await run([
    "docker",
    "run",
    "--rm",
    ...platformArgs(platform),
    "--entrypoint",
    "homelab",
    "-v",
    `${repoRoot}:/repo:ro`,
    "-w",
    `/repo/${spec.chartDir}`,
    image,
    "config",
    "export",
    "--set",
    "homelab",
    "--format",
    spec.format,
    "--env-file",
    `/repo/${ENV_FILE_REL}`,
    "--config-root",
    "../../configuration",
    "--stdout",
  ]);
}

async function exportFromSource(
  repoRoot: string,
  spec: FormatSpec,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await run(
    [
      "go",
      "run",
      "./cmd/homelab",
      "config",
      "export",
      "--set",
      "homelab",
      "--format",
      spec.format,
      "--env-file",
      ENV_FILE_REL,
      "--config-root",
      CONFIG_ROOT_REL,
      "--stdout",
    ],
    { cwd: repoRoot },
  );
}

async function containerVersion(
  image: string,
  platform: string | null,
): Promise<string> {
  const r = await run([
    "docker",
    "run",
    "--rm",
    ...platformArgs(platform),
    "--entrypoint",
    "homelab",
    image,
    "--version",
  ]);
  return r.code === 0
    ? r.stdout.trim()
    : `(error: ${r.stderr.trim() || r.code})`;
}

async function sourceVersion(repoRoot: string): Promise<string> {
  const r = await run(["go", "run", "./cmd/homelab", "--version"], {
    cwd: repoRoot,
  });
  return r.code === 0
    ? r.stdout.trim()
    : `(error: ${r.stderr.trim() || r.code})`;
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return 0;
  }

  const repoRoot = await findRepoRoot();

  if (args.dryRun) {
    log.info("Dry-run mode — listing planned checks and exiting.");
    console.log(
      `  - assert ${BOOTSTRAP_VALUES} init/extraContainers[0].image tag == ${VERSIONS_YAML} images.homelab-cmp`,
    );
    for (const spec of FORMATS) {
      console.log(
        `  - compare \`docker run ... -w /repo/${spec.chartDir} ${IMAGE_REPO}:<tag> config export --format ${spec.format} --stdout\` vs \`go run ./cmd/homelab config export --format ${spec.format} --stdout\``,
      );
    }
    console.log(
      `  - capture \`homelab --version\` from both sides (informational)`,
    );
    console.log(
      `  - if the tag is not in the registry, compare it with ${args.baseRef}'s images.homelab-cmp`,
    );
    return 0;
  }

  log.info(`Repo root: ${repoRoot}`);

  const tagCheck = await checkImageTagConsistency(repoRoot);
  if (!tagCheck.ok) {
    log.error(tagCheck.detail ?? "CMP image tag consistency check failed");
    return 1;
  }
  const tag = args.tag ?? tagCheck.versionsTag;
  const image = `${IMAGE_REPO}:${tag}`;
  log.ok(
    `Tag consistent across ${BOOTSTRAP_VALUES} and ${VERSIONS_YAML}: ${tagCheck.versionsTag}`,
  );
  if (args.tag) {
    log.info(
      `Using --tag override: ${tag} (source of truth reports ${tagCheck.versionsTag})`,
    );
  }

  if (!(await dockerAvailable())) {
    log.error(
      "Docker daemon is not reachable (`docker info` failed). Cannot run the live parity check.",
    );
    return 1;
  }

  if (!args.noPull) {
    const pull = await dockerPull(image, args.platform);
    if (pull.code !== 0) {
      if (isPlatformMismatchError(pull.stderr)) {
        log.error(
          `image ${image} exists but has no build for this machine's architecture. ` +
            `cmp-image.yml builds linux/amd64 only, so re-run with --platform linux/amd64 ` +
            `(CI runs on amd64 and needs no flag):\n${pull.stderr}`,
        );
        return 1;
      }
      if (!isUnknownTagError(pull.stderr)) {
        log.error(`docker pull ${image} failed:\n${pull.stderr}`);
        return 1;
      }
      const baseTag = await baseRefCmpTag(repoRoot, args.baseRef);
      if (decideMissingTag({ pinned: tag, base: baseTag }) === "bumped") {
        log.ok(
          `tag ${tag} is bumped in this change (base: ${baseTag}); the image is built by cmp-image.yml on merge and parity is verified on main`,
        );
        return 0;
      }
      log.error(
        `image ${image} is not in the registry and the tag matches ${args.baseRef} (${
          baseTag ?? "unreadable"
        }), so nothing bumped it: run \`task cmp:bump\` and let cmp-image.yml build it`,
      );
      return 1;
    }
  } else {
    log.info(`--no-pull set; using local image ${image} as-is`);
  }

  const artifactRoot = await mkdtemp(join(tmpdir(), "cmp-parity-test-"));
  log.info(`Artifact root: ${artifactRoot}`);

  let anyMismatch = false;
  const diffs: string[] = [];

  for (const spec of FORMATS) {
    log.info(
      `Comparing format ${spec.format} (chart dir ${spec.chartDir}) ...`,
    );

    const [containerResult, sourceResult] = await Promise.all([
      exportFromContainer(image, repoRoot, spec, args.platform),
      exportFromSource(repoRoot, spec),
    ]);

    if (containerResult.code !== 0) {
      log.error(
        `container export (${spec.format}) failed:\n${containerResult.stderr}`,
      );
      anyMismatch = true;
      continue;
    }
    if (sourceResult.code !== 0) {
      log.error(
        `source export (${spec.format}) failed:\n${sourceResult.stderr}`,
      );
      anyMismatch = true;
      continue;
    }

    if (containerResult.stdout === sourceResult.stdout) {
      log.ok(`${spec.format}: container output matches source, byte-for-byte`);
      continue;
    }

    anyMismatch = true;
    const sourcePath = `${artifactRoot}/${spec.format}.source.yaml`;
    const containerPath = `${artifactRoot}/${spec.format}.container.yaml`;
    await writeFile(sourcePath, sourceResult.stdout);
    await writeFile(containerPath, containerResult.stdout);
    const diff = await unifiedDiff(sourcePath, containerPath);
    log.error(`${spec.format}: MISMATCH between source and container output`);
    diffs.push(`--- ${spec.format} (source vs container) ---\n${diff}`);
  }

  // Informational version comparison — best-effort only. Dockerfile.cmp does
  // not pass -ldflags at build time, so both sides currently print "dev"
  // regardless of source drift; this does not gate the exit code.
  const [cVersion, sVersion] = await Promise.all([
    containerVersion(image, args.platform),
    sourceVersion(repoRoot),
  ]);
  log.info(`homelab --version (container): ${cVersion}`);
  log.info(`homelab --version (source):    ${sVersion}`);
  if (cVersion !== sVersion) {
    log.warn(
      "version strings differ, but this build does not embed -ldflags version info, so this is not authoritative for drift detection",
    );
  }

  if (!args.keepArtifacts) {
    try {
      await rm(artifactRoot, { recursive: true });
    } catch (err) {
      if (!isNotFound(err)) {
        log.warn(
          `post-run cleanup of ${artifactRoot} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } else {
    log.info(`Artifacts retained at ${artifactRoot}`);
  }

  if (anyMismatch) {
    for (const d of diffs) console.log(d);
    log.error(
      `CMP image ${tag} lags source: run \`task cmp:bump\` and merge the image build`,
    );
    return 1;
  }

  log.ok(
    `CMP image ${tag} matches source for all formats (helm-addons, helm-apps)`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
