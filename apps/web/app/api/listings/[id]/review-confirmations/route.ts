import { z } from "zod";

import { getDatabase } from "../../../../../lib/intake-runtime";
import { buildReviewFieldRecords } from "../../../../../lib/review-field-records";
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

// Strict, and deliberately without a fieldRecords key: the per-field record is
// derived from rows the caller does not control, so a request carrying one is
// refused rather than trusted.
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

          const invalidation =
            await repositories.listings.invalidateApprovalForConfirmationChange(
              id,
              body.versionId,
              {
                workspaceId: session.workspaceId,
                actorId: session.actorId,
                entityId: id,
              },
              repositories.audit,
            );
          if (invalidation === "stale") {
            throw new ApiError(
              409,
              "stale_version",
              "Listing changed; reload before confirming review fields.",
            );
          }
          if (invalidation === "publishing") {
            throw new ApiError(
              409,
              "listing_publishing",
              "Confirmations cannot change while delivery is in progress.",
            );
          }
          // create-origin listings have no platform_products link, so the
          // digest and import id the ledger records for them are both null,
          // and so is every field record's `before`.
          const platformProduct =
            await repositories.platformProducts.getByListingId(id);

          // What each field is being confirmed against: the confirmed version,
          // its evidence and the imported row -- the same row whose digest is
          // recorded as rowDigest below, so the two bindings cannot disagree.
          const fieldRecords = buildReviewFieldRecords({
            content: snapshot.activeVersion.content,
            evidence: snapshot.evidence,
            rawRow: platformProduct?.rawRow ?? null,
          });

          const result = await repositories.reviewConfirmations.upsert({
            listingId: id,
            versionId: body.versionId,
            fieldConfirmations: body.fieldConfirmations,
            negativeConfirmations: body.negativeConfirmations,
            sourceImportId: platformProduct?.sourceImportId ?? null,
            rowDigest: platformProduct?.contentDigest ?? null,
            fieldRecords,
          });

          const records = Object.values(fieldRecords);
          // Metadata is identifiers and counts only, matching this codebase's
          // audit convention -- never the confirmed content, and not the
          // digests either: those are in the column.
          await repositories.audit.write({
            workspaceId: session.workspaceId,
            actorId: session.actorId,
            entityId: id,
            action: "review_confirmation.updated",
            metadata: {
              versionId: body.versionId,
              revision: result.revision,
              fieldsWithSource: records.filter(
                (record) => record.before !== null,
              ).length,
              fieldsWithoutEvidence: records.filter(
                (record) => record.evidenceDigest === null,
              ).length,
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
