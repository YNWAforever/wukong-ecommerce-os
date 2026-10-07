export type MigrationTimeouts = {
  lockTimeoutMs: number | null;
  statementTimeoutMs: number | null;
};

const MAX_TIMEOUT_MS = 600_000;

function readTimeout(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/u.test(value)) throw new Error("invalid migration timeout");
  const ms = Number(value);
  if (ms < 1 || ms > MAX_TIMEOUT_MS)
    throw new Error("invalid migration timeout");
  return ms;
}

/**
 * Per-file bounds for a controlled migration run. Unset keeps today's
 * unbounded behaviour; anything else must be a whole number of milliseconds,
 * and is rejected before the runner opens a connection.
 */
export function migrationTimeouts(env: NodeJS.ProcessEnv): MigrationTimeouts {
  return {
    lockTimeoutMs: readTimeout(env.DATABASE_MIGRATION_LOCK_TIMEOUT_MS),
    statementTimeoutMs: readTimeout(
      env.DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS,
    ),
  };
}
