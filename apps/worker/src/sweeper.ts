import type { Database } from "@wukong/db";
import { listingJobSchema, websiteJobSchema } from "@wukong/jobs";

import { createWorkerDatabase } from "./cloudflare-runtime.js";
import type { WorkerEnv } from "./worker-env.js";

// Older than the pipeline step lease (300s) so nothing legitimately in flight
// is ever swept; small batch per tick keeps the 5-connection pool and the
// consumer's retry budget safe.
const SWEEP_OLDER_THAN_SECONDS = 300;
const SWEEP_MAX_ROWS = 20;

/**
 * How long a recorded-but-unsent job waits before the cron re-sends it.
 *
 * Must stay longer than the web app's own OUTBOX_GRACE_SECONDS (60), or a tick
 * would re-send messages an advance is still in the middle of sending. Sharing
 * the draft sweeper's 300s keeps one number to reason about.
 */
const OUTBOX_OLDER_THAN_SECONDS = 300;
const OUTBOX_MAX_ROWS = 20;
/**
 * After this many failed sends the row stops being offered.
 *
 * A payload the queue will never accept would otherwise be retried every five
 * minutes for the life of the system. The row is left in the table rather than
 * deleted: it is still the evidence that work was owed.
 */
const OUTBOX_MAX_ATTEMPTS = 5;

type SweeperDatabase = Pick<
  Database,
  "findStuckWebsiteScans" | "forWorkspace"
> & {
  findStuckListingJobs(input: {
    olderThanSeconds: number;
    maxRows: number;
  }): Promise<
    Array<{
      workspaceId: string;
      draftId: string;
      activeVersionSequence: number;
    }>
  >;
  findUndispatchedListingJobs(input: {
    olderThanSeconds: number;
    maxRows: number;
    maxAttempts: number;
  }): Promise<
    Array<{
      workspaceId: string;
      outboxId: string;
      payload: Record<string, unknown>;
    }>
  >;
  close(): Promise<void>;
};

/** Groups ids by workspace, since every outbox write is workspace-scoped. */
function addTo(
  groups: Map<string, string[]>,
  workspaceId: string,
  outboxId: string,
): void {
  const existing = groups.get(workspaceId);
  if (existing) existing.push(outboxId);
  else groups.set(workspaceId, [outboxId]);
}

/**
 * Sends work the outbox recorded and nothing ever confirmed.
 *
 * `dispatchOutbox.pending()` is read in exactly one place -- inside
 * `advanceBatch` -- and `advanceBatch` runs only when an operator presses
 * Advance on that one batch. A workspace whose batches have all reached
 * `completed` or `budget_exhausted`, or which nobody touches again, never
 * re-reads its own outbox, and the work stays owed for ever. The cron is the
 * only thing here that runs without being asked.
 *
 * Kept separate from the draft sweeper's counters, and reported on its own
 * line, so a healthy draft sweep cannot make a failing outbox sweep look fine.
 */
