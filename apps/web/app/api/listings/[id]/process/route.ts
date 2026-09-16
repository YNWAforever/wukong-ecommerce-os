import { requireListingRecovery } from "../../../../../lib/listing-recovery-readiness";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { acceptListingOperation } from "../../../../../lib/listing-operation-service";
import { dispatchListingOperation } from "../../../../../lib/dispatch-listing-operation";
import { validateProductShotSource } from "@wukong/assets/product-shot-render";
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

      const raw = await _request.text();
      const body = z
        .object({
          expectedInputRevision: z.number().int().nonnegative().optional(),
          baseVersionId: z.string().uuid().nullable().optional(),
          retryOfRunId: z.string().uuid().optional(),
        })
        .strict()
        .parse(raw ? JSON.parse(raw) : {});
      const operationKey = z
        .string()
        .uuid()
        .parse(_request.headers.get("Idempotency-Key") ?? randomUUID());
      await requireListingRecovery(deps.getDatabase());
      const accepted = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          await repositories.listings.lockReviewState(id);
          const listing = await repositories.listings.getById(id);
          if (!listing)
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          const replay = await repositories.pipelineRuns.findOperationRequest(
            id,
            operationKey,
          );
          if (replay)
            return acceptListingOperation(repositories, {
              ...session,
              listingId: id,
              expectedInputRevision:
                body.expectedInputRevision ?? replay.inputRevision,
              observedInputRevision: body.expectedInputRevision,
              baseVersionId:
                body.baseVersionId === undefined
                  ? replay.baseVersionId
                  : body.baseVersionId,
              operationKey,
              retryOfRunId: body.retryOfRunId,
            });
          // Legacy input is initialized only after the caller's revision check.
          if (
            body.expectedInputRevision !== undefined &&
            body.expectedInputRevision !== listing.inputRevision
          )
            throw new ApiError(
              409,
              "input_revision_conflict",
              "Reload the current inputs.",
            );
          const snapshot = await repositories.listingInputs.initialize(
            { listingId: id, actorId: session.actorId },
            {
              workspaceId: session.workspaceId,
              actorId: session.actorId,
              entityId: id,
            },
            repositories.audit,
          );
          return acceptListingOperation(repositories, {
            workspaceId: session.workspaceId,
            listingId: id,
            expectedInputRevision: snapshot.revision,
            observedInputRevision: body.expectedInputRevision,
            baseVersionId:
              body.baseVersionId === undefined
                ? listing.activeVersionId
                : body.baseVersionId,
            operationKey,
            retryOfRunId: body.retryOfRunId,
            actorId: session.actorId,
          });
        });
      await dispatchListingOperation(
        deps.getDatabase(),
        session.workspaceId,
        accepted,
        deps.publisher,
      );
      return jsonResponse(202, { processing: accepted.processing });
    });
  };
}
export const POST = createProcessListingHandler({
  sessionContext: authSessionContext,
  getDatabase,
  publisher: listingPublisher,
});
