#!/usr/bin/env -S deno run --allow-read --allow-env=PR_BODY

/**
 * verify-claim.ts
 *
 * The PR-body half of the verification contract (issue #261 item 22). An agent
 * (or a human) runs level 0 on the PR head and pastes the result into the PR
 * description as a claim block; CI re-runs level 0 on the same head and fails
 * the `pr-contract` check when the claim does not match what CI saw.
 *
 *   render   stdin = `homelab verify all --level 0 --json`; prints the claim
 *            block for the PR body:
 *
 *              <!-- verify-level0 -->
 *              ```json
 *              {"level":0,"pass":true,"checks":{
 *              "gitops/homelab/crd-order":"pass",
 *              ...
 *              }}
 *              ```
 *
 *            Exit 0 whenever the input is a valid result, including a failing
 *            one (the claim records failure honestly); 1 when the input is not
 *            a verify result.
 *
 *   compare  --actual <ci json> [--body-file <file>] (default: env PR_BODY).
 *            Prints a markdown verdict (job summary + sticky comment) and exits
 *            0 when the claim matches, 1 when it is missing, malformed or
 *            differs. Rules:
 *              - the claim's level must be 0;
 *              - the claimed and CI check-name sets must be identical;
 *              - a per-check difference involving `fail` on either side is a
 *                failure; `skip` <-> `pass` is a warning (a tool missing on one
 *                side), not a failure;
 *              - a different overall `pass` is a failure.
 *
 * Usage:
 *   task verify:claim
 *   go run ./cmd/homelab verify all --level 0 --json | deno run --allow-read scripts/verify-claim.ts render
 *   deno run --allow-read --allow-env=PR_BODY scripts/verify-claim.ts compare --actual verify-level0.json
 *   deno run --allow-read scripts/verify-claim.ts compare --actual verify-level0.json --body-file body.md
 *
 * Exit codes: 0 = ok / claim matches; 1 = claim missing or mismatched, bad
 * input; 2 = usage error.
 */

// ============================================================================
// Logging (stderr only: stdout carries the block or the markdown verdict)
// ============================================================================
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.error(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.error(`${green("OK")}    ${msg}`),
  warn: (msg: string) => console.error(`${yellow("WARN")}  ${msg}`),
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
};

// ============================================================================
// Contract types (internal/verify/types.go)
// ============================================================================
export type Status = "pass" | "fail" | "skip";

export interface VerifyCheck {
  name: string;
  status: Status;
  duration_ms?: number;
  detail?: string;
  findings?: string[];
}

export interface VerifyResult {
  level: number;
  checks: VerifyCheck[];
  pass: boolean;
  duration_ms?: number;
}

/** What the PR body claims: every check name and its status. */
export interface Claim {
  level: number;
  pass: boolean;
  checks: Record<string, Status>;
}

export const MARKER = "<!-- verify-level0 -->";

const STATUSES: readonly string[] = ["pass", "fail", "skip"];

function isStatus(v: unknown): v is Status {
  return typeof v === "string" && STATUSES.includes(v);
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * extractJsonObject returns the JSON object in `text`. `task verify` prints the
 * object and, on failure, a trailing `task: Failed to run task ...` line; this
 * keeps the lines from the first line starting with `{` to the last line
 * starting with `}` (the same cut as `sed -n '/^{/,/^}/p'` in verify.yml).
 */
export function extractJsonObject(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.startsWith("{"));
  if (first === -1) return "";
  let last = -1;
  for (let i = lines.length - 1; i >= first; i--) {
    if (lines[i].startsWith("}")) {
      last = i;
      break;
    }
  }
  // A single-line object ends on its own first line.
  if (last === -1) last = first;
  return lines.slice(first, last + 1).join("\n");
}

