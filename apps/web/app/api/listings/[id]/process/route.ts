import {
  requestProductShotFromProcess,
  type ProductShotRequestInput,
  type ProductShotRequestResult,
} from "../../../../../lib/product-shot-request";
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
  requestProductShot?: (
    input: ProductShotRequestInput,
  ) => Promise<ProductShotRequestResult>;
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
          // Runs for this revision are numbered from 0, so N recorded runs
          // means the newest is N-1. Only that newest one decides what may
          // happen next; the earlier ones are settled history.
          const recordedRuns = await repositories.pipelineRuns.countRuns({
            listingId: id,
            activeVersionSequence: revision.activeVersionSequence,
          });
          const latestAttempt = recordedRuns === 0 ? 0 : recordedRuns - 1;
          // Attempt 0 must not carry the field at all: a Worker deployed before
          // `runAttempt` existed parses strictly and would ack the message away.
          const latestInput = {
            ...input,
            ...(latestAttempt > 0 ? { runAttempt: latestAttempt } : {}),
          } satisfies ListingJob;
          const latestKey = listingApplicationJobId(latestInput);
          const runState = await repositories.pipelineRuns.getState(latestKey);

          // Nothing recorded yet: either this listing has never been processed,
          // or a message is already queued and no delivery has claimed it. Both
          // want the same key -- re-enqueueing it is a no-op the pipeline
          // deduplicates, rather than a second billed run.
          if (!runState) return latestInput;

          if (runState.status === "started") {
            throw new ApiError(
              409,
              "processing_already_started",
              "Processing has already started.",
            );
          }

          if (runState.status === "failed") {
            await repositories.pipelineRuns.reopenFailed(latestKey);
            return latestInput;
          }

          // A run that asked for more information is finished, but the LISTING
          // is not: the operator still has work to do, and doing it has to be
          // able to produce a new result. That run appended no version, so its
          // activeVersionSequence never moved and its key keeps resolving to
          // it -- which is why supplying the missing details used to change
          // nothing at all. Number the next run instead of reusing the key.
          if (runState.resultStatus === "needs_info") {
            return { ...input, runAttempt: latestAttempt + 1 } satisfies ListingJob;
          }

          throw new ApiError(
            409,
            "processing_already_started",
            "Processing has already started.",
          );
        });

      // Deliberately uncaught. withRouteErrors already answers a queue failure
      // with 503 queue_unavailable and logs which failure it was. Catching it
      // here to rethrow a generic ApiError discarded that reason, and labelled
      // any unrelated fault a queue problem as well.
      const [textResult, shotResult] = await Promise.allSettled([
        deps.publisher.enqueue(input),
        deps.requestProductShot?.({
          workspaceId: session.workspaceId,
          listingId: id,
          actorId: session.actorId,
        }) ?? Promise.resolve(undefined),
      ]);
      if (textResult.status === "rejected") throw textResult.reason;
      const job = textResult.value;
      const productShot =
        shotResult.status === "fulfilled"
          ? shotResult.value
          : { state: "request_failed" };
      return jsonResponse(202, {
        processing: { state: "queued", jobId: job.id },
        ...(productShot ? { productShot } : {}),
      });
    });
  };
}

export const POST = createProcessListingHandler({
  sessionContext: authSessionContext,
  getDatabase,
  publisher: listingPublisher,
  requestProductShot: requestProductShotFromProcess,
});
