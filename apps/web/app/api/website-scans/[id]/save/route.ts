import { z } from "zod";
import { getDatabase } from "../../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";
import { ApiError } from "../../../../../lib/route-support";
import {
  readWebsiteBody,
  websiteRoute,
  websiteMethodNotAllowed,
  websiteSession,
  type WebsiteDatabase,
} from "../../../../../lib/website/scan-service";
const bodySchema = z
  .object({
    keys: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(20)
      .refine((keys) => new Set(keys).size === keys.length),
  })
  .strict();
export function createWebsiteScanSaveHandler(deps: {
  session: SessionContextPort;
  getDatabase: () => WebsiteDatabase;
}) {
  return (request: Request, context: { params: Promise<{ id: string }> }) =>
    websiteRoute(async () => {
      const session = await websiteSession(deps.session);
      if (request.method !== "POST")
        throw new ApiError(405, "method_not_allowed", "POST is required.");
      const id = z.uuid().parse((await context.params).id);
      const input = bodySchema.parse(
        JSON.parse(await readWebsiteBody(request, 96 * 1024)),
      );
      const result = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const scan = await repositories.websiteCatalog.getScan(id);
          if (!scan)
            throw new ApiError(404, "scan_not_found", "Scan not found.");
          if (scan.state !== "ready" && scan.state !== "partial")
            throw new ApiError(
              409,
              "scan_not_ready",
              "Wait for the scan to finish before saving.",
            );
          if (
            input.keys.some(
              (key) =>
                !scan.checkpoint.preview.products.some(
                  (product) => product.key === key,
                ),
            )
          )
            throw new ApiError(
              400,
              "invalid_selection",
              "Choose products from this scan preview.",
            );
          return repositories.websiteCatalog.saveSelection({
            scanId: id,
            keys: input.keys,
            actorId: session.actorId,
          });
        });
      return Response.json(result);
    });
}
export const POST = createWebsiteScanSaveHandler({
  session: authSessionContext,
  getDatabase,
});

export const GET = () => websiteMethodNotAllowed("POST");
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
