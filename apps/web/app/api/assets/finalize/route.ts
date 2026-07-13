import { assertAssetKey, SUPPORTED_ASSET_MIME_TYPES } from "@wukong/assets";
import { z } from "zod";

import { getAssetStore, getDatabase } from "../../../../lib/intake-runtime";
import type { IntakeRouteDeps } from "../../../../lib/intake-route-deps";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import { authSessionContext } from "../../../../lib/session-context";

const finalizeAssetSchema = z
  .object({
    key: z.string().min(1).max(1024),
    mimeType: z.enum(SUPPORTED_ASSET_MIME_TYPES),
    size: z.number().int().min(1).max(20 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function createFinalizeAssetHandler(deps: IntakeRouteDeps) {
  return async function finalizeAsset(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const body = finalizeAssetSchema.parse(await request.json());
      try {
        assertAssetKey(context.workspaceId, body.key);
      } catch {
        throw new ApiError(
          403,
          "asset_forbidden",
          "Asset is not available in this workspace.",
        );
      }

      const object = await deps.getAssetStore().head(context.workspaceId, body.key);
      if (!object) {
        throw new ApiError(404, "asset_not_found", "Uploaded asset was not found.");
      }
      if (object.size !== body.size || object.mimeType !== body.mimeType) {
        throw new ApiError(
          409,
          "asset_metadata_mismatch",
          "Uploaded asset metadata does not match the request.",
        );
      }

      const asset = await deps.getDatabase().forWorkspace(
        context.workspaceId,
        async (repositories) => {
          if (await repositories.sourceAssets.getByStorageKey(body.key)) {
            throw new ApiError(409, "asset_already_finalized", "Asset is already finalized.");
          }
          const created = await repositories.sourceAssets.create({
            storageKey: body.key,
            kind: body.mimeType,
            metadata: {
              size: object.size,
              mimeType: object.mimeType,
              clientSha256: body.sha256,
              hashVerified: false,
            },
          });
          await repositories.audit.write({
            workspaceId: context.workspaceId,
            actorId: context.actorId,
            entityId: created.id,
            action: "asset.finalized",
            metadata: {
              size: object.size,
              mimeType: object.mimeType,
              hashVerified: false,
            },
          });
          return created;
        },
      );

      return jsonResponse(201, { assetId: asset.id });
    });
  };
}

export const POST = createFinalizeAssetHandler({
  sessionContext: authSessionContext,
  getAssetStore,
  getDatabase,
});
