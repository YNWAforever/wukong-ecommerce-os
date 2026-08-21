import { listingJobSchema } from "@wukong/jobs";

import { createWorkerDatabase } from "./cloudflare-runtime.js";
import type { WorkerEnv } from "./worker-env.js";

// Older than the pipeline step lease (300s) so nothing legitimately in flight
// is ever swept; small batch per tick keeps the 5-connection pool and the
// consumer's retry budget safe.
const SWEEP_OLDER_THAN_SECONDS = 300;
const SWEEP_MAX_ROWS = 20;

type SweeperDatabase = {
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
  close(): Promise<void>;
};

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
    console.info(
      JSON.stringify({ event: "sweeper.completed", requeued, failed }),
    );
  } finally {
    await database.close();
  }
}
