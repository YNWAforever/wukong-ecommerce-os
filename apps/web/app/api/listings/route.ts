import { z } from "zod";

import { getAssetStore, getDatabase } from "../../../lib/intake-runtime";
import type { IntakeRouteDeps } from "../../../lib/intake-route-deps";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import { authSessionContext } from "../../../lib/session-context";

const listingSchema = z
  .object({
    sourceAssetIds: z
      .array(z.string().uuid())
      .min(1)
      .max(11)
      .refine((ids) => new Set(ids).size === ids.length, "Asset IDs must be unique"),
    note: z.string().max(5_000).optional().default(""),
  })
  .strict();

export function createListingHandler(deps: IntakeRouteDeps) {
  return async function createListing(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const body = listingSchema.parse(await request.json());

      const listing = await deps.getDatabase().forWorkspace(
        context.workspaceId,
        async (repositories) => {
          const assets = await repositories.sourceAssets.getByIds(body.sourceAssetIds);
          const foundIds = new Set(assets.map(({ id }) => id));
          if (
            assets.length !== body.sourceAssetIds.length ||
            body.sourceAssetIds.some((id) => !foundIds.has(id))
          ) {
            throw new ApiError(
              404,
              "source_assets_not_found",
              "One or more source assets were not found.",
            );
          }
          if (assets.some(({ listingId }) => listingId !== null)) {
            throw new ApiError(
              409,
              "source_asset_already_used",
              "One or more source assets are already associated.",
            );
          }

          const imageKinds = new Set(["image/jpeg", "image/png", "image/webp"]);
          const imageCount = assets.filter(({ kind }) => imageKinds.has(kind)).length;
          const pdfCount = assets.filter(({ kind }) => kind === "application/pdf").length;
          if (
            imageCount > 10 ||
            pdfCount > 1 ||
            imageCount + pdfCount !== assets.length
          ) {
            throw new ApiError(
              400,
              "invalid_asset_composition",
              "Listings support up to 10 images and 1 PDF.",
            );
          }

          const created = await repositories.listings.create({
            target: "shopline",
            note: body.note.trim() || null,
          });
          await repositories.sourceAssets.attachToListing(
            created.id,
            body.sourceAssetIds,
          );
          await repositories.audit.write({
            workspaceId: context.workspaceId,
            actorId: context.actorId,
            entityId: created.id,
            action: "listing.created",
            metadata: {
              assetCount: body.sourceAssetIds.length,
              hasNote: body.note.trim().length > 0,
            },
          });
          return created;
        },
      );

      return jsonResponse(201, {
        listing: {
          id: listing.id,
          status: listing.status,
          target: listing.target,
        },
      });
    });
  };
}

export const POST = createListingHandler({
  sessionContext: authSessionContext,
  getAssetStore,
  getDatabase,
});
