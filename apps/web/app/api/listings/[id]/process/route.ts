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
          if (listing.status !== "received") {
            throw new ApiError(
              409,
              "listing_not_retryable",
              "Only a received listing can start processing.",
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
          if (await repositories.pipelineRuns.getState(key)) {
            throw new ApiError(
              409,
              "processing_already_started",
              "Processing has already started.",
            );
          }

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
