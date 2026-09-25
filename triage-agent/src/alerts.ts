import { z } from "zod";

export interface Alert {
  fingerprint: string;
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  generatorURL?: string;
}

export interface AlertGroup {
  key: string;
  alertname: string;
  namespace?: string;
  severity?: string;
  alerts: Alert[];
}

const CLUSTER_SCOPE = "_cluster";

const storedAlert = z.object({
  fingerprint: z.string().min(1),
  name: z.string().min(1),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  startsAt: z.string(),
  generatorURL: z.string().optional(),
});

/** An AlertGroup as the intake serialises it into a workflow parameter. */
export const alertGroupSchema = z
  .object({
    key: z.string().min(1),
    alertname: z.string().min(1),
    namespace: z.string().optional(),
    severity: z.string().optional(),
    alerts: z.array(storedAlert).min(1),
  })
  .transform(
    (g): AlertGroup => ({
      key: g.key,
      alertname: g.alertname,
      ...(g.namespace ? { namespace: g.namespace } : {}),
      ...(g.severity ? { severity: g.severity } : {}),
      alerts: g.alerts.map((a) => ({
        fingerprint: a.fingerprint,
        name: a.name,
        labels: a.labels,
        annotations: a.annotations,
        startsAt: a.startsAt,
        ...(a.generatorURL ? { generatorURL: a.generatorURL } : {}),
      })),
    }),
  );

const labels = z
  .record(z.string(), z.string())
  .refine((l) => Boolean(l.alertname), "alert has no alertname label");

const baseAlert = {
  labels,
  annotations: z.record(z.string(), z.string()).default({}),
  startsAt: z.string(),
  fingerprint: z.string().min(1),
  generatorURL: z.string().optional(),
};

const webhookSchema = z.object({
  version: z.literal("4"),
  alerts: z
    .array(z.object({ ...baseAlert, status: z.enum(["firing", "resolved"]) }))
    .max(1000),
});

const apiAlertsSchema = z
  .array(
    z.object({
      ...baseAlert,
      status: z.object({ state: z.string() }),
    }),
  )
  .max(5000);

type ParsedAlert = z.infer<typeof apiAlertsSchema>[number];

function toAlert(a: Omit<ParsedAlert, "status">): Alert {
  return {
    fingerprint: a.fingerprint,
    name: a.labels.alertname ?? "",
    labels: a.labels,
    annotations: a.annotations,
    startsAt: a.startsAt,
    ...(a.generatorURL ? { generatorURL: a.generatorURL } : {}),
  };
}

/** Firing alerts of an Alertmanager webhook (payload version 4). */
export function parseWebhook(body: unknown): Alert[] {
  return webhookSchema
    .parse(body)
    .alerts.filter((a) => a.status === "firing")
    .map(toAlert);
}

/** Active alerts of `GET /api/v2/alerts`. */
export function parseApiAlerts(body: unknown): Alert[] {
  return apiAlertsSchema
    .parse(body)
    .filter((a) => a.status.state === "active")
    .map(toAlert);
}

export function groupKey(alert: Alert): string {
  return `${alert.name}/${alert.labels.namespace ?? CLUSTER_SCOPE}`;
}

export function groupAlerts(
  alerts: readonly Alert[],
  ignored: ReadonlySet<string>,
): AlertGroup[] {
  const groups = new Map<string, AlertGroup>();
  for (const alert of alerts) {
    if (ignored.has(alert.name)) continue;
    const key = groupKey(alert);
    const group = groups.get(key) ?? {
      key,
      alertname: alert.name,
      ...(alert.labels.namespace ? { namespace: alert.labels.namespace } : {}),
      ...(alert.labels.severity ? { severity: alert.labels.severity } : {}),
      alerts: [],
    };
    if (!group.alerts.some((a) => a.fingerprint === alert.fingerprint)) {
      group.alerts.push(alert);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}
