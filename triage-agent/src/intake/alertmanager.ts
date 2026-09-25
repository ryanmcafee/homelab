import { type Alert, parseApiAlerts } from "../alerts.ts";

const TIMEOUT_MS = 15_000;

export async function fetchActiveAlerts(baseUrl: string): Promise<Alert[]> {
  const url = new URL(`${baseUrl}/api/v2/alerts`);
  url.searchParams.set("active", "true");
  url.searchParams.set("silenced", "false");
  url.searchParams.set("inhibited", "false");
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(
      `Alertmanager ${url.pathname} returned ${res.status}: ${body}`,
    );
  }
  return parseApiAlerts(await res.json());
}
