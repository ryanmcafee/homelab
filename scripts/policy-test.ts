#!/usr/bin/env -S deno run --allow-read --allow-run --allow-env

/**
 * policy-test.ts
 *
 * Fixture test runner for the conftest/Rego policies in tests/policy/.
 *
 * For every tests/policy/negative/<rule-id>.yaml (whose first line is a
 * `# expect: <rule-id>` header) this asserts conftest reports at least one
 * failure whose message is prefixed `[<rule-id>]`. For every
 * tests/policy/positive/*.yaml this asserts conftest reports zero failures.
 *
 * This complements (does not replace) the Rego unit tests run by
 * `conftest verify -p tests/policy`.
 *
 * Usage:
 *   deno run --allow-read --allow-run --allow-env scripts/policy-test.ts
 *   deno run ... scripts/policy-test.ts --help
 *   deno run ... scripts/policy-test.ts --policy-dir tests/policy --fixtures-dir tests/policy
 *   deno run ... scripts/policy-test.ts --conftest .tools/conftest
 *
 * Exit codes: 0 = all fixtures behave as expected; 1 = any mismatch.
 */

// ============================================================================
// Logging
// ============================================================================
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const log = {
  info: (msg: string) => console.log(`${cyan("INFO")}  ${msg}`),
  ok: (msg: string) => console.log(`${green("OK")}    ${msg}`),
  error: (msg: string) => console.error(`${red("ERROR")} ${msg}`),
};

// ============================================================================
// CLI args
// ============================================================================
interface Args {
  help: boolean;
  policyDir: string;
  fixturesDir: string;
  conftest: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    help: false,
    policyDir: "tests/policy",
    fixturesDir: "tests/policy",
    conftest: "conftest",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--policy-dir") {
      args.policyDir = argv[++i];
    } else if (a.startsWith("--policy-dir=")) {
      args.policyDir = a.slice("--policy-dir=".length);
    } else if (a === "--fixtures-dir") {
      args.fixturesDir = argv[++i];
    } else if (a.startsWith("--fixtures-dir=")) {
      args.fixturesDir = a.slice("--fixtures-dir=".length);
    } else if (a === "--conftest") {
      args.conftest = argv[++i];
    } else if (a.startsWith("--conftest=")) {
      args.conftest = a.slice("--conftest=".length);
    } else {
      log.error(`Unknown argument: ${a}`);
      Deno.exit(2);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`policy-test.ts — conftest/Rego policy fixture test runner

Usage:
  deno run --allow-read --allow-run --allow-env scripts/policy-test.ts [flags]

Flags:
  --help, -h             Show this help and exit 0
  --policy-dir <dir>      Rego policy directory (default: tests/policy)
  --fixtures-dir <dir>    Directory containing negative/ and positive/ fixtures
                          (default: tests/policy)
  --conftest <path>       conftest binary to invoke (default: conftest)

Behavior:
  For each <fixtures-dir>/negative/<rule-id>.yaml (first line "# expect: <rule-id>"),
  asserts conftest reports a failure whose message starts with "[<rule-id>]".
  For each <fixtures-dir>/positive/*.yaml, asserts conftest reports zero failures.

Exit codes:
  0  All fixtures matched their expectation
  1  Any fixture mismatched, or conftest could not be run
  2  Argument error
`);
}

// ============================================================================
// conftest invocation
// ============================================================================
interface ConftestFailure {
  msg: string;
}

interface ConftestResult {
  filename: string;
  namespace: string;
  successes?: number;
  failures?: ConftestFailure[];
}

