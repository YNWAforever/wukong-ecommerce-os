import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { createDatabase, type Database } from "../client.js";
import { computeCurrentContentGaps } from "../quality-content-assessor.js";
import type { QualityProjectionSummary } from "../repositories/quality-projection.js";
export type QualityBackfillOptions = {
  workspaceId: string;
  maxBatches: number;
  timeBudgetMs: number;
};
export function parseQualityBackfillOptions(
  args: string[],
  url: string | undefined,
): QualityBackfillOptions {
  if (!url) throw Error("local quality database URL required");
  const target = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/opak_fixes_[a-z0-9_]+$/.test(target.pathname) ||
    target.username !== "wukong_app"
  )
    throw Error(
      "quality backfill requires a dedicated loopback database and nonbypass app role",
    );
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!,
      value = args[index + 1];
    if (
      !["--workspace-id", "--max-batches", "--time-budget-ms"].includes(key) ||
      !value ||
      values.has(key)
    )
      throw Error("invalid quality backfill arguments");
    values.set(key, value);
  }
  const workspaceId = values.get("--workspace-id"),
    maxBatches = Number(values.get("--max-batches") ?? 10),
    timeBudgetMs = Number(values.get("--time-budget-ms") ?? 30000);
  if (
    !workspaceId ||
    workspaceId.trim() !== workspaceId ||
    workspaceId.length > 200 ||
    /[\x00-\x1f]/.test(workspaceId) ||
    !Number.isInteger(maxBatches) ||
    maxBatches < 1 ||
    maxBatches > 1000 ||
    !Number.isInteger(timeBudgetMs) ||
    timeBudgetMs < 1000 ||
    timeBudgetMs > 60000
  )
    throw Error("invalid quality backfill scope or budgets");
  return { workspaceId, maxBatches, timeBudgetMs };
}
export async function runQualityBackfill(
  database: Pick<Database, "forWorkspace">,
  options: QualityBackfillOptions,
  clock: {
    now(): number;
    onBatch?(summary: QualityProjectionSummary, batches: number): void;
  } = { now: () => Date.now() },
) {
  const started = clock.now();
  let batches = 0,
    summary: QualityProjectionSummary | undefined;
  while (
    batches < options.maxBatches &&
    clock.now() - started < options.timeBudgetMs
  ) {
    summary = await database.forWorkspace(options.workspaceId, (r) =>
      r.qualityProjection.reconcile(computeCurrentContentGaps, { limit: 25 }),
    );
    batches++;
    clock.onBatch?.(summary, batches);
    if (!summary.projection.pendingCount) break;
  }
  if (!summary)
    throw Error("quality backfill deadline elapsed before first batch");
  // One live cost observation after bounded work; never scan historical run metadata once per listing/batch.
  const cost = await database.forWorkspace(options.workspaceId, async (r) => {
    const observed = await r.aiRuns.summarizeOwnedCostMetadata();
    await r.qualityProjection.recordCostSnapshot({
      knownCostUsd: observed.knownCostUsd,
      unknownCostRunCount: observed.unknownCostRunCount,
      asOf: observed.unknownCostReferences.asOf,
    });
    return observed;
  });
  return {
    assessmentVersion: summary.assessmentVersion,
    workspaceDigest: createHash("sha256")
      .update(options.workspaceId)
      .digest("hex")
      .slice(0, 16),
    completed: !summary.projection.stale,
    batches,
    elapsedMs: Math.max(0, clock.now() - started),
    state: summary.projection.state,
    asOf: summary.projection.asOf,
    pendingCount: summary.projection.pendingCount,
    failedCount: summary.projection.failedCount,
    totalListings: summary.totalListings,
    totalAssessed: summary.totalAssessed,
    knownCostUsd: cost.knownCostUsd,
    unknownCostRunCount: cost.unknownCostRunCount,
    costAsOf: cost.unknownCostReferences.asOf,
  };
}
async function main() {
  const options = parseQualityBackfillOptions(
    process.argv.slice(2),
    process.env.DATABASE_URL,
  );
  // Query timeout plus own-pool termination bounds blocked work across the full command.
  let abortQueries: (() => Promise<void>) | undefined;
  let deadlineExpired = false;
  let lastCommitted: {
    batches: number;
    pendingCount: number;
    failedCount: number;
    asOf: string | null;
  } | null = null;
  const createClient = Object.assign(
    (url: string, config?: postgres.Options<{}>) => {
      const connection = postgres(url, {
        ...config,
        connection: {
          statement_timeout: Math.min(options.timeBudgetMs, 10000),
        },
      });
      abortQueries = () => connection.end({ timeout: 0 });
      return connection;
    },
    postgres,
  ) as typeof postgres;
  const database = createDatabase(process.env.DATABASE_URL!, {
    maxConnections: 1,
    createClient,
  });
  const timer = setTimeout(() => {
    deadlineExpired = true;
    void abortQueries?.().catch(() => undefined);
  }, options.timeBudgetMs);
  try {
    const result = await runQualityBackfill(database, options, {
      now: () => Date.now(),
      onBatch(summary, batches) {
        lastCommitted = {
          batches,
          pendingCount: summary.projection.pendingCount,
          failedCount: summary.projection.failedCount,
          asOf: summary.projection.asOf,
        };
      },
    });
    process.stdout.write(
      JSON.stringify({ event: "quality_backfill", ...result }) + "\n",
    );
    if (!result.completed) process.exitCode = 2;
  } catch (error) {
    if (!deadlineExpired) throw error;
    process.stdout.write(
      JSON.stringify({
        event: "quality_backfill",
        outcome: "partial",
        reason: "deadline_exhausted",
        completed: false,
        lastCommitted,
      }) + "\n",
    );
    process.exitCode = 2;
  } finally {
    clearTimeout(timer);
    await database.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    process.stderr.write(
      JSON.stringify({ event: "quality_backfill", outcome: "failed" }) + "\n",
    );
    process.exitCode = 1;
  });
}