/** parseVerifyResult validates the `homelab verify ... --json` contract. */
export function parseVerifyResult(text: string): VerifyResult {
  const body = extractJsonObject(text);
  if (body === "") {
    throw new Error(
      "no JSON object in the input (expected `homelab verify all --json` output)",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("not a verify result: expected a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.level !== "number") {
    throw new Error("not a verify result: `level` is not a number");
  }
  if (typeof r.pass !== "boolean") {
    throw new Error("not a verify result: `pass` is not a boolean");
  }
  if (!Array.isArray(r.checks)) {
    throw new Error("not a verify result: `checks` is not an array");
  }
  const checks: VerifyCheck[] = r.checks.map((c, i) => {
    if (typeof c !== "object" || c === null) {
      throw new Error(`checks[${i}] is not an object`);
    }
    const cc = c as Record<string, unknown>;
    if (typeof cc.name !== "string" || cc.name === "") {
      throw new Error(`checks[${i}].name is missing`);
    }
    if (!isStatus(cc.status)) {
      throw new Error(
        `checks[${i}] (${cc.name}): status ${JSON.stringify(cc.status)}`,
      );
    }
    const out: VerifyCheck = { name: cc.name, status: cc.status };
    if (typeof cc.duration_ms === "number") out.duration_ms = cc.duration_ms;
    if (typeof cc.detail === "string") out.detail = cc.detail;
    if (Array.isArray(cc.findings)) out.findings = cc.findings.map(String);
    return out;
  });
  const result: VerifyResult = { level: r.level, checks, pass: r.pass };
  if (typeof r.duration_ms === "number") result.duration_ms = r.duration_ms;
  return result;
}

/** toClaim reduces a result to the claim: level, pass and name -> status. */
export function toClaim(result: VerifyResult): Claim {
  const checks: Record<string, Status> = {};
  for (const name of result.checks.map((c) => c.name).sort()) {
    checks[name] = result.checks.find((c) => c.name === name)!.status;
  }
  return { level: result.level, pass: result.pass, checks };
}

/**
 * renderClaimBlock prints the PR-body block: the marker, then a fenced json
 * object with one check per line (sorted) so the block stays reviewable and a
 * refreshed claim diffs cleanly in the PR description history.
 */
export function renderClaimBlock(claim: Claim): string {
  const names = Object.keys(claim.checks).sort();
  const entries = names.map((n, i) =>
    `${JSON.stringify(n)}:${JSON.stringify(claim.checks[n])}${
      i < names.length - 1 ? "," : ""
    }`
  );
  return [
    MARKER,
    "```json",
    `{"level":${claim.level},"pass":${claim.pass},"checks":{`,
    ...entries,
    "}}",
    "```",
  ].join("\n") + "\n";
}

function parseClaim(text: string): Claim {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`the fenced block is not JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("the fenced block is not a JSON object");
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.level !== "number") throw new Error("`level` is missing");
  if (typeof r.pass !== "boolean") throw new Error("`pass` is missing");
  if (
    typeof r.checks !== "object" || r.checks === null || Array.isArray(r.checks)
  ) {
    throw new Error("`checks` must be an object of name -> status");
  }
  const checks: Record<string, Status> = {};
  for (
    const [name, status] of Object.entries(r.checks as Record<string, unknown>)
  ) {
    if (!isStatus(status)) {
      throw new Error(`check ${name}: status ${JSON.stringify(status)}`);
    }
    checks[name] = status;
  }
  return { level: r.level, pass: r.pass, checks };
}

export interface ExtractedClaim {
  /** The last well-formed claim block in the body, if any. */
  claim: Claim | null;
  /** Number of marker occurrences. */
  markers: number;
  /** Why the (last) block could not be used, when claim is null. */
  error: string | null;
}

/**
 * extractClaim finds `<!-- verify-level0 -->` followed (after optional
 * whitespace) by a ```json fence. The last well-formed block wins, so the PR
 * template's placeholder above a pasted claim is harmless. GitHub stores PR
 * bodies with CRLF line endings; they are normalised first.
 */
export function extractClaim(body: string): ExtractedClaim {
  const text = body.replace(/\r\n/g, "\n");
  let markers = 0;
  let claim: Claim | null = null;
  let error: string | null = null;
  let idx = text.indexOf(MARKER);
  while (idx !== -1) {
    markers++;
    const rest = text.slice(idx + MARKER.length);
    const m = rest.match(/^\s*```json[^\n]*\n([\s\S]*?)\n[ \t]*```/);
    if (!m) {
      error = "the marker is not followed by a ```json fenced block";
    } else {
      try {
        claim = parseClaim(m[1]);
        error = null;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    idx = text.indexOf(MARKER, idx + MARKER.length);
  }
  return { claim, markers, error: claim ? null : error };
}

// ============================================================================
// Comparison
// ============================================================================
export type Side = Status | "absent";

export interface Difference {
  name: string;
  claimed: Side;
  actual: Side;
}

export interface Comparison {
  ok: boolean;
  /** Top-level problems (level, overall pass). */
  problems: string[];
  /** Per-check differences that fail the contract. */
  failures: Difference[];
  /** skip <-> pass differences: reported, not failing. */
  warnings: Difference[];
  checkCount: number;
}

export function compareClaim(claim: Claim, actual: VerifyResult): Comparison {
  const problems: string[] = [];
  if (claim.level !== 0) {
    problems.push(
      `the claim is for level ${claim.level}; the contract is level 0 (\`task verify:claim\`)`,
    );
  }
  if (actual.level !== 0) {
    problems.push(
      `CI produced a level-${actual.level} result; the contract compares level 0`,
    );
  }
  const actualMap = toClaim(actual).checks;
  const names = [
    ...new Set([...Object.keys(claim.checks), ...Object.keys(actualMap)]),
  ].sort();
  const failures: Difference[] = [];
  const warnings: Difference[] = [];
  for (const name of names) {
    const claimed: Side = name in claim.checks ? claim.checks[name] : "absent";
    const got: Side = name in actualMap ? actualMap[name] : "absent";
    if (claimed === got) continue;
    const d = { name, claimed, actual: got };
    if (
      claimed === "absent" || got === "absent" || claimed === "fail" ||
      got === "fail"
    ) {
      failures.push(d);
    } else {
      warnings.push(d);
    }
  }
  if (claim.pass !== actual.pass) {
    problems.push(
      `the claim says level 0 ${claim.pass ? "passes" : "fails"}; CI says it ${
        actual.pass ? "passes" : "fails"
      }`,
    );
  }
  return {
    ok: problems.length === 0 && failures.length === 0,
    problems,
    failures,
    warnings,
    checkCount: Object.keys(actualMap).length,
  };
}

// ============================================================================
// Markdown
// ============================================================================
const HEADING = "## Verification claim (level 0)";

const HOW_TO = [
  "On the PR head, run:",
  "",
  "```bash",
  "task verify:claim",
  "```",
  "",
  `and paste its output (the \`${MARKER}\` line and the fenced JSON) into the **Verification** section`,
  "of the PR description, replacing any older block. Editing the description re-runs this check.",
];

export function renderMissing(reason: string): string {
  return [
    HEADING,
    "",
    `**Result:** MISSING. ${reason}`,
    "",
    "Every pull request states the level-0 result its author saw; CI re-runs level 0 on the same",
    'head and compares the two (issue #261 item 22, `docs/runbooks/verification.md` "Agent contract").',
    "",
    ...HOW_TO,
    "",
  ].join("\n");
}

function side(s: Side): string {
  return s === "absent" ? "_(absent)_" : `\`${s}\``;
}

const MAX_ROWS = 40;
const MAX_FINDINGS = 5;

export function renderComparison(
  cmp: Comparison,
  actual: VerifyResult,
  ref = "",
): string {
  const on = ref ? ` on \`${ref}\`` : "";
  const ciLine = `CI level 0${on}: **${
    actual.pass ? "PASS" : "FAIL"
  }** (${cmp.checkCount} checks).`;
  const out: string[] = [HEADING, ""];
  if (cmp.ok) {
    out.push(
      `**Result:** MATCH. The claim in the PR description agrees with CI. ${ciLine}`,
    );
    if (!actual.pass) {
      out.push(
        "",
        "Level 0 itself fails on this head; the claim says so honestly. `verify.yml` gates the failure.",
      );
    }
  } else {
    out.push(
      `**Result:** MISMATCH. The claim in the PR description does not agree with CI. ${ciLine}`,
    );
    if (cmp.problems.length > 0) {
      out.push("", ...cmp.problems.map((p) => `- ${p}`));
    }
    if (cmp.failures.length > 0) {
      out.push("", "| Check | Claimed | CI |", "|---|---|---|");
      for (const d of cmp.failures.slice(0, MAX_ROWS)) {
        out.push(`| \`${d.name}\` | ${side(d.claimed)} | ${side(d.actual)} |`);
      }
      if (cmp.failures.length > MAX_ROWS) {
        out.push(
          "",
          `... and ${cmp.failures.length - MAX_ROWS} more differences.`,
        );
      }
      const byName = new Map(actual.checks.map((c) => [c.name, c]));
      const failing = cmp.failures
        .map((d) => byName.get(d.name))
        .filter((c): c is VerifyCheck => c !== undefined && c.status === "fail")
        .slice(0, 10);
      if (failing.length > 0) {
        out.push(
          "",
          "<details><summary>CI findings for the differing checks</summary>",
          "",
        );
        for (const c of failing) {
          out.push(`**\`${c.name}\`** ${c.detail ?? ""}`.trimEnd());
          const f = c.findings ?? [];
          for (const line of f.slice(0, MAX_FINDINGS)) {
            out.push(`- ${line.replaceAll("\n", " ")}`);
          }
          if (f.length > MAX_FINDINGS) {
            out.push(`- ... ${f.length - MAX_FINDINGS} more`);
          }
          out.push("");
        }
        out.push("</details>");
      }
    }
    out.push(
      "",
      "A check CI runs that the claim does not list (or the reverse) means the claim is stale: the",
      "tree changed after `task verify:claim` ran. A `fail` on one side only means one of the two runs saw",
      "a problem the other did not; reproduce with `task verify:text` on the PR head.",
      "",
      ...HOW_TO,
    );
  }
  if (cmp.warnings.length > 0) {
    out.push(
      "",
      `<details><summary>${cmp.warnings.length} skip/pass difference(s), not failing</summary>`,
      "",
      "A `skip` usually means a tool (pluto, conftest, kubeconform) was missing on that side.",
      "",
      "| Check | Claimed | CI |",
      "|---|---|---|",
      ...cmp.warnings.slice(0, MAX_ROWS).map((d) =>
        `| \`${d.name}\` | ${side(d.claimed)} | ${side(d.actual)} |`
      ),
      "",
      "</details>",
    );
  }
  out.push("");
  return out.join("\n");
}

// ============================================================================
// CLI
// ============================================================================
const HELP =
  `verify-claim.ts: the level-0 claim in a PR description, rendered and checked

Usage:
  verify-claim.ts render [--input <file>]
      Read \`homelab verify all --level 0 --json\` (stdin by default) and print the
      PR-body claim block. \`task verify:claim\` runs exactly this.

  verify-claim.ts compare --actual <file> [--body-file <file>]
      Compare the claim in the PR body (--body-file, or env PR_BODY) with CI's
      level-0 JSON. Prints a markdown verdict on stdout; exit 0 = match,
      1 = missing/mismatch.

Options:
  --help, -h     This help.
  --ref <text>   (compare) Label for the commit CI verified, shown in the verdict.

Exit codes: 0 ok, 1 missing/mismatch/bad input, 2 usage.`;

interface Args {
  cmd: "render" | "compare" | "help";
  input: string | null;
  actual: string | null;
  bodyFile: string | null;
  ref: string;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    cmd: "help",
    input: null,
    actual: null,
    bodyFile: null,
    ref: "",
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      throw new UsageError(`${flag} requires a value`);
    }
    return v;
  };
  let sawCmd = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.cmd = "help";
      return args;
    } else if (a === "--input") args.input = need(++i, a);
    else if (a === "--actual") args.actual = need(++i, a);
    else if (a === "--body-file") args.bodyFile = need(++i, a);
    else if (a === "--ref") args.ref = need(++i, a);
    else if (!sawCmd && (a === "render" || a === "compare")) {
      args.cmd = a;
      sawCmd = true;
    } else throw new UsageError(`unknown argument: ${a}`);
  }
  if (!sawCmd) {
    throw new UsageError("a subcommand is required: render | compare");
  }
  if (args.cmd === "compare" && !args.actual) {
    throw new UsageError("compare requires --actual <file>");
  }
  return args;
}

async function readStdin(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

async function cmdRender(args: Args): Promise<number> {
  const text = args.input
    ? await Deno.readTextFile(args.input)
    : await readStdin();
  let result: VerifyResult;
  try {
    result = parseVerifyResult(text);
  } catch (e) {
    log.error(`cannot build a claim: ${(e as Error).message}`);
    log.error(
      "level 0 did not produce its JSON result; run `task verify:text` to see why",
    );
    return 1;
  }
  if (result.level !== 0) {
    log.error(`the claim is level 0 only; got a level-${result.level} result`);
    return 1;
  }
  const claim = toClaim(result);
  console.log(renderClaimBlock(claim).trimEnd());
  const n = Object.keys(claim.checks).length;
  if (result.pass) {
    log.ok(
      `level 0 passes (${n} checks); paste the block above into the PR description`,
    );
  } else {
    const failed = result.checks.filter((c) => c.status === "fail").map((c) =>
      c.name
    );
    log.warn(
      `level 0 FAILS (${failed.length} of ${n}): ${
        failed.slice(0, 5).join(", ")
      }${failed.length > 5 ? ", ..." : ""}`,
    );
    log.warn(
      "the block records that honestly; fix the findings (`task verify:text`) before marking the PR ready",
    );
  }
  return 0;
}

async function cmdCompare(args: Args): Promise<number> {
  let body: string;
  if (args.bodyFile) {
    body = await Deno.readTextFile(args.bodyFile);
  } else {
    const env = Deno.env.get("PR_BODY");
    if (env === undefined) {
      log.error("no PR body: pass --body-file <file> or set PR_BODY");
      return 2;
    }
    body = env;
  }
  let actual: VerifyResult;
  try {
    actual = parseVerifyResult(await Deno.readTextFile(args.actual!));
  } catch (e) {
    console.log([
      HEADING,
      "",
      `**Result:** ERROR. CI could not produce a level-0 result to compare with: ${
        (e as Error).message
      }.`,
      "See the `task verify` step log of this run.",
      "",
    ].join("\n"));
    log.error(`--actual ${args.actual}: ${(e as Error).message}`);
    return 1;
  }
  const extracted = extractClaim(body);
  if (!extracted.claim) {
    const reason = extracted.markers === 0
      ? `The PR description has no \`${MARKER}\` block.`
      : `The \`${MARKER}\` block in the PR description is unusable: ${extracted.error}.`;
    console.log(renderMissing(reason));
    log.error(reason);
    return 1;
  }
  const cmp = compareClaim(extracted.claim, actual);
  console.log(renderComparison(cmp, actual, args.ref));
  if (cmp.ok) {
    log.ok(
      `claim matches CI (${cmp.checkCount} checks, ${cmp.warnings.length} skip/pass warnings)`,
    );
    return 0;
  }
  log.error(
    `claim does not match CI: ${cmp.problems.length} problem(s), ${cmp.failures.length} differing check(s)`,
  );
  return 1;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(Deno.args);
  } catch (e) {
    if (e instanceof UsageError) {
      log.error(e.message);
      console.error(HELP);
      return 2;
    }
    throw e;
  }
  switch (args.cmd) {
    case "help":
      console.log(HELP);
      return 0;
    case "render":
      return await cmdRender(args);
    case "compare":
      return await cmdCompare(args);
  }
}

if (import.meta.main) {
  Deno.exit(await main());
}
