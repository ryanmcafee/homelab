import { z } from "zod";
import { must } from "../exec.ts";
import { type Triage, triageSchema } from "../prompt.ts";
import { alertGroupOf, type StageDeps } from "./context.ts";
import { type PrRecord, prRecordSchema } from "./github.ts";

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";
const MAX_TITLE = 250;
const MAX_MESSAGE = 1024;

export interface Notification {
  title: string;
  message: string;
  priority: -1 | 0;
  url?: string;
  urlTitle?: string;
}

export interface NotifyInput {
  alertname: string;
  namespace?: string;
  workflow: string;
  workflowStatus: string;
  failures: string;
  workflowUrl?: string;
  triage?: Triage;
  pr?: PrRecord;
  ciState?: string;
  changed?: boolean;
}

const failureSchema = z.array(
  z.object({
    displayName: z.string().optional(),
    message: z.string().optional(),
  }),
);

function firstFailure(raw: string): string {
  try {
    const f = failureSchema.parse(JSON.parse(raw))[0];
    return f ? `${f.displayName ?? "step"}: ${f.message ?? "failed"}` : "";
  } catch {
    return raw.slice(0, 200);
  }
}

/** The Pushover message for how the workflow ended. */
export function buildNotification(n: NotifyInput): Notification {
  const scope = n.namespace ? ` (${n.namespace})` : "";
  const subject = `${n.alertname}${scope}`;
  const cause = n.triage ? `Root cause: ${n.triage.rootCause}` : "";
  const toWorkflow = n.workflowUrl
    ? { url: n.workflowUrl, urlTitle: "Open workflow" }
    : {};

  let note: Notification;
  if (n.pr) {
    const green = n.ciState === "green" && !n.pr.needsHuman;
    note = {
      title: green
        ? `Fix PR ready: ${subject}`
        : `Fix PR needs you: ${subject}`,
      message: [
        `PR #${n.pr.number}, CI ${n.ciState ?? "not watched"}${n.pr.needsHuman ? ", labelled needs-human" : ""}.`,
        cause,
      ]
        .filter(Boolean)
        .join(" "),
      priority: 0,
      url: n.pr.url,
      urlTitle: `Open PR #${n.pr.number}`,
    };
  } else if (n.workflowStatus !== "Succeeded") {
    const failure = firstFailure(n.failures);
    note = {
      title: `Triage workflow ${n.workflowStatus.toLowerCase() || "ended"}: ${subject}`,
      message: [
        `${[n.workflow, n.workflowStatus].filter(Boolean).join(" ")}.`,
        failure,
        cause,
      ]
        .filter(Boolean)
        .join(" "),
      priority: 0,
      ...toWorkflow,
    };
  } else if (n.triage && !n.triage.actionable) {
    note = {
      title: `Triage report: ${subject}`,
      message: `${n.triage.summary} ${cause}. Suggested: ${n.triage.recommendedFix}`,
      priority: -1,
      ...toWorkflow,
    };
  } else {
    note = {
      title: `No fix produced: ${subject}`,
      message: [
        n.changed === false ? "The implement stage changed no files." : "",
        cause,
      ]
        .filter(Boolean)
        .join(" "),
      priority: 0,
      ...toWorkflow,
    };
  }
  return {
    ...note,
    title: note.title.slice(0, MAX_TITLE),
    message: (note.message || note.title).slice(0, MAX_MESSAGE),
  };
}

function readOptional<T>(deps: StageDeps, name: string, schema: z.ZodType<T>) {
  if (!deps.work.has(name)) return undefined;
  const parsed = schema.safeParse(deps.work.readJson(name));
  return parsed.success ? parsed.data : undefined;
}

/** onExit handler, deterministic: always tells the phone how it ended. */
export async function notifyStage(deps: StageDeps): Promise<Notification> {
  const { config } = deps;
  const group = alertGroupOf(config);
  const triage = readOptional(deps, "triage.json", triageSchema);
  const pr = readOptional(deps, "pr.json", prRecordSchema);
  const ci = readOptional(deps, "ci.json", z.object({ state: z.string() }));
  const commit = readOptional(
    deps,
    "commit.json",
    z.object({ changed: z.boolean() }),
  );
  const note = buildNotification({
    alertname: group.alertname,
    ...(group.namespace ? { namespace: group.namespace } : {}),
    workflow: config.WORKFLOW_NAME,
    workflowStatus: config.WORKFLOW_STATUS,
    failures: config.WORKFLOW_FAILURES,
    ...(config.WORKFLOW_UI_URL
      ? {
          workflowUrl: `${config.WORKFLOW_UI_URL}/workflows/${config.WORKFLOW_NAME}`,
        }
      : {}),
    ...(triage ? { triage } : {}),
    ...(pr ? { pr } : {}),
    ...(ci ? { ciState: ci.state } : {}),
    ...(commit ? { changed: commit.changed } : {}),
  });

  if (!config.PUSHOVER_TOKEN || !config.PUSHOVER_USER_KEY) {
    deps.logger.warn(
      { note },
      "Pushover not configured; notification only logged",
    );
    return note;
  }
  const form = new URLSearchParams({
    token: config.PUSHOVER_TOKEN,
    user: config.PUSHOVER_USER_KEY,
    title: note.title,
    message: note.message,
    priority: String(note.priority),
    ...(note.url ? { url: note.url } : {}),
    ...(note.urlTitle ? { url_title: note.urlTitle } : {}),
  });
  const res = await deps.fetch(PUSHOVER_URL, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `Pushover returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  deps.logger.info({ title: note.title }, "notification sent");
  return note;
}

/** Optional template, not in the default path: sync one Application. */
export async function argocdSyncStage(deps: StageDeps): Promise<void> {
  const app = deps.config.ARGOCD_APP;
  if (!app) throw new Error("ARGOCD_APP is not set");
  const out = await must(deps.exec, [
    "argocd",
    "app",
    "sync",
    app,
    "--grpc-web",
  ]);
  deps.work.write(`argocd-sync-${app}.log`, out);
}
