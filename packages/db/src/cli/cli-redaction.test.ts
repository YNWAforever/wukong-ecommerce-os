import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

// These CLIs run against production. No failure may print a password or host.
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const cli = (path: string) => fileURLToPath(new URL(path, import.meta.url));

async function run(script: string, env: Record<string, string>) {
  return promisify(execFile)(process.execPath, ["--import", "tsx", script], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
    timeout: 60_000,
  }).then(
    ({ stdout, stderr }) => ({ code: 0, output: `${stdout}${stderr}` }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: typeof error.code === "number" ? error.code : -1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    }),
  );
}

const MALFORMED = "postgres://prodrec:se#cretpw@db.internal.example/x";
const UNREACHABLE = "postgres://prodrec:secretpw@127.0.0.1:1/x";

describe("CLI failure output carries no connection details", () => {
  it.each([
    ["schema-inventory", { DATABASE_ADMIN_URL: MALFORMED }],
    [
      "listing-read-verify",
      { DATABASE_ADMIN_URL: MALFORMED, DATABASE_URL: MALFORMED },
    ],
    [
      "listing-read-verify",
      { DATABASE_ADMIN_URL: UNREACHABLE, DATABASE_URL: MALFORMED },
    ],
    ["migrate", { DATABASE_URL: UNREACHABLE, DATABASE_ADMIN_URL: UNREACHABLE }],
    ["migrate", { DATABASE_URL: MALFORMED, DATABASE_ADMIN_URL: MALFORMED }],
  ])("%s exits 1 without the URL", async (name, env) => {
    const script =
      name === "migrate" ? cli("../migrate.ts") : cli(`./${name}.ts`);
    const { code, output } = await run(script, env);
    expect(code).toBe(1);
    for (const secret of [
      "secretpw",
      "cretpw",
      "db.internal.example",
      "127.0.0.1:1",
      "prodrec:",
    ])
      expect(output).not.toContain(secret);
  });
});
