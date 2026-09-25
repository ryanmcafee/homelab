/**
 * The `homelab verify ... --json` result contract (internal/verify/types.go):
 * types and a parser that tolerates `task verify`'s trailing failure line.
 */

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
