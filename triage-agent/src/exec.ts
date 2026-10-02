export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

/** Runs a program without a shell; tests substitute a recording fake. */
export type Exec = (
  cmd: readonly string[],
  opts?: ExecOptions,
) => Promise<ExecResult>;

export const exec: Exec = async (cmd, opts = {}) => {
  const proc = Bun.spawn([...cmd], {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export class CommandError extends Error {
  constructor(
    readonly cmd: readonly string[],
    readonly result: ExecResult,
  ) {
    super(
      `${cmd.slice(0, 2).join(" ")} failed (exit ${result.code}): ${result.stderr.trim().slice(-2000)}`,
    );
  }
}

/** Like exec, but throws CommandError on a non-zero exit. */
export async function must(
  run: Exec,
  cmd: readonly string[],
  opts?: ExecOptions,
): Promise<string> {
  const result = await run(cmd, opts);
  if (result.code !== 0) throw new CommandError(cmd, result);
  return result.stdout;
}
