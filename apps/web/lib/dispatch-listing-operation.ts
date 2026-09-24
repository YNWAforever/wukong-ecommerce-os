import { listingJobSchema, wineListingJobSchema } from "@wukong/jobs";
import type { AcceptedListingOperation } from "./listing-operation-service";
import type { ListingPublisher } from "./listing-queue-runtime";
import type { Database } from "@wukong/db";

/** Post-commit optimization. The outbox owns recovery even if this request dies. */
export async function dispatchListingOperation(
  database: Pick<Database, "forWorkspace">,
  workspaceId: string,
  accepted: AcceptedListingOperation,
  publisher: ListingPublisher,
): Promise<void> {
  for (const row of accepted.outbox) {
    try {
      const job = listingJobSchema.or(wineListingJobSchema).parse(row.payload);
      if (
        job.workspaceId !== workspaceId ||
        (job.runId && job.runId !== accepted.run.id)
      )
        throw Error("operation outbox mismatch");
      await publisher.enqueue(job);
      await database.forWorkspace(workspaceId, (repos) =>
        repos.dispatchOutbox.markDispatched([row.id]),
      );
    } catch {
      try {
        await database.forWorkspace(workspaceId, (repos) =>
          repos.dispatchOutbox.markAttempted([row.id]),
        );
      } catch {
        /* The committed outbox remains the recovery authority. */
      }
      console.info(
        JSON.stringify({
          event: "listing.dispatch_pending",
          runId: accepted.run.id,
        }),
      );
    }
  }
}
