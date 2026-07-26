import { type ListingJob } from "@wukong/jobs";

import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  listingApplicationJobId,
  listingPublisher,
  type ListingPublisher,
} from "../../../../../lib/listing-queue-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };

type ProcessListingRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  publisher: ListingPublisher;
};

export function createProcessListingHandler(deps: ProcessListingRouteDeps) {
  return async function processListing(
    _request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", session.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      }

      const input = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const listing = await repositories.listings.getById(id);
          if (!listing) {
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          }
          // The workflow state machine allows processing to start from exactly
          // these: received/needs_info via start_processing, failed via retry.
          // Without `failed` an operator had no way to re-drive a listing the
          // pipeline gave up on, so it sat unreachable until an engineer
          // replayed the dead-letter queue by hand.
          const retryableStatuses = new Set([
            "received",
            "needs_info",
            "failed",
          ]);
          if (!retryableStatuses.has(listing.status)) {
            throw new ApiError(
              409,
              "listing_not_retryable",
              "This listing cannot start processing in its current state.",
            );
          }

          const revision = await repositories.listings.requireById(id);
          const assets = await repositories.sourceAssets.listForListing(id);
          if (assets.length === 0) {
            throw new ApiError(
              409,
              "listing_has_no_assets",
              "The listing has no finalized source assets.",
            );
          }

          const input = {
            workspaceId: session.workspaceId,
            draftId: id,
            activeVersionSequence: revision.activeVersionSequence,
          } satisfies ListingJob;
          const key = listingApplicationJobId(input);
          const runState = await repositories.pipelineRuns.getState(key);
          if (runState && runState.status !== "failed") {
            // `started` means a delivery is still working on it; `succeeded`
            // means it is already done. Only a failed run may be re-driven.
            throw new ApiError(
              409,
              "processing_already_started",
              "Processing has already started.",
            );
          }
          if (runState) await repositories.pipelineRuns.reopenFailed(key);

          return input;
        });

      try {
        const job = await deps.publisher.enqueue(input);
        return jsonResponse(202, {
          processing: { state: "queued", jobId: job.id },
        });
      } catch {
        throw new ApiError(
          503,
          "queue_unavailable",
          "Processing could not be queued. Try again.",
        );
      }
    });
  };
}

export const POST = createProcessListingHandler({
  sessionContext: authSessionContext,
  getDatabase,
  publisher: listingPublisher,
});
