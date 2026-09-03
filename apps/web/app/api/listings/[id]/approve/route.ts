import {
  approveListing as domainApprove,
  assertApprovalFreshness,
  type AuditContext,
} from "@wukong/core";
import { createAssetKey } from "@wukong/assets";
// Imported from its own subpath, not the package's main barrel, so routes
// that only need AssetStore/createAssetKey (i.e. every route except this
// one) don't transitively pull in sharp's native binding -- that coupling
// broke GET /api/listings in production (see next.config.mjs history).
import { flattenProductShot } from "@wukong/assets/product-shot-flatten";
import { z } from "zod";

import {
  approveOne,
  findProductShotAssets,
  type ApproveOneAssetStore,
} from "../../../../../lib/listing-approval";
import { getAssetStore, getDatabase } from "../../../../../lib/intake-runtime";
import { allConfirmed } from "../../../../../lib/review-confirmation-keys";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
type ApprovalRejection = { status: number; code: string; message: string };
type ApprovalRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase: () => {
    forWorkspace<T>(
      workspaceId: string,
      work: (repositories: any) => Promise<T>,
    ): Promise<T>;
  };
  assetStore?: ApproveOneAssetStore;
  approve?: typeof domainApprove;
};

const bodySchema = z
  .object({
    background: z.enum(["white", "brand"]).optional(),
    expectedVersionId: z.string().min(1),
    confirmationLedgerRevision: z.number().int().nonnegative(),
    sourceImportId: z.string().min(1).optional(),
    expectedRowDigest: z.string().min(1).optional(),
  })
  .strip();

function assertReviewer(role: string): void {
  if (!["reviewer", "admin", "owner"].includes(role)) {
    throw new ApiError(
      403,
      "insufficient_role",
      "Reviewer access is required.",
    );
  }
}

