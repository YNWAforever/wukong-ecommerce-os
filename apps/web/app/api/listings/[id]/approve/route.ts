import {
  approveListing as domainApprove,
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
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";

type RouteContext = { params: Promise<{ id: string }> };
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
      // 1's -- `promoteAndApprove`'s optimistic-concurrency check is what
      // guards against the listing changing during phase 2's external I/O.
      const result = await db.forWorkspace(
        session.workspaceId,
        (repositories) =>
          approveOne(id, auditContext, repositories, {
            approve: deps.approve,
            precomputedFinalAsset,
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
