import { AssetInputError, SUPPORTED_ASSET_MIME_TYPES } from "@wukong/assets";
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

const presignAssetSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    mimeType: z.enum(SUPPORTED_ASSET_MIME_TYPES),
    size: z.number().int().min(1).max(20 * 1024 * 1024),
  })
  .strict();

export function createPresignAssetHandler(deps: IntakeRouteDeps) {
  return async function presignAsset(request: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const body = presignAssetSchema.parse(await request.json());
      try {
        const upload = await deps.getAssetStore().createUpload({
          workspaceId: context.workspaceId,
          ...body,
        });
        return jsonResponse(201, {
          key: upload.key,
          uploadUrl: upload.uploadUrl,
          expiresAt: upload.expiresAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof AssetInputError) {
          throw new ApiError(400, "invalid_asset", "Asset upload request is invalid.");
        }
        throw error;
      }
    });
  };
}

export const POST = createPresignAssetHandler({
  sessionContext: authSessionContext,
  getAssetStore,
  getDatabase,
});
