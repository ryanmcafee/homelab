/** Kind-only live assertions. Never print credentials, full CRs, pod specs or config. */
import { loadAll } from "js-yaml";
import { existsSync, unlinkSync } from "node:fs";

import {
  kindKubeconfig,
  openclawContext,
  safeCommand,
} from "../../../scripts/lib/openclaw-e2e-command.ts";

// Kubernetes objects have different shapes; keep untrusted output inside this test runner.
type Obj = Record<string, any>;
const context = openclawContext;
let kube: ReturnType<typeof kindKubeconfig>;
const ns = "openclaw";
const resource = "openclawinstances.openclaw.rocks";
const stateFile = new URL(".restore.json", import.meta.url).pathname;
const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"])
  .stdout.toString()
  .trim();
function check(ok: unknown, label: string): asserts ok {
  if (!ok) throw new Error(`FAIL ${label}`);
  console.log(`PASS ${label}`);
}
function command(args: string[], input?: string): string {
  return safeCommand(args, root, input);
}
function k(args: string[], input?: string): string {
  try {
    return command([...kube.args, ...args], input);
  } catch (error) {
    // Operation/resource only; never include names, patch bodies or exec arguments.
    const operation = args[0];
    const resource = operation === "get" || operation === "patch" ? args[1] : "";
    if (error instanceof Error && error.message.startsWith("command "))
      throw new Error(
        error.message + `; operation=${operation} resource=${resource}`,
      );
    throw error;
  }
}
function get(kind: string, name?: string, namespace = ns): Obj {
  return JSON.parse(
    k([
      "get",
      kind,
      ...(name ? [name] : []),
      ...(namespace ? ["-n", namespace] : ["-A"]),
      "-o",
      "json",
    ]),
  );
}
function ready(o: Obj): boolean {
  return (
    o.status?.conditions?.some(
      (c: Obj) => c.type === "Ready" && c.status === "True",
    ) === true
  );
}
async function wait(
  label: string,
  assertion: () => boolean,
  seconds = 240,
): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    if (assertion()) {
      console.log(
        `PASS ${label}; observations=${polls} (bounded convergence polling, not a test retry)`,
      );
      return;
    }
    await Bun.sleep(3000);
  }
  throw new Error(`FAIL ${label}: deadline ${seconds}s; observations=${polls}`);
}
function appHealthy(): boolean {
  return (
    get("applications", "openclaw", "argocd").status?.health?.status ===
    "Healthy"
  );
}
function pod(): Obj {
  const cr = get(resource, "openclaw");
  const sts = get("statefulsets", cr.status.managedResources.statefulSet);
  const pods = get("pods").items.filter((p: Obj) =>
    p.metadata.ownerReferences?.some((r: Obj) => r.uid === sts.metadata.uid),
  );
  check(pods.length === 1, "exactly one StatefulSet-owned pod");
  return pods[0];
}
function envNames(p: Obj): string[] {
  const container = p.spec.containers.find((c: Obj) => c.name === "openclaw");
  check(container, "primary openclaw container exists");
  check(!container.envFrom?.length, "primary container has no bulk envFrom");
  const names = (container.env ?? []).map((e: Obj) => e.name).sort();
  check(
    new Set(names).size === names.length,
    "no duplicate primary-container environment names",
  );
  return names;
}
function provider(cr: Obj): void {
  const providers = cr.spec.config.raw.models.providers;
  check(
    Object.keys(providers).join() === "anthropic",
    "native anthropic provider is the complete default allowlist",
  );
  check(
    providers.anthropic.apiKey === "${ANTHROPIC_OAUTH_TOKEN}",
    "native provider selects OAuth token reference",
  );
  check(
    cr.spec.config.raw.agents.defaults.model.primary.startsWith("anthropic/"),
    "default model uses native anthropic prefix",
  );
}
async function baseline(): Promise<void> {
  const cr = get(resource, "openclaw");
  check(
    cr.status?.phase === "Running" && ready(cr),
    "instance Running and Ready=True",
  );
  for (const [kind, field] of Object.entries({
    statefulsets: "statefulSet",
    services: "service",
    configmaps: "configMap",
    persistentvolumeclaims: "pvc",
    serviceaccounts: "serviceAccount",
    roles: "role",
    rolebindings: "roleBinding",
    networkpolicies: "networkPolicy",
  })) {
    const name = cr.status.managedResources?.[field];
    check(name, `operator reports ${kind}`);
    const obj = get(kind, name);
    check(
      obj.metadata.ownerReferences?.some((r: Obj) => r.uid === cr.metadata.uid),
      `${kind}/${name} owned by live instance UID`,
    );
    if (kind === "persistentvolumeclaims")
      check(obj.status.phase === "Bound", `PVC/${name} Bound`);
  }
  const secret = cr.status.managedResources?.gatewayTokenSecret;
  check(
    secret === cr.spec.gateway.existingSecret,
    "operator reports configured external gateway Secret (not operator-owned)",
  );
  check(
    k(["get", "secret", secret, "-n", ns, "-o", "name"]).trim() ===
      `secret/${secret}`,
    "referenced gateway Secret exists; contents not logged",
  );
  const p = pod();
  console.log(
    `ENV context=${context} namespace=${ns} pod=${p.metadata.name} image=${p.spec.containers.find((c: Obj) => c.name === "openclaw").image}`,
  );
  check(ready(p), `pod/${p.metadata.name} Ready=True`);
  const oauth = p.spec.containers
    .find((c: Obj) => c.name === "openclaw")
    .env.find((e: Obj) => e.name === "ANTHROPIC_OAUTH_TOKEN");
  check(
    oauth?.valueFrom?.secretKeyRef?.name === "openclaw-api-keys" &&
      oauth?.valueFrom?.secretKeyRef?.key === "ANTHROPIC_OAUTH_TOKEN",
    "OAuth variable references the intended Secret key",
  );
  const names = envNames(p);
  check(
    names.includes("ANTHROPIC_OAUTH_TOKEN"),
    "live pod has ANTHROPIC_OAUTH_TOKEN",
  );
  const allContainers = [
    ...p.spec.containers,
    ...(p.spec.initContainers ?? []),
  ];
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]) {
    check(
      allContainers.every(
        (c: Obj) =>
          !(c.env ?? []).some((e: Obj) => e.name === name) &&
          !c.envFrom?.length,
      ),
      `no ${name} or bulk envFrom in any live container`,
    );
  }
  provider(cr);
  // The runtime file can contain gateway credentials: evaluate inside the pod and return only an exit code.
  k([
    "exec",
    "-n",
    ns,
    p.metadata.name,
    "-c",
    "openclaw",
    "--",
    "node",
    "-e",
    `const fs=require('fs');const c=JSON.parse(fs.readFileSync('/home/openclaw/.openclaw/openclaw.json','utf8'));process.exit(Object.keys(c.models?.providers||{}).join()==='anthropic'&&c.models.providers.anthropic.apiKey==='\u0024{ANTHROPIC_OAUTH_TOKEN}'&&c.agents.defaults.model.primary.startsWith('anthropic/')?0:1)`,
  ]);
  console.log(
    "PASS runtime config retains native provider and OAuth reference; AUTHENTICATION UNPROVEN (placeholder token, no inference)",
  );
  const app = get("applications", "openclaw-operator", "argocd");
  check(
    app.spec.syncPolicy.syncOptions.includes("ServerSideApply=true"),
    "operator Application explicitly enables SSA; counterfactual excluded (README)",
  );
}
async function security(): Promise<void> {
  const deployments = get("deployments", undefined, "openclaw-system").items;
  check(
    deployments.length === 1 && deployments[0].status.availableReplicas > 0,
    "operator Deployment available (positive control)",
  );
  const sa = deployments[0].spec.template.spec.serviceAccountName;
  check(sa, "operator ServiceAccount discovered from Deployment");
  const username = `system:serviceaccount:openclaw-system:${sa}`;
  const groups = [
    "system:serviceaccounts",
    "system:serviceaccounts:openclaw-system",
    "system:authenticated",
  ];
  const bindings = get("clusterrolebindings", undefined, "").items;
  const applicable = bindings.filter((b: Obj) =>
    b.subjects?.some(
      (s: Obj) =>
        (s.kind === "ServiceAccount" &&
          s.namespace === "openclaw-system" &&
          s.name === sa) ||
        (s.kind === "User" && s.name === username) ||
        (s.kind === "Group" && groups.includes(s.name)),
    ),
  );
  check(
    applicable.length > 0,
    "operator has applicable ClusterRoleBindings (positive control)",
  );
  console.log(
    `INSPECTED ${bindings.length} ClusterRoleBindings; applicable=${applicable.length}`,
  );
  for (const binding of applicable) {
    check(
      binding.roleRef.kind === "ClusterRole",
      `binding/${binding.metadata.name} references ClusterRole`,
    );
    const role = get("clusterroles", binding.roleRef.name, "");
    for (const rule of role.rules ?? []) {
      check(
        !rule.verbs?.includes("*"),
        `ClusterRole/${role.metadata.name} no wildcard verbs`,
      );
      check(
        !(
          (rule.apiGroups?.includes("") || rule.apiGroups?.includes("*")) &&
          (rule.resources?.includes("secrets") || rule.resources?.includes("*"))
        ),
        `ClusterRole/${role.metadata.name} no cluster-wide Secret permissions`,
      );
    }
  }
  for (const [namespace, expected, exit] of [
    ["openclaw", "yes", 0],
    ["default", "no", 1],
  ] as const) {
    const args = [
      ...kube.args,
      "auth",
      "can-i",
      "get",
      "secrets",
      "-n",
      namespace,
      `--as=${username}`,
      ...groups.map((g) => `--as-group=${g}`),
    ];
    const result = Bun.spawnSync(args);
    check(
      result.exitCode === exit && result.stdout.toString().trim() === expected,
      `impersonated Secret read in ${namespace}: ${expected}, exit ${exit}`,
    );
  }
  const services = get("services").items.map((s: Obj) => s.metadata.name);
  check(
    services.includes(
      get(resource, "openclaw").status.managedResources.service,
    ),
    "reconciled Service exists before route absence check",
  );
  const routes = get(
    "httproutes.gateway.networking.k8s.io",
    undefined,
    "",
  ).items;
  check(
    routes.length > 0,
    "HTTPRoute API has reconciled routes (positive control)",
  );
  console.log(`INSPECTED ${routes.length} HTTPRoutes across all namespaces`);
  for (const route of routes) {
    const refs: Obj[] = [];
    // Include RequestMirror backendRef and backend-level filters, not only rules.backendRefs.
    function collect(value: unknown): void {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "backendRef" && child && typeof child === "object")
          refs.push(child as Obj);
        if (key === "backendRefs" && Array.isArray(child)) refs.push(...child);
        collect(child);
      }
    }
    collect(route.spec);
    const target = refs.some(
      (b: Obj) =>
        (b.namespace ?? route.metadata.namespace) === ns &&
        (b.kind ?? "Service") === "Service" &&
        services.includes(b.name),
    );
    check(
      !target,
      `HTTPRoute/${route.metadata.namespace}/${route.metadata.name} has no OpenClaw Service backend`,
    );
    if (route.metadata.namespace === ns) {
      check(
        !route.spec.parentRefs?.some(
          (p: Obj) =>
            p.name === "envoy-internal" &&
            (p.namespace ?? ns) === "envoy-gateway-system",
        ),
        `OpenClaw HTTPRoute/${route.metadata.name} has no shared internal Gateway parent`,
      );
    }
  }
}
async function smoke(): Promise<void> {
  // First-attempt probe adds headers/body to the helper's status-only contract.
  // Evaluate and return only a boolean exit code; no body or credential output.
  const p = pod();
  k([
    "exec",
    "-n",
    ns,
    p.metadata.name,
    "-c",
    "openclaw",
    "--",
    "node",
    "-e",
    "(async()=>{const r=await fetch('http://openclaw.openclaw.svc.cluster.local:18789/healthz',{signal:AbortSignal.timeout(10000)});const body=await r.json();process.exit(r.status===200&&r.headers.get('content-type')?.includes('application/json')&&r.headers.get('cache-control')==='no-store'&&body.ok===true?0:1)})().catch(()=>process.exit(1))",
  ]);
  console.log(
    "PASS first-attempt HTTP /healthz: 200, application/json, Cache-Control no-store, body.ok=true; TLS not offered on internal HTTP service",
  );
  const parent = get("applications", "applications", "argocd");
  const results = parent.status?.operationState?.syncResult?.resources ?? [];
  check(
    results.some(
      (r: Obj) =>
        r.kind === "Job" &&
        r.name === "smoke-openclaw" &&
        r.namespace === ns &&
        r.hookType === "PostSync" &&
        r.hookPhase === "Succeeded",
    ),
    "original PostSync smoke-openclaw hook's own recorded result Succeeded",
  );
  const rendered = command([
    "helm",
    "template",
    "applications",
    "charts/applications",
    "-f",
    "charts/applications/values-localdev.yaml",
  ]);
  const jobs = loadAll(rendered).filter(
    (o: any) => o?.kind === "Job" && o.metadata?.name === "smoke-openclaw",
  ) as Obj[];
  check(
    jobs.length === 1,
    "exactly one smoke-openclaw rendered by parent chart helper",
  );
  const job = jobs[0];
  check(
    job.metadata.annotations["argocd.argoproj.io/hook"] === "PostSync" &&
      job.metadata.annotations["argocd.argoproj.io/sync-wave"] === "13",
    "helper smoke hook is PostSync wave 13",
  );
  job.metadata = { name: "qa-smoke-openclaw", namespace: ns };
  job.spec.backoffLimit = 0; // Any retry is a finding; no job-level retries in this replay.
  k(["create", "-f", "-"], JSON.stringify(job));
  try {
    k([
      "wait",
      "-n",
      ns,
      "job/qa-smoke-openclaw",
      "--for=condition=Complete",
      "--timeout=180s",
    ]);
    const output = k([
      "logs",
      "-n",
      ns,
      "job/qa-smoke-openclaw",
      "--all-containers=true",
    ]);
    check(
      /smoke openclaw: http:\/\/openclaw\.openclaw\.svc\.cluster\.local:18789\/healthz -> HTTP 200/.test(
        output,
      ),
      "retained helper replay returned HTTP 200 from /healthz",
    );
    console.log(output.trim());
    console.log(
      "LIMIT: original Job was deleted by HookSucceeded; replay is direct HTTP evidence, not original Job logs. Helper curl internally retries.",
    );
  } finally {
    k([
      "delete",
      "job",
      "qa-smoke-openclaw",
      "-n",
      ns,
      "--ignore-not-found",
      "--wait=true",
    ]);
  }
}
function patch(spec: Obj): void {
  k([
    "patch",
    resource,
    "openclaw",
    "-n",
    ns,
    "--type=merge",
    "-p",
    JSON.stringify({ spec }),
  ]);
}
async function converged(): Promise<void> {
  await wait("instance recovered Running/Ready and Application Healthy", () => {
    const cr = get(resource, "openclaw");
    return cr.status.phase === "Running" && ready(cr) && appHealthy();
  });
  await wait("StatefulSet rollout ready at current revision", () => {
    const cr = get(resource, "openclaw");
    const sts = get("statefulsets", cr.status.managedResources.statefulSet);
    return (
      sts.status.observedGeneration >= sts.metadata.generation &&
      sts.status.readyReplicas === 1 &&
      sts.status.currentRevision === sts.status.updateRevision
    );
  });
}
async function restore(): Promise<void> {
  if (!existsSync(stateFile)) return;
  const original = await Bun.file(stateFile).json();
  patch(original);
  await wait("restored env reaches StatefulSet template", () => {
    const cr = get(resource, "openclaw");
    const sts = get("statefulsets", cr.status.managedResources.statefulSet);
    const env =
      sts.spec.template.spec.containers.find((c: Obj) => c.name === "openclaw")
        .env ?? [];
    const expected = (original.env ?? []).map((e: Obj) => e.name);
    const credentials = [
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ];
    return credentials.every(
      (name) =>
        env.some((e: Obj) => e.name === name) === expected.includes(name),
    );
  });
  await converged();
  unlinkSync(stateFile);
}
async function mutations(): Promise<void> {
  const app = get("applications", "openclaw", "argocd");
  check(
    !app.spec.syncPolicy?.automated,
    "Kind Application has automated sync disabled before intentional faults",
  );
  const cr = get(resource, "openclaw");
  const original = { env: cr.spec.env ?? null, gateway: cr.spec.gateway };
  check(!existsSync(stateFile), "no unrecovered prior test mutation");
  await Bun.write(stateFile, JSON.stringify(original));
  const before = envNames(pod());
  try {
    // Real reconcile failure; do not fabricate CR status or pause the operator.
    patch({ gateway: { existingSecret: "qa-openclaw-deliberately-missing" } });
    await wait(
      "operator observes missing gateway Secret and reports Failed/Ready=False",
      () => {
        const c = get(resource, "openclaw");
        return (
          c.status.phase === "Failed" &&
          c.status.conditions?.some(
            (x: Obj) =>
              x.type === "Ready" &&
              x.status === "False" &&
              x.reason === "ReconcileFailed" &&
              x.message.includes("qa-openclaw-deliberately-missing"),
          )
        );
      },
    );
    await wait(
      "installed Argo health Lua marks live OpenClawInstance and Application Degraded",
      () => {
        const a = get("applications", "openclaw", "argocd");
        return (
          a.status.health.status === "Degraded" &&
          a.status.resources?.some(
            (r: Obj) =>
              r.kind === "OpenClawInstance" &&
              r.name === "openclaw" &&
              r.health?.status === "Degraded",
          )
        );
      },
    );
    patch(original);
    await converged();
    const values = JSON.stringify(app.spec.source.helm.valuesObject);
    const rendered = command(
      [
        "helm",
        "template",
        "openclaw",
        "charts/openclaw",
        "-f",
        "charts/openclaw/values-localdev.yaml",
        "-f",
        "-",
        "--set",
        "adapters.apiKeys.anthropic.enabled=true",
      ],
      values,
    );
    const toggled = loadAll(rendered).find(
      (o: any) => o?.kind === "OpenClawInstance",
    ) as Obj;
    check(toggled, "actual chart renders API-key toggle");
    patch({ env: toggled.spec.env });
    await wait(
      "operator propagates toggled env to StatefulSet template",
      () => {
        const c = get(resource, "openclaw");
        const sts = get("statefulsets", c.status.managedResources.statefulSet);
        return sts.spec.template.spec.containers
          .find((x: Obj) => x.name === "openclaw")
          .env.some((e: Obj) => e.name === "ANTHROPIC_API_KEY");
      },
    );
    await converged();
    const after = envNames(pod());
    check(
      JSON.stringify(after) ===
        JSON.stringify([...before, "ANTHROPIC_API_KEY"].sort()),
      "live toggle adds exactly ANTHROPIC_API_KEY and preserves every other env name",
    );
    check(ready(pod()), "toggled pod Ready=True");
  } finally {
    await restore();
  }
  check(
    JSON.stringify(envNames(pod())) === JSON.stringify(before),
    "default live env restored after toggle",
  );
}
try {
  kube = kindKubeconfig(root);
  const mode = process.argv[2];
  if (mode === "baseline") await baseline();
  else if (mode === "security") await security();
  else if (mode === "smoke") await smoke();
  else if (mode === "mutations") await mutations();
  else if (mode === "restore") await restore();
  else throw new Error("expected baseline|security|smoke|mutations|restore");
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  console.error(
    /^(FAIL |command )/.test(message)
      ? message
      : "FAIL unexpected error (details suppressed)",
  );
  process.exitCode = 1;
} finally {
  kube?.cleanup();
}
