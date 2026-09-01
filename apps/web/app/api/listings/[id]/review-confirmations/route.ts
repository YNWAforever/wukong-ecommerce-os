import { z } from "zod";

import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ReviewConfirmationsRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
};

const bodySchema = z
  .object({
    versionId: z.string().uuid(),
    fieldConfirmations: z.record(z.string(), z.boolean()),
    negativeConfirmations: z.record(z.string(), z.boolean()),
  })
  .strict();

function assertOperator(role: string): void {
  if (!["operator", "reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Operator access is required.",
    );
  }
}

export function createReviewConfirmationsHandler(
  deps: ReviewConfirmationsRouteDeps,
) {
  return async function reviewConfirmationsHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertOperator(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      }
      const body = bodySchema.parse(await request.json());

      const confirmation = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const snapshot = await repositories.listings.getReviewSnapshot(id);
          if (!snapshot) {
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          }
          if (
            !snapshot.activeVersion ||
            snapshot.activeVersion.id !== body.versionId
          ) {
            throw new ApiError(
              409,
              "stale_version",
              "Listing changed; reload before confirming review fields.",
            );
          }

          // create-origin listings have no platform_products link, so the
          // digest and import id the ledger records for them are both null.
          const platformProduct =
            await repositories.platformProducts.getByListingId(id);

          const result = await repositories.reviewConfirmations.upsert({
            listingId: id,
            versionId: body.versionId,
            fieldConfirmations: body.fieldConfirmations,
            negativeConfirmations: body.negativeConfirmations,
            sourceImportId: platformProduct?.sourceImportId ?? null,
            rowDigest: platformProduct?.contentDigest ?? null,
          });

          // Metadata is identifiers only, matching this codebase's audit
          // convention -- never the confirmed field/condition content itself.
          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: id,
            action: "review_confirmation.updated",
            metadata: {
              versionId: body.versionId,
              revision: result.revision,
            },
          });

          return result;
        });

      return jsonResponse(200, {
        revision: confirmation.revision,
        fieldConfirmations: confirmation.fieldConfirmations,
        negativeConfirmations: confirmation.negativeConfirmations,
      });
    });
  };
}

export const PATCH = createReviewConfirmationsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
