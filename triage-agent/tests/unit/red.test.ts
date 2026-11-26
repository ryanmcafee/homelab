import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  type BuildIdentity,
  REQUEST_DURATION,
  RedMetrics,
} from "../../src/intake/red.ts";
import { createHandler, instrument } from "../../src/intake/server.ts";
import { Metrics, RecordStore } from "../../src/intake/intake.ts";

const labelSpec = z.object({
  name: z.string(),
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

const contractSchema = z.object({
  metrics: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
      series: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional(),
      constantValue: z.number().optional(),
    }),
  ),
  buckets: z.object({ leLabelValues: z.array(z.string()) }),
  labels: z.object({
    required: z.array(
      labelSpec.extend({ unmatchedValue: z.string().optional() }),
    ),
    optional: z.array(labelSpec.extend({ appliesTo: z.string() })),
  }),
  cardinality: z.object({ forbiddenLabels: z.array(z.string()) }),
});

type Contract = z.infer<typeof contractSchema>;

const contract: Contract = contractSchema.parse(
  Bun.YAML.parse(
    await Bun.file(
      new URL(
        "../../../contracts/observability/metrics.v1.yaml",
        import.meta.url,
      ),
    ).text(),
  ),
);

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

function parseExposition(text: string) {
  const types = new Map<string, string>();
  const samples: Sample[] = [];
  for (const line of text.split("\n")) {
    const type = /^# TYPE (\S+) (\S+)$/.exec(line);
    if (type?.[1] && type[2]) types.set(type[1], type[2]);
    const sample = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!sample?.[1] || !sample[3]) continue;
    const labels = Object.fromEntries(
      [...(sample[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [
        m[1] ?? "",
        m[2] ?? "",
      ]),
    );
    samples.push({ name: sample[1], labels, value: Number(sample[3]) });
  }
  return { types, samples };
}

/** Every way the exposition departs from metrics.v1.yaml; empty when conformant. */
function violations(text: string, spec: Contract): string[] {
  const { types, samples } = parseExposition(text);
  const found: string[] = [];
  for (const m of spec.metrics.filter((x) => x.required)) {
    if (types.get(m.name) !== m.type) {
      found.push(`${m.name}: TYPE ${types.get(m.name)}, want ${m.type}`);
    }
  }
  const histogram = spec.metrics.find((m) => m.name === REQUEST_DURATION);
  const suffixes = histogram?.series ?? [];
  const red = samples.filter((s) => s.name.startsWith(REQUEST_DURATION));
  if (red.length === 0) found.push(`${REQUEST_DURATION}: no samples`);
  const allowed = new Set([
    ...spec.labels.required.map((l) => l.name),
    ...spec.labels.optional.map((l) => l.name),
  ]);
  const check = (s: Sample, l: z.infer<typeof labelSpec>) => {
    const v = s.labels[l.name];
    if (v === undefined) return;
    if (l.pattern && !new RegExp(l.pattern).test(v))
      found.push(`${s.name}: ${l.name}="${v}" fails ${l.pattern}`);
    if (l.enum && !l.enum.includes(v))
      found.push(`${s.name}: ${l.name}="${v}" not in ${l.enum.join("|")}`);
  };
  for (const s of red) {
    const suffix = s.name.slice(REQUEST_DURATION.length);
    if (!suffixes.includes(suffix)) found.push(`${s.name}: undeclared series`);
    for (const l of spec.labels.required) {
      if (s.labels[l.name] === undefined)
        found.push(`${s.name}: missing required label ${l.name}`);
      check(s, l);
    }
    for (const l of spec.labels.optional) {
      const present = s.labels[l.name] !== undefined;
      const applies = s.labels.outcome === "error";
      if (present !== applies)
        found.push(
          `${s.name}: ${l.name} present=${present} on outcome=${s.labels.outcome}`,
        );
      check(s, l);
    }
    for (const name of Object.keys(s.labels)) {
      if (spec.cardinality.forbiddenLabels.includes(name))
        found.push(`${s.name}: forbidden label ${name}`);
      if (!allowed.has(name) && !(suffix === "_bucket" && name === "le"))
        found.push(`${s.name}: undeclared label ${name}`);
    }
  }
  const bucketSets = new Map<string, string[]>();
  for (const s of red.filter((x) => x.name.endsWith("_bucket"))) {
    const { le, ...rest } = s.labels;
    const key = JSON.stringify(rest);
    bucketSets.set(key, [...(bucketSets.get(key) ?? []), le ?? ""]);
  }
  for (const [key, les] of bucketSets) {
    if (JSON.stringify(les) !== JSON.stringify(spec.buckets.leLabelValues))
      found.push(`${key}: le ${les.join(",")}`);
  }
  for (const m of spec.metrics.filter((x) => x.type === "gauge")) {
    const gauge = samples.filter((s) => s.name === m.name);
    if (gauge.length !== 1) found.push(`${m.name}: ${gauge.length} series`);
    for (const s of gauge) {
      const names = Object.keys(s.labels).sort();
      if (
        JSON.stringify(names) !== JSON.stringify([...(m.labels ?? [])].sort())
      )
        found.push(`${m.name}: labels ${names.join(",")}`);
      if (m.constantValue !== undefined && s.value !== m.constantValue)
        found.push(`${m.name}: value ${s.value}`);
    }
  }
  return found;
}

const identity: BuildIdentity = {
  service: "triage-agent",
  environment: "test",
  tenant: "local",
  version: "0.1.2",
  revision: "abc123",
};

function setup(onAlerts: () => void = () => {}) {
  const red = new RedMetrics(identity);
  const handle = createHandler({
    onAlerts,
    records: new RecordStore(5),
    metrics: new Metrics(),
    queueDepth: () => 0,
    red,
    requestTimeoutMs: 1000,
  });
  const scrape = async () =>
    parseExposition(
      await (await handle(new Request("http://x/metrics"))).text(),
    );
  return { red, handle, scrape };
}

const counts = (samples: Sample[]) =>
  samples
    .filter((s) => s.name === `${REQUEST_DURATION}_count`)
    .map(({ labels: { route, outcome, code }, value }) => ({
      route,
      outcome,
      code,
      value,
    }));

const webhook = (body: string) =>
  new Request("http://x/webhook", { method: "POST", body });

describe("RED exposition against contracts/observability/metrics.v1.yaml", () => {
  test("a served mix of routes, outcomes and codes is conformant", async () => {
    const { handle } = setup();
    await handle(webhook(JSON.stringify({ version: "4", alerts: [] })));
    await handle(webhook("{"));
    await handle(new Request("http://x/submissions"));
    await handle(new Request("http://x/unknown/path"));
    const red = new RedMetrics(identity);
    red.observe(
      {
        kind: "http",
        route: "POST /webhook",
        outcome: "error",
        code: "timeout",
      },
      42,
    );
    const text = await (await handle(new Request("http://x/metrics"))).text();
    expect(violations(text, contract)).toEqual([]);
    expect(violations(red.render(), contract)).toEqual([]);
  });

  test("the checker fails when a required label is dropped", async () => {
    const { handle } = setup();
    await handle(new Request("http://x/submissions"));
    const text = await (await handle(new Request("http://x/metrics"))).text();
    for (const { name } of contract.labels.required) {
      const dropped = text.replace(new RegExp(`${name}="[^"]*",?`, "g"), "");
      expect(violations(dropped, contract)).toContain(
        `${REQUEST_DURATION}_count: missing required label ${name}`,
      );
    }
  });

  test("the checker fails on a bucket boundary the contract does not pin", () => {
    const red = new RedMetrics(identity);
    red.observe(
      { kind: "http", route: "GET /submissions", outcome: "success" },
      0.1,
    );
    const text = red.render().replace('le="2.5"', 'le="2.50"');
    expect(violations(text, contract).join("\n")).toContain("le 0.005");
  });

  test("records the duration in cumulative buckets with +Inf equal to the count", () => {
    const red = new RedMetrics(identity);
    red.observe(
      { kind: "http", route: "GET /submissions", outcome: "success" },
      0.2,
    );
    red.observe(
      { kind: "http", route: "GET /submissions", outcome: "success" },
      40,
    );
    const { samples } = parseExposition(red.render());
    const bucket = (le: string) =>
      samples.find((s) => s.name.endsWith("_bucket") && s.labels.le === le)
        ?.value;
    expect([
      bucket("0.1"),
      bucket("0.25"),
      bucket("30"),
      bucket("+Inf"),
    ]).toEqual([0, 1, 1, 2]);
    expect(samples.find((s) => s.name.endsWith("_sum"))?.value).toBeCloseTo(
      40.2,
    );
  });
});

describe("request observation", () => {
  test("probes and scrapes are never observed", async () => {
    const { handle, scrape } = setup();
    await handle(new Request("http://x/healthz"));
    await handle(new Request("http://x/metrics"));
    expect(counts((await scrape()).samples)).toEqual([]);
  });

  test("routes are templated and anything unmatched is __other__", async () => {
    const { handle, scrape } = setup();
    await handle(new Request("http://x/scanner/a"));
    await handle(new Request("http://x/scanner/b"));
    await handle(new Request("http://x/webhook"));
    await handle(new Request("http://x/submissions"));
    const routes = counts((await scrape()).samples).map((c) => [
      c.route,
      c.value,
    ]);
    expect(routes).toEqual([
      ["__other__", 3],
      ["GET /submissions", 1],
    ]);
  });

  test("a 4xx is a success and a throw is one internal error", async () => {
    const { handle, scrape } = setup(() => {
      throw new Error("boom");
    });
    await handle(webhook("{"));
    await expect(
      handle(webhook(JSON.stringify({ version: "4", alerts: [] }))),
    ).rejects.toThrow("boom");
    expect(counts((await scrape()).samples)).toMatchObject([
      { route: "POST /webhook", outcome: "success", value: 1 },
      { route: "POST /webhook", outcome: "error", code: "internal", value: 1 },
    ]);
  });

  test("observes exactly once on success, throw and timeout", async () => {
    const red = new RedMetrics(identity);
    let clock = 0;
    const opts = { red, requestTimeoutMs: 20, now: () => clock };
    const ok = instrument(async () => {
      clock += 300;
      return new Response("ok");
    }, opts);
    const thrown = instrument(async () => {
      clock += 10;
      throw new Error("boom");
    }, opts);
    const hung = instrument(() => new Promise<Response>(() => {}), opts);
    const req = new Request("http://x/submissions");
    await ok(req);
    await expect(thrown(req)).rejects.toThrow("boom");
    const timedOut = await hung(req);
    expect(timedOut.status).toBe(504);
    await Bun.sleep(30);
    const observed = counts(parseExposition(red.render()).samples);
    expect(observed).toMatchObject([
      { outcome: "success", value: 1 },
      { outcome: "error", code: "internal", value: 1 },
      { outcome: "error", code: "timeout", value: 1 },
    ]);
    expect(observed.reduce((n, c) => n + c.value, 0)).toBe(3);
  });

  test("classifies 5xx and 429 as errors with a bounded code", async () => {
    const red = new RedMetrics(identity);
    for (const status of [500, 502, 503, 504, 429, 404]) {
      await instrument(async () => new Response("", { status }), {
        red,
        requestTimeoutMs: 1000,
      })(new Request("http://x/submissions"));
    }
    const codes = counts(parseExposition(red.render()).samples).map((c) => [
      c.outcome,
      c.code,
      c.value,
    ]);
    expect(codes).toEqual([
      ["error", "internal", 2],
      ["error", "unavailable", 1],
      ["error", "timeout", 1],
      ["error", "throttled", 1],
      ["success", undefined, 1],
    ]);
  });
});