export function createApproveListingHandler(deps: ApprovalRouteDeps) {
  return async function approveListingHandler(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    return withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      assertReviewer(session.role);
      const { id } = await context.params;
      if (!/^[0-9a-f-]{36}$/i.test(id))
        throw new ApiError(404, "listing_not_found", "Listing not found.");
      const parsedBody = await bodySchema.parseAsync(
        await request.json().catch(() => ({})),
      );
      const auditContext: AuditContext = {
        workspaceId: session.workspaceId,
        actorId: session.actorId,
        entityId: id,
      };
      const db = deps.getDatabase();

      // Phase 0: cheap, read-only checks that must reject before any
      // product-shot I/O (phase 1/2 below) or the approval transaction
      // (phase 3) runs -- the same "cheap checks before expensive work"
      // ordering already established for the role check above. This is a
      // separate `forWorkspace` call from phase 3's rather than threading
      // these reads through `approveOne`'s own transaction, precisely so a
      // failed check here short-circuits before phase 1/2's external I/O
      // (S3 reads, a `sharp` composite, S3 writes) ever starts.
      // Every rejection below -- whether or not it writes an audit event --
      // returns a rejection descriptor instead of throwing directly.
      // `db.forWorkspace` wraps this callback in a real Postgres transaction
      // (see `packages/db/src/client.ts`); throwing from inside it rolls the
      // transaction back, which would silently discard any audit write along
      // with everything else. Returning uniformly means there's no branch
      // left whose control-flow shape depends on whether it happens to write
      // an audit event today -- copying any branch as a template for a new
      // one can't reintroduce that rollback bug. The single corresponding
      // `throw new ApiError(...)` happens once, after this call resolves and
      // the transaction has committed.
      const rejection: ApprovalRejection | null = await db.forWorkspace(
        session.workspaceId,
        async (repositories) => {
          const snapshot = await repositories.listings.getReviewSnapshot(id);
          if (!snapshot?.activeVersion) {
            return {
              status: 404,
              code: "listing_not_found",
              message: "Listing not found.",
            };
          }
          if (snapshot.activeVersion.id !== parsedBody.expectedVersionId) {
            await repositories.audit.write({
              ...auditContext,
              action: "listing.review_conflict",
              metadata: { reason: "version_conflict" },
            });
            return {
              status: 409,
              code: "version_conflict",
              message:
                "This listing has changed since you started reviewing it.",
            };
          }

          const confirmation =
            await repositories.reviewConfirmations.getByVersionId(
              snapshot.activeVersion.id,
            );
          if (
            (confirmation?.revision ?? -1) !==
            parsedBody.confirmationLedgerRevision
          ) {
            await repositories.audit.write({
              ...auditContext,
              action: "listing.review_conflict",
              metadata: { reason: "confirmation_ledger_stale" },
            });
            return {
              status: 409,
              code: "confirmation_ledger_stale",
              message:
                "The confirmation checklist has changed since you loaded it.",
            };
          }
          if (
            !confirmation ||
            !allConfirmed(
              confirmation.fieldConfirmations,
              confirmation.negativeConfirmations,
            )
          ) {
            return {
              status: 422,
              code: "confirmation_incomplete",
              message: "Complete the confirmation checklist before approving.",
            };
          }

          const link = await repositories.platformProducts.getByListingId(id);
          // A "created"-origin listing gets a `platform_products` row too,
          // after its first publish (see `apps/worker/src/publish-product.ts`)
          // -- but with `sourceImportId`/`contentDigest` always null, since it
          // was never imported. The freshness check only makes sense for a row
          // that came from an import; gating on `link !== null` alone would
          // permanently 400 every re-approval of a create-origin listing (the
          // client can never supply fields that don't exist for it).
          if (link !== null && link.origin === "import") {
            if (!parsedBody.sourceImportId || !parsedBody.expectedRowDigest) {
              return {
                status: 400,
                code: "source_freshness_required",
                message:
                  "This listing is linked to an imported product and requires freshness fields.",
              };
            }
            const result = await assertApprovalFreshness(
              {
                workspaceId: session.workspaceId,
                listingId: id,
                expectedSourceImportId: parsedBody.sourceImportId,
                expectedRowDigest: parsedBody.expectedRowDigest,
                expectedVersionId: parsedBody.expectedVersionId,
              },
              {
                async getPlatformProductLink() {
                  return link;
                },
                async getActiveVersionId() {
                  return snapshot.activeVersion?.id ?? null;
                },
              },
            );
            if (!result.ok) {
              await repositories.audit.write({
                ...auditContext,
                action: "listing.review_conflict",
                metadata: { reason: result.reason },
              });
              return {
                status: 409,
                code: result.reason,
                message:
                  "This listing's source data no longer matches what was reviewed.",
              };
            }
          }
          return null;
        },
      );

      if (rejection) {
        throw new ApiError(rejection.status, rejection.code, rejection.message);
      }

      let precomputedFinalAsset:
        { storageKey: string; priorFinalAssetIds: string[] } | undefined;

      if (parsedBody.background && deps.assetStore) {
        // Phase 1: a short, read-only lookup -- find the cutout (and any
        // prior `product_shot_final` asset ids) plus the brand color, if a
        // cutout exists. No external I/O here, so this is safe to run inside
        // a transaction.
        const lookup = await db.forWorkspace(
          session.workspaceId,
          async (repositories) => {
            const { cutout, priorFinalAssetIds } = await findProductShotAssets(
              id,
              repositories,
            );
            if (!cutout)
              return {
                cutout: null as { storageKey: string } | null,
                priorFinalAssetIds,
                brandBackgroundColor: null as string | null,
              };
            const profile = await repositories.workspaces.requireProfile();
            return {
              cutout,
              priorFinalAssetIds,
              brandBackgroundColor: profile.brandBackgroundColor as
                string | null,
            };
          },
        );

        if (lookup.cutout) {
          // Phase 2: pure, non-transactional I/O -- an S3 read, a CPU-bound
          // `sharp` composite, and an S3 write. This must run OUTSIDE any
          // Postgres transaction/connection: the same slow-external-I/O-in-a-
          // transaction failure mode was already found and fixed in the
          // worker pipeline's own flatten step (`apps/worker/src/listing-pipeline.ts`,
          // the `productShotOutcome` block, run before `deps.withWorkspace`).
          // `repositories` is intentionally out of scope for this block.
          const targetColor =
            parsedBody.background === "brand" && lookup.brandBackgroundColor
              ? lookup.brandBackgroundColor
              : "#ffffff";
          const cutoutBytes = await deps.assetStore.readObject(
            session.workspaceId,
            lookup.cutout.storageKey,
          );
          const flattenedBytes = await flattenProductShot(
            cutoutBytes,
            targetColor,
          );
          const storageKey = deps.assetStore.createAssetKey({
            workspaceId: session.workspaceId,
            fileName: "product-shot-final.png",
            mimeType: "image/png",
            size: flattenedBytes.byteLength,
          });
          await deps.assetStore.writeObject(
            session.workspaceId,
            storageKey,
            flattenedBytes,
            "image/png",
          );
          precomputedFinalAsset = {
            storageKey,
            priorFinalAssetIds: lookup.priorFinalAssetIds,
          };
        }
      }

      // Phase 3: the actual approval, in its own transaction. `approveOne`
      // re-reads a fresh `getReviewSnapshot` here rather than reusing phase
      // 0's/1's -- `promoteAndApprove`'s optimistic-concurrency check is what
      // guards against the listing changing during phase 2's external I/O.
      // Passing `expectedVersionId`/`confirmationLedgerRevision`/
      // `sourceImportId`+`expectedRowDigest` through makes `approveOne`
      // re-read and re-verify each of them itself, inside this transaction --
      // phase 0 above is only a fast fail-fast pre-check (so a doomed request
      // rejects before phase 1/2's product-shot I/O runs), not the actual
      // source of truth. Without this, a concurrent edit landing between
      // phase 0 and here -- a new version promoted via `PUT
      // /api/listings/[id]/review`, a checklist edit via `PATCH
      // .../review-confirmations` bumping the ledger revision on the SAME
      // version, or a catalog re-import updating `platform_products` on the
      // SAME version -- would each silently approve against stale state
      // instead of rejecting, since none of those edits changes the active
      // version id on its own.
      const result = await db.forWorkspace(
        session.workspaceId,
        (repositories) =>
          approveOne(id, auditContext, repositories, {
            approve: deps.approve,
            precomputedFinalAsset,
            expectedVersionId: parsedBody.expectedVersionId,
            confirmationLedgerRevision: parsedBody.confirmationLedgerRevision,
            sourceImportId: parsedBody.sourceImportId,
            expectedRowDigest: parsedBody.expectedRowDigest,
          }),
      );
      return jsonResponse(200, result);
    });
  };
}

export const POST = createApproveListingHandler({
  sessionContext: authSessionContext,
  getDatabase,
  assetStore: {
    readObject: (workspaceId, key) =>
      getAssetStore().readObject(workspaceId, key),
    writeObject: (workspaceId, key, body, mimeType) =>
      getAssetStore().writeObject(workspaceId, key, body, mimeType),
    createAssetKey,
  },
});
