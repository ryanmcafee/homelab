#!/usr/bin/env -S deno run --allow-net --allow-run --allow-env --allow-read --allow-write

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
 * Usage:
 *   task test:cmp-parity
 *   deno run ... scripts/cmp-parity-test.ts --help
 *   deno run ... scripts/cmp-parity-test.ts --dry-run
 *   deno run ... scripts/cmp-parity-test.ts --tag 0.1.8
 *   deno run ... scripts/cmp-parity-test.ts --no-pull --keep-artifacts
 *
 * Exit codes: 0 = image matches source; 1 = mismatch (drift or tag inconsistency)
 *             or a check could not be completed; 2 = argument error.
 */

import { parse as parseYaml } from "jsr:@std/yaml@^1";

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
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    dryRun: false,
    tag: null,
    noPull: false,
    keepArtifacts: false,
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
        Deno.exit(2);
      }
      args.tag = v;
      i++;
    } else if (a.startsWith("--tag=")) {
      args.tag = a.slice("--tag=".length);
    } else {
      log.error(`Unknown argument: ${a}`);
      Deno.exit(2);
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
  deno run --allow-net --allow-run --allow-env --allow-read --allow-write \\
    scripts/cmp-parity-test.ts [flags]

Flags:
  --help, -h         Show this help and exit 0
  --dry-run          Print the planned checks and exit 0 (no docker/go invoked)
  --tag <tag>        Override the image tag to test (default: read from
                      ${BOOTSTRAP_VALUES} / ${VERSIONS_YAML})
  --no-pull          Skip \`docker pull\` (use whatever image is already local)
  --keep-artifacts   Do not delete the temp artifact dir on exit

Exit codes:
  0  Image output matches source for every format; tags consistent
  1  Drift detected, tag inconsistency, or a check could not run (e.g. no
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
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await p.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

async function writeFile(path: string, content: string): Promise<void> {
  await Deno.writeTextFile(path, content);
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
// deno-lint-ignore no-explicit-any
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
  const bootstrapText = await Deno.readTextFile(
    `${repoRoot}/${BOOTSTRAP_VALUES}`,
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
      detail:
        `Could not find argocd.values.repoServer.{initContainers[0],extraContainers[0]}.image in ${BOOTSTRAP_VALUES}`,
    };
  }

  const versionsText = await Deno.readTextFile(`${repoRoot}/${VERSIONS_YAML}`);
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

async function dockerPull(image: string): Promise<void> {
  log.info(`Pulling ${image} ...`);
  const r = await run(["docker", "pull", image]);
  if (r.code !== 0) {
    throw new Error(`docker pull ${image} failed:\n${r.stderr}`);
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
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await run([
    "docker",
    "run",
    "--rm",
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

async function containerVersion(image: string): Promise<string> {
  const r = await run([
    "docker",
    "run",
    "--rm",
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
  const args = parseArgs(Deno.args);

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
    `Tag consistent across ${BOOTSTRAP_VALUES} and ${VERSIONS_YAML}: ${tag}`,
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
    try {
      await dockerPull(image);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  } else {
    log.info(`--no-pull set; using local image ${image} as-is`);
  }

  const artifactRoot = await Deno.makeTempDir({ prefix: "cmp-parity-test-" });
  log.info(`Artifact root: ${artifactRoot}`);

  let anyMismatch = false;
  const diffs: string[] = [];

  for (const spec of FORMATS) {
    log.info(
      `Comparing format ${spec.format} (chart dir ${spec.chartDir}) ...`,
    );

    const [containerResult, sourceResult] = await Promise.all([
      exportFromContainer(image, repoRoot, spec),
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
    containerVersion(image),
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
      await Deno.remove(artifactRoot, { recursive: true });
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
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
    Deno.exit(await main());
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
