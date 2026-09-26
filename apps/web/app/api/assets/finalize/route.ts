import {
  inspectUploadedSource,
  SourceInspectionError,
} from "@wukong/assets/inspect-source";
import {
  assertUploadAssetKey,
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
        assertUploadAssetKey(context.workspaceId, body.key);
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

      let inspection;
      try {
        inspection = await inspectUploadedSource(
          deps.getAssetStore(),
          context.workspaceId,
          body.key,
          body,
        );
      } catch (error) {
        if (error instanceof SourceInspectionError)
          throw new ApiError(
            error.code === "asset_already_finalized" ? 409 : 422,
            error.code,
            error.message,
          );
        throw error;
      }
      const { verifiedStorageKey, ...inspectionMetadata } = inspection;
      const fileName = body.key.slice(body.key.lastIndexOf("/") + 1);
      const finalized = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const existing =
            (await repositories.sourceAssets.getByStorageKey(
              verifiedStorageKey,
            )) ?? (await repositories.sourceAssets.getByStorageKey(body.key));
          if (existing) {
            // Reuse a finalized asset only when its recorded digest matches.
            // The raw-key lookup also supports rows created before verified
            // server-owned copies were introduced.
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
            storageKey: verifiedStorageKey,
            kind: body.mimeType,
            metadata: {
              size: object.size,
              mimeType: object.mimeType,
              clientSha256: body.sha256,
              fileName,
              ...inspectionMetadata,
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
              ...inspectionMetadata,
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
