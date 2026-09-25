import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { WorkflowManifest } from "./workflow.ts";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const TIMEOUT_MS = 15_000;

export interface WorkflowClient {
  create(manifest: WorkflowManifest): Promise<string>;
  /** Names of workflows matching the selector that have not completed. */
  listActive(namespace: string, labelSelector: string): Promise<string[]>;
}

const createdSchema = z.object({ metadata: z.object({ name: z.string() }) });
const listSchema = z.object({
  items: z.array(z.object({ metadata: z.object({ name: z.string() }) })),
});

export interface HttpClientOptions {
  baseUrl: string;
  /** Read per request: projected ServiceAccount tokens rotate. */
  token: () => string;
  ca?: string;
  fetch?: typeof fetch;
}

/** Workflows through the Kubernetes API (RBAC: create/get/list on workflows). */
export function httpWorkflowClient(opts: HttpClientOptions): WorkflowClient {
  const doFetch = opts.fetch ?? fetch;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${opts.token()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(opts.ca ? { tls: { ca: opts.ca } } : {}),
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(
        `Kubernetes API ${init.method ?? "GET"} ${path} returned ${res.status}: ${body.slice(0, 500)}`,
      );
    }
    return JSON.parse(body);
  };
  const base = (ns: string) =>
    `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(ns)}/workflows`;
  return {
    async create(manifest) {
      const created = createdSchema.parse(
        await call(base(manifest.metadata.namespace), {
          method: "POST",
          body: JSON.stringify(manifest),
        }),
      );
      return created.metadata.name;
    },
    async listActive(namespace, labelSelector) {
      const selector = `${labelSelector},workflows.argoproj.io/completed!=true`;
      const list = listSchema.parse(
        await call(
          `${base(namespace)}?labelSelector=${encodeURIComponent(selector)}`,
        ),
      );
      return list.items.map((i) => i.metadata.name);
    },
  };
}

export function inClusterWorkflowClient(
  env: Record<string, string | undefined>,
  saDir = SA_DIR,
): WorkflowClient {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? "443";
  const tokenPath = join(saDir, "token");
  if (!host || !existsSync(tokenPath)) {
    throw new Error(
      "not running in a cluster: KUBERNETES_SERVICE_HOST or the ServiceAccount token is missing (set DRY_RUN=true outside a cluster)",
    );
  }
  return httpWorkflowClient({
    baseUrl: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
    token: () => readFileSync(tokenPath, "utf8").trim(),
    ca: readFileSync(join(saDir, "ca.crt"), "utf8"),
  });
}
