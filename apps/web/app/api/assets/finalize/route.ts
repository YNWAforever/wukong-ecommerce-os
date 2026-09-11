import {
  assertAssetKey,
  MAX_ASSET_SIZE,
  SUPPORTED_ASSET_MIME_TYPES,
} from "@wukong/assets";
import { z } from "zod";

import { getAssetStore, getDatabase } from "../../../../lib/intake-runtime";
import type { IntakeRouteDeps } from "../../../../lib/intake-route-deps";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../lib/session-context";

const finalizeAssetSchema = z
  .object({
    key: z.string().min(1).max(1024),
    mimeType: z.enum(SUPPORTED_ASSET_MIME_TYPES),
    size: z.number().int().min(1).max(MAX_ASSET_SIZE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export function createFinalizeAssetHandler(deps: IntakeRouteDeps) {
  return async function finalizeAsset(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role)) {
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      }

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

      const object = await deps
        .getAssetStore()
        .head(context.workspaceId, body.key);
      if (!object) {
        throw new ApiError(
          404,
          "asset_not_found",
          "Uploaded asset was not found.",
        );
      }
      if (object.size !== body.size || object.mimeType !== body.mimeType) {
        throw new ApiError(
          409,
          "asset_metadata_mismatch",
          "Uploaded asset metadata does not match the request.",
        );
      }

      const finalized = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const existing = await repositories.sourceAssets.getByStorageKey(
            body.key,
          );
          if (existing) {
            // A replay, not a conflict. The key names one immutable upload, so
            // the same key carrying the same content is the same asset. Once a
            // client can resume a stored key instead of re-uploading, a
            // finalize whose response was lost is the ordinary way to arrive
            // here, and refusing it stranded bytes already safely in storage.
            const recorded = (existing.metadata ?? {}) as {
              clientSha256?: unknown;
            };
            if (recorded.clientSha256 !== body.sha256) {
              throw new ApiError(
                409,
                "asset_already_finalized",
                "Asset is already finalized with different content.",
              );
            }
            return { asset: existing, replayed: true };
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
          return { asset: created, replayed: false };
        });

      // 200 rather than 201 on a replay: nothing was created this time, and the
      // client only needs the id either way.
      return jsonResponse(finalized.replayed ? 200 : 201, {
        assetId: finalized.asset.id,
      });
    });
  };
}

export const POST = createFinalizeAssetHandler({
  sessionContext: authSessionContext,
  getAssetStore,
  getDatabase,
});