async function recoverOutbox(
  database: SweeperDatabase,
  env: WorkerEnv,
): Promise<void> {
  const owed = await database.findUndispatchedListingJobs({
    olderThanSeconds: OUTBOX_OLDER_THAN_SECONDS,
    maxRows: OUTBOX_MAX_ROWS,
    maxAttempts: OUTBOX_MAX_ATTEMPTS,
  });
  let requeued = 0;
  let failed = 0;
  const dispatched = new Map<string, string[]>();
  const attempted = new Map<string, string[]>();

  for (const row of owed) {
    const parsed = listingJobSchema.safeParse(row.payload);
    // Workspace scoping is the security boundary, so the row's workspace and
    // the payload's must agree: a row naming another tenant must never reach
    // the queue, whatever wrote it.
    if (!parsed.success || parsed.data.workspaceId !== row.workspaceId) {
      // Counted as an attempt rather than skipped in silence. The draft
      // sweeper can simply `continue` because its rows are re-derived every
      // tick; an outbox row is durable, so unless something records the
      // attempt it can never reach the cap and is retried for ever.
      addTo(attempted, row.workspaceId, row.outboxId);
      failed += 1;
      console.error(
        JSON.stringify({
          event: "outbox_sweeper.unusable",
          workspaceId: row.workspaceId,
          outboxId: row.outboxId,
          reason: parsed.success ? "workspace_mismatch" : "payload_invalid",
        }),
      );
      continue;
    }
    try {
      await env.LISTING_QUEUE.send(parsed.data);
      addTo(dispatched, row.workspaceId, row.outboxId);
      requeued += 1;
      console.info(
        JSON.stringify({
          event: "outbox_sweeper.requeued",
          workspaceId: row.workspaceId,
          listingId: parsed.data.draftId,
          activeVersionSequence: parsed.data.activeVersionSequence,
        }),
      );
    } catch (error) {
      // Never confirmed: nothing else reads the outbox, so a row wrongly
      // marked dispatched is work lost permanently.
      addTo(attempted, row.workspaceId, row.outboxId);
      failed += 1;
      console.error(
        JSON.stringify({
          event: "outbox_sweeper.send_failed",
          workspaceId: row.workspaceId,
          outboxId: row.outboxId,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  for (const [workspaceId, ids] of dispatched) {
    await database.forWorkspace(workspaceId, (repositories) =>
      repositories.dispatchOutbox.markDispatched(ids),
    );
  }
  for (const [workspaceId, ids] of attempted) {
    await database.forWorkspace(workspaceId, (repositories) =>
      repositories.dispatchOutbox.markAttempted(ids),
    );
  }

  console.info(
    JSON.stringify({ event: "outbox_sweeper.completed", requeued, failed }),
  );
}

type SweeperDependencies = {
  createDatabase?: (env: WorkerEnv) => SweeperDatabase;
};

export async function handleScheduled(
  _controller: ScheduledController,
  env: WorkerEnv,
  _context: ExecutionContext,
  dependencies: SweeperDependencies = {},
): Promise<void> {
  const database = (dependencies.createDatabase ?? createWorkerDatabase)(env);
  try {
    const jobs = await database.findStuckListingJobs({
      olderThanSeconds: SWEEP_OLDER_THAN_SECONDS,
      maxRows: SWEEP_MAX_ROWS,
    });
    let requeued = 0;
    let failed = 0;
    for (const job of jobs) {
      const parsed = listingJobSchema.safeParse(job);
      if (!parsed.success) continue;
      try {
        await env.LISTING_QUEUE.send(parsed.data);
        requeued += 1;
        console.info(
          JSON.stringify({
            event: "sweeper.requeued",
            workspaceId: parsed.data.workspaceId,
            listingId: parsed.data.draftId,
            activeVersionSequence: parsed.data.activeVersionSequence,
          }),
        );
      } catch (error) {
        failed += 1;
        console.error(
          JSON.stringify({
            event: "sweeper.requeue_failed",
            workspaceId: parsed.data.workspaceId,
            listingId: parsed.data.draftId,
            activeVersionSequence: parsed.data.activeVersionSequence,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    const websiteScans = await database.findStuckWebsiteScans({ maxRows: 10 });
    for (const scan of websiteScans) {
      const parsed = websiteJobSchema.safeParse({
        kind: "website_scan",
        ...scan,
      });
      if (!parsed.success) continue;
      let status: "sent" | "failed" = "sent";
      try {
        await env.LISTING_QUEUE.send(parsed.data);
        requeued++;
      } catch {
        status = "failed";
        failed++;
      }
      await database.forWorkspace(scan.workspaceId, (repositories) =>
        repositories.websiteCatalog.recordDispatch({
          ...scan,
          status,
          now: new Date(),
        }),
      );
    }
    console.info(
      JSON.stringify({ event: "sweeper.completed", requeued, failed }),
    );
    await recoverOutbox(database, env);
  } finally {
    await database.close();
  }
}
