#!/usr/bin/env -S bun test
/**
 * Every repository reference charts/gitops and charts/applications render
 * follows global.repoUrl, which the deploy path injects from GITOPS_REPO_URL
 * (Terraform helm.parameters in homelab, localdev-argocd.ts install in Kind).
 *
 * The committed values carry a REPLACEME placeholder, so level 0 and the
 * snapshots only ever exercise the example fork. These render at a second,
 * unrelated owner: a value that stops following the config shows up here as
 * the upstream account leaking back in, which a snapshot diff cannot catch.
 *
 *   bun test scripts/chart-repo-url_test.ts
 */

import { test } from "bun:test";
import { assert, assertEquals } from "./lib/assert.ts";

const OWNER = "astranger";
const REPO_URL = `https://github.com/${OWNER}/homelab`;
const CLONE_URL = `${REPO_URL}.git`;

function helmTemplate(args: string[]): string {
  const r = Bun.spawnSync(["helm", "template", ...args]);
  if (r.exitCode !== 0) {
    throw new Error(
      `helm template ${args.join(" ")} exited ${r.exitCode}:\n${r.stderr.toString()}`,
    );
  }
  return r.stdout.toString();
}

/** Every `repoURL:`/`repoUrl:` value in a rendered manifest stream. */
function repoRefs(manifests: string): string[] {
  return [...manifests.matchAll(/^\s*repoU[rR][lL]:\s*(\S+)$/gm)].map(
    (m) => m[1],
  );
}

test("charts/gitops: every Application, AppProject and ApplicationSet names the configured fork", () => {
  const out = helmTemplate([
    "gitops",
    "charts/gitops",
    "-f",
    "charts/gitops/values.yaml",
    "-f",
    "charts/gitops/values-homelab.yaml",
    "--set",
    `global.repoUrl=${REPO_URL}`,
    "--set",
    "previews.enabled=true",
  ]);

  // The app-of-apps root: bootstrap, addons, applications and the preview
  // Applications, plus the value bootstrap inherits for its own Application.
  const refs = repoRefs(out);
  assertEquals(refs.length, 5);
  for (const ref of refs) assertEquals(ref, CLONE_URL);

  // The preview AppProject's sourceRepos allowlist, and the ApplicationSet's
  // pull-request generator, which polls a repository by owner and name.
  assert(out.includes(`    - ${CLONE_URL}\n`), "sourceRepos misses the fork");
  assert(out.includes(`owner: ${OWNER}\n`), "preview generator misses owner");
  assert(out.includes("repo: homelab\n"), "preview generator misses repo");

  assertEquals(out.includes("ryanmcafee"), false);
  assertEquals(out.includes("REPLACEME"), false);
});

test("charts/applications: renovate onboards the configured fork, not the upstream repository", () => {
  const out = helmTemplate([
    "applications",
    "charts/applications",
    "-s",
    "templates/renovate.yaml",
    "--set",
    `global.repoUrl=${REPO_URL}`,
  ]);

  assert(
    out.includes(`"repositories": ["${OWNER}/homelab"]`),
    `renovate repositories does not follow global.repoUrl:\n${out}`,
  );
  assertEquals(out.includes("ryanmcafee"), false);
});

test("charts/gitops: a repoUrl naming no owner and repository fails the render", () => {
  let message = "";
  try {
    helmTemplate([
      "gitops",
      "charts/gitops",
      "-f",
      "charts/gitops/values.yaml",
      "-f",
      "charts/gitops/values-homelab.yaml",
      "--set",
      "global.repoUrl=homelab",
      "--set",
      "previews.enabled=true",
    ]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert(
    message.includes("names no <owner>/<repo>"),
    `expected the chart to refuse an unparseable repoUrl, got:\n${message}`,
  );
});
