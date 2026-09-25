import { readCopyClaimSupports } from "../../../../../lib/listing-claim-support";
import { requireListingRecovery } from "../../../../../lib/listing-recovery-readiness";
import { randomUUID } from "node:crypto";
import { listingInputDigest } from "@wukong/db";
import {
  carryResolutions,
  workingFields,
  readWorkingField,
  localizedCopyFields,
  reviewableListingSchema,
  scanCompliance,
  scanCopyWithClaimSupport,
  type AuditContext,
  type ReviewableListing,
} from "@wukong/core";
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
type ReviewRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
};

/**
 * Saving a draft accepts REVIEWABLE content, not canonical.
 *
 * `canonicalListingSchema` re-tightens the commercial facts to non-null, so an
 * operator who has read the producer, region, vintage, volume and ABV off a
 * label but is still waiting on the merchant's SKU and price could not record
 * any of it -- the whole payload was rejected for the two fields they do not
 * have yet. `reviewableListingSchema` keeps the bilingual copy, SEO, tags and
 * images required, and lets those facts stay null.
 *
 * Nothing is loosened about delivery: `requireForPublish` still parses with
 * `canonicalListingSchema` and throws when the content is not publish-ready, so
 * the completeness requirement moves to the gate where it belongs rather than
 * disappearing.
 */
const reviewBodySchema = z
  .object({
    baseVersionId: z.string().uuid().nullable(),
    expectedInputRevision: z.number().int().nonnegative().optional(),
    listing: reviewableListingSchema.optional(),
    content: reviewableListingSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.listing ?? value.content),
    "listing content is required",
  );

function assertOperator(role: string): void {
  if (!["operator", "reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Operator access is required.",
    );
  }
}

function changedFields(
  before: ReviewableListing,
  after: ReviewableListing,
): string[] {
  return Object.keys(after).filter(
    (key) =>
      JSON.stringify(before[key as keyof ReviewableListing]) !==
      JSON.stringify(after[key as keyof ReviewableListing]),
  );
}

