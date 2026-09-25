import { type Alert, parseApiAlerts } from "./alerts.ts";

const TIMEOUT_MS = 15_000;

async function expectOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`${what} returned ${res.status}: ${body}`);
  }
  return res;
}

export async function fetchActiveAlerts(baseUrl: string): Promise<Alert[]> {
  const url = new URL(`${baseUrl}/api/v2/alerts`);
  url.searchParams.set("active", "true");
  url.searchParams.set("silenced", "false");
  url.searchParams.set("inhibited", "false");
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  await expectOk(res, `Alertmanager ${url.pathname}`);
  return parseApiAlerts(await res.json());
}

export async function postToSlack(webhookUrl: string, text: string) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await expectOk(res, "Slack webhook");
}