async function runConftest(
  conftestBin: string,
  policyDir: string,
  dataFile: string,
  file: string,
): Promise<ConftestResult[]> {
  const cmd = new Deno.Command(conftestBin, {
    args: [
      "test",
      "-p",
      policyDir,
      "--all-namespaces",
      "--data",
      dataFile,
      "-o",
      "json",
      file,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout, stderr, code } = await cmd.output();
  const stdoutText = new TextDecoder().decode(stdout);
  const stderrText = new TextDecoder().decode(stderr);

  // conftest test exits non-zero both on policy failures (expected — that's
  // what we're testing for) and on real errors (missing binary, bad Rego).
  // Only a real error produces no parseable JSON on stdout.
  let parsed: ConftestResult[];
  try {
    parsed = JSON.parse(stdoutText);
  } catch {
    throw new Error(
      `conftest failed to run against ${file} (exit ${code}):\n${stderrText || stdoutText}`,
    );
  }
  return parsed;
}

function allFailureMessages(results: ConftestResult[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    for (const f of r.failures ?? []) out.push(f.msg);
  }
  return out;
}

// ============================================================================
// Fixture discovery
// ============================================================================
async function listYamlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && entry.name.endsWith(".yaml") && !entry.name.startsWith("_")) {
        out.push(`${dir}/${entry.name}`);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
  out.sort();
  return out;
}

async function expectedRuleId(file: string): Promise<string> {
  const text = await Deno.readTextFile(file);
  const firstLine = text.split("\n", 1)[0];
  const m = firstLine.match(/^#\s*expect:\s*(\S+)\s*$/);
  if (!m) {
    throw new Error(
      `${file}: first line must be "# expect: <rule-id>", got ${JSON.stringify(firstLine)}`,
    );
  }
  return m[1];
}

// ============================================================================
// Test cases
// ============================================================================
interface CaseResult {
  name: string;
  kind: "negative" | "positive";
  expect: string;
  ok: boolean;
  detail: string;
}

async function runNegativeCase(
  args: Args,
  file: string,
  dataFile: string,
): Promise<CaseResult> {
  const expect = await expectedRuleId(file);
  const name = file.split("/").pop()!;
  try {
    const results = await runConftest(args.conftest, args.policyDir, dataFile, file);
    const messages = allFailureMessages(results);
    const prefix = `[${expect}]`;
    const matched = messages.some((m) => m.startsWith(prefix));
    if (matched) {
      return { name, kind: "negative", expect, ok: true, detail: "" };
    }
    const got = messages.length > 0 ? messages.join("; ") : "(no failures reported)";
    return {
      name,
      kind: "negative",
      expect,
      ok: false,
      detail: `expected a failure prefixed "${prefix}", got: ${got}`,
    };
  } catch (err) {
    return {
      name,
      kind: "negative",
      expect,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runPositiveCase(
  args: Args,
  file: string,
  dataFile: string,
): Promise<CaseResult> {
  const name = file.split("/").pop()!;
  try {
    const results = await runConftest(args.conftest, args.policyDir, dataFile, file);
    const messages = allFailureMessages(results);
    if (messages.length === 0) {
      return { name, kind: "positive", expect: "(none)", ok: true, detail: "" };
    }
    return {
      name,
      kind: "positive",
      expect: "(none)",
      ok: false,
      detail: `expected zero failures, got: ${messages.join("; ")}`,
    };
  } catch (err) {
    return {
      name,
      kind: "positive",
      expect: "(none)",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================================
// Results table
// ============================================================================
function printResultsTable(results: CaseResult[]): void {
  console.log("");
  console.log("Policy Fixture Results");
  console.log("=======================");
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  console.log(`${pad("Kind", 10)}${pad("Fixture", 28)}${pad("Expect", 20)}Result`);
  console.log(`${pad("----", 10)}${pad("-------", 28)}${pad("------", 20)}------`);
  for (const r of results) {
    const cell = r.ok ? green("PASS") : red("FAIL");
    console.log(`${pad(r.kind, 10)}${pad(r.name, 28)}${pad(r.expect, 20)}${cell}`);
  }
  console.log("");
  for (const r of results) {
    if (!r.ok) console.log(red(`--- ${r.name}: ${r.detail}`));
  }
}

// ============================================================================
// Main
// ============================================================================
async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  if (args.help) {
    printHelp();
    return 0;
  }

  const negativeDir = `${args.fixturesDir}/negative`;
  const positiveDir = `${args.fixturesDir}/positive`;
  const dataFile = `${negativeDir}/_data.yaml`;

  try {
    await Deno.stat(dataFile);
  } catch {
    log.error(`missing ${dataFile} (needed for --data)`);
    return 1;
  }

  const negativeFiles = await listYamlFiles(negativeDir);
  const positiveFiles = await listYamlFiles(positiveDir);

  if (negativeFiles.length === 0) {
    log.error(`no fixtures found under ${negativeDir}`);
    return 1;
  }

  log.info(
    `Running ${negativeFiles.length} negative and ${positiveFiles.length} positive fixture(s) with ${args.conftest}`,
  );

  const results: CaseResult[] = [];
  for (const f of negativeFiles) {
    results.push(await runNegativeCase(args, f, dataFile));
  }
  for (const f of positiveFiles) {
    results.push(await runPositiveCase(args, f, dataFile));
  }

  printResultsTable(results);

  const allOk = results.every((r) => r.ok);
  if (allOk) {
    log.ok(`All ${results.length} policy fixtures behaved as expected`);
    return 0;
  }
  const failCount = results.filter((r) => !r.ok).length;
  log.error(`${failCount} of ${results.length} policy fixtures mismatched — see table above`);
  return 1;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
