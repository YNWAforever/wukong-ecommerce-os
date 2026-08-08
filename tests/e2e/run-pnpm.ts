import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run a pnpm script to completion.
 *
 * On Windows the pnpm shim is `pnpm.cmd`, a batch file rather than an
 * executable, so it has to go through the command interpreter. Every other
 * platform runs `pnpm` directly — naming the `.cmd` shim there resolves to
 * nothing and fails with "command not found".
 */
export async function runPnpm(args: string[], env: NodeJS.ProcessEnv) {
  const windows = process.platform === "win32";
  const command = windows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
  const commandArgs = windows
    ? ["/d", "/s", "/c", ["pnpm.cmd", ...args].join(" ")]
    : args;
  await execFileAsync(command, commandArgs, {
    cwd: process.cwd(),
    env,
  });
}
