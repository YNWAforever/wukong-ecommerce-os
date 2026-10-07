import { createDatabase } from "./client.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_ADMIN_URL;

if (!runtimeUrl || !migrationUrl) {
  throw new Error("DATABASE_URL and DATABASE_ADMIN_URL are required");
}

// Production runs this, so a failure prints a code only. The raw error can
// carry the host, the role name or (for a malformed URL) the whole URL; the
// failing file is already logged by migrate() as `migration_failed`.
let database: ReturnType<typeof createDatabase> | undefined;
try {
  database = createDatabase(runtimeUrl, { migrationUrl });
  await database.migrate();
} catch (error) {
  let code: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && code === undefined; depth++) {
    if (typeof current !== "object" || current === null) break;
    const candidate = (current as { code?: unknown }).code;
    if (typeof candidate === "string") code = candidate;
    current = (current as { cause?: unknown }).cause;
  }
  console.error(
    JSON.stringify({
      event: "migrate_failed",
      code: code ?? (error instanceof Error ? error.name : "UnknownError"),
    }),
  );
  process.exitCode = 1;
} finally {
  await database?.close().catch(() => undefined);
}
