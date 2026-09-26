import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Exec, exec, must } from "../../src/exec.ts";

export const realExec: Exec = exec;

export function tempRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const git = (dir: string, ...args: string[]) =>
  must(exec, ["git", ...args], { cwd: dir });

export async function commitAll(dir: string, message: string) {
  await git(dir, "add", "-A");
  await git(
    dir,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "-m",
    message,
  );
}

export async function makeRepo(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  await commitAll(dir, "init");
  return dir;
}

/** Records every command and answers from `responses` by command prefix. */
export function fakeExec(
  responses: Record<string, { code?: number; stdout?: string }> = {},
) {
  const calls: string[] = [];
  const run: Exec = async (cmd) => {
    const line = cmd.join(" ");
    calls.push(line);
    const key = Object.keys(responses)
      .filter((k) => line.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const r = key === undefined ? {} : (responses[key] ?? {});
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}