export function createReviewListingHandler(deps: ReviewRouteDeps) {
  return async function reviewListingHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertOperator(session.role);
      const { id } = await context.params;
      if (!z.uuid().safeParse(id).success)
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const body = reviewBodySchema.parse(await request.json());
      const content = body.listing ?? body.content;
      if (!content)
        throw new ApiError(
          400,
          "invalid_request",
          "Listing content is required.",
        );
      await requireListingRecovery(deps.getDatabase());
      const auditContext: AuditContext = {
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        entityId: id,
      };
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          await repositories.listings.lockReviewState?.(id);
          const snapshot = await repositories.listings.getReviewSnapshot(id);
          if (!snapshot)
            throw new ApiError(404, "listing_not_found", "Listing not found.");
          if ((snapshot.activeVersion?.id ?? null) !== body.baseVersionId) {
            throw new ApiError(
              409,
              "stale_version",
              "Listing changed; reload before saving.",
            );
          }
          if (repositories.sourceAssets && content.imageAssetIds.length) {
            const assets = await repositories.sourceAssets.getByIds(
              content.imageAssetIds,
            );
            if (
              content.imageAssetIds.some(
                (assetId) =>
                  !assets.some(
                    (asset: {
                      id: string;
                      listingId: string | null;
                      kind: string;
                    }) =>
                      asset.id === assetId &&
                      asset.listingId === id &&
                      asset.kind.startsWith("image/"),
                  ),
              )
            )
              throw new ApiError(
                404,
                "source_not_found",
                "Selected image not found. Save source changes before submitting review.",
              );
          }
          // Re-scan what the operator actually submitted. Only the GENERATED
          // copy was ever scanned, so a claim typed in afterwards reached
          // approval with nothing flagged -- and a claim edited OUT kept its
          // flag for ever, because nothing re-examined the text.
          if (
            (body.baseVersionId === null ||
              (snapshot.listing?.inputRevision ?? 0) > 0) &&
            body.expectedInputRevision === undefined
          )
            throw new ApiError(
              400,
              "input_revision_required",
              "Reload the inputs before saving.",
            );
          if (
            body.expectedInputRevision !== undefined &&
            body.expectedInputRevision !==
              (snapshot.listing?.inputRevision ?? 0)
          )
            throw new ApiError(
              409,
              "input_revision_conflict",
              "Inputs changed; reload before saving.",
            );
          const before = snapshot.activeVersion
            ? localizedCopyFields(snapshot.activeVersion.content)
            : {};
          const after = localizedCopyFields(content);
          const unchanged = new Set(
            Object.keys(after).filter((key) => after[key] === before[key]),
          );
          const claimSupports = await readCopyClaimSupports(
            repositories,
            id,
            content as unknown as Record<string, unknown>,
          );
          const validClaimSupports = claimSupports.filter(
            (support) => support.valid && support.kind === "external",
          );
          for (const support of claimSupports)
            if (
              !support.valid &&
              !claimSupports.some(
                (other) =>
                  other.valid &&
                  other.field === support.field &&
                  other.text === support.text,
              )
            )
              unchanged.delete(support.field);
          const flags = carryResolutions(
            scanCopyWithClaimSupport(
              after,
              {
                criticScores: content.criticScores,
                awards: content.awards,
              },
              validClaimSupports,
            ),
            snapshot.flags,
            unchanged,
          );
          try {
            let savedInputRevision = snapshot.listing?.inputRevision ?? 0;
            if (repositories.listingInputs) {
              const changes = workingFields
                .filter(
                  (field) =>
                    !snapshot.activeVersion ||
                    JSON.stringify(
                      readWorkingField(snapshot.activeVersion.content, field),
                    ) !== JSON.stringify(readWorkingField(content, field)),
                )
                .map((field) => ({
                  field,
                  value: readWorkingField(content, field),
                }));
              const savedInput = await repositories.listingInputs.save(
                {
                  listingId: id,
                  actorId: session.actorId,
                  expectedInputRevision:
                    body.expectedInputRevision ??
                    snapshot.listing.inputRevision,
                  baseVersionId: body.baseVersionId,
                  operationKey: randomUUID(),
                  requestDigest: listingInputDigest(body),
                  changes,
                  reviewContent: content,
                },
                auditContext,
                repositories.audit,
              );
              savedInputRevision = savedInput.revision;
            }
            const version =
              body.baseVersionId === null
                ? await repositories.listings.promoteManual(
                    id,
                    content,
                    auditContext,
                    repositories.audit,
                    flags,
                  )
                : await repositories.listings.editReview(
                    id,
                    body.baseVersionId,
                    content,
                    changedFields(snapshot.activeVersion!.content, content),
                    auditContext,
                    repositories.audit,
                    flags,
                  );
            if (claimSupports.some((support) => support.valid))
              await repositories.listingEnrichment.bindVersionClaims({
                listingId: id,
                versionId: version.id,
                supportIds: claimSupports
                  .filter((support) => support.valid)
                  .map((support) => support.id),
                inputRevision: savedInputRevision,
                actorId: session.actorId,
              });
            return {
              listingId: id,
              versionId: version.id,
              sequence: version.sequence,
              inputRevision: savedInputRevision,
            };
          } catch (error) {
            const inputCode = (error as { code?: string })?.code;
            if (
              inputCode &&
              [
                "input_revision_conflict",
                "base_version_conflict",
                "listing_busy",
                "source_not_finalized",
              ].includes(inputCode)
            )
              throw new ApiError(
                409,
                inputCode,
                "Inputs changed or are unavailable; reload before saving.",
              );
            if (
              error instanceof Error &&
              /^listing is (received|processing|publishing|failed)$/.test(
                error.message,
              )
            ) {
              throw new ApiError(
                409,
                "listing_busy",
                "Listing is being processed; wait for it to finish before saving.",
              );
            }
            if (
              error instanceof Error &&
              /stale review version|changed while editing/i.test(error.message)
            ) {
              throw new ApiError(
                409,
                "stale_version",
                "Listing changed; reload before saving.",
              );
            }
            throw error;
          }
        });
      return jsonResponse(200, result);
    });
  };
}

export const PUT = createReviewListingHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
export const PATCH = PUT;
