#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARGOCD_CHART,
  ARGOCD_HELM_REPO,
  ARGOCD_NAMESPACE,
  ARGOCD_RELEASE,
  ARGOCD_VALUES,
  VERSIONS_YAML,
  chartVersionFromVersions,
} from "./localdev-argocd.ts";
import { parseAll } from "./lib/yaml.ts";
import { pullChart } from "./upstream-values-check.ts";

/**
 * argocd-images.ts
 *
 * Records every image the localdev ArgoCD install pulls, rendered from the
 * argo-cd chart pinned at configuration/versions.yaml charts.argocd with
 * localdev/values/argocd-values.yaml, into ARGOCD_IMAGES_FILE.
 *
 * ArgoCD is installed before any Application exists, so an image host with no
 * Kind pull-through cache fails the whole level-2 job. Level 0 has no network
 * and cannot render the chart, so it reads this committed file instead:
 * localdev-kind_test.ts fails when the file's chart version is not the pinned
 * one (a bump nobody regenerated) or when an image host has no cache. The
 * file is a renovate-regen.ts generated path, so a Renovate bump of the chart
 * regenerates it on its own PR.
 *
 *   bun scripts/argocd-images.ts      (task localdev:argocd:images)
 */

export const ARGOCD_IMAGES_FILE = "localdev/argocd-images.json";

export interface ArgocdImages {
  chart: string;
  version: string;
  images: string[];
}

/** The registry host of an image reference, with docker's defaulting. */
export function imageHost(ref: string): string {
  const slash = ref.indexOf("/");
  if (slash < 0) return "docker.io";
  const first = ref.slice(0, slash);
  return first.includes(".") || first.includes(":") || first === "localhost"
    ? first
    : "docker.io";
}

const CONTAINER_LISTS = new Set([
  "containers",
  "initContainers",
  "ephemeralContainers",
]);

function collectImages(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectImages(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (CONTAINER_LISTS.has(key) && Array.isArray(value)) {
      for (const container of value) {
        const image: unknown = container?.image;
        if (typeof image === "string") out.add(image);
      }
    } else collectImages(value, out);
  }
}

/** Every distinct container image in a rendered multi-document manifest, sorted. */
export function renderedImages(manifest: string): string[] {
  const out = new Set<string>();
  for (const doc of parseAll(manifest)) collectImages(doc, out);
  return [...out].sort();
}

/** The distinct registry hosts of a list of image references, sorted. */
export function imageHosts(images: string[]): string[] {
  return [...new Set(images.map(imageHost))].sort();
}

export function formatArgocdImages(record: ArgocdImages): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

async function helmTemplate(
  chartDir: string,
  repoRoot: string,
): Promise<string> {
  const proc = Bun.spawn(
    [
      "helm",
      "template",
      ARGOCD_RELEASE,
      chartDir,
      "--namespace",
      ARGOCD_NAMESPACE,
      "-f",
      ARGOCD_VALUES,
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `helm template ${ARGOCD_CHART} exited ${code}: ${stderr.trim()}`,
    );
  }
  return stdout;
}

export async function main(repoRoot = process.cwd()): Promise<number> {
  const version = chartVersionFromVersions(
    readFileSync(join(repoRoot, VERSIONS_YAML), "utf8"),
    "argocd",
  );
  const workdir = mkdtempSync(join(tmpdir(), "argocd-images-"));
  try {
    const pulled = await pullChart(
      {
        env: "localdev",
        app: ARGOCD_RELEASE,
        values: {},
        chart: ARGOCD_CHART,
        repoURL: ARGOCD_HELM_REPO,
        targetRevision: version,
      },
      workdir,
    );
    if ("error" in pulled) {
      console.error(
        `FAIL helm pull ${ARGOCD_CHART} ${version} from ${ARGOCD_HELM_REPO}: ${pulled.error}`,
      );
      return 1;
    }
    const images = renderedImages(await helmTemplate(pulled.dir, repoRoot));
    if (images.length === 0) {
      console.error(
        `FAIL helm template ${ARGOCD_CHART} ${version} rendered no images; refusing to record an empty list`,
      );
      return 1;
    }
    writeFileSync(
      join(repoRoot, ARGOCD_IMAGES_FILE),
      formatArgocdImages({ chart: ARGOCD_CHART, version, images }),
    );
    console.log(
      `PASS ${ARGOCD_IMAGES_FILE}: ${ARGOCD_CHART} ${version}, ${images.length} images from ${imageHosts(images).join(", ")}`,
    );
    return 0;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exit(await main());
}
