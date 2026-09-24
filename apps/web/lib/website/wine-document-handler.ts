import {
  WINE_DOCUMENT_PATH,
  wineDocumentRequestSchema,
  verifyQueueRequest,
} from "@wukong/jobs";
import { ApiError } from "../route-support";
import { readWebsiteBody, websiteRoute } from "./scan-service";
import type { createWineDocumentService } from "./wine-document-service";
/** Node route adapter; production POST is wired only once the durable store exists. */
export function createWineDocumentHandler(deps: {
  secret: () => string | undefined;
  now?: () => Date;
  service: ReturnType<typeof createWineDocumentService>;
}) {
  return (request: Request) =>
    websiteRoute(async () => {
      if (new URL(request.url).pathname !== WINE_DOCUMENT_PATH)
        throw new ApiError(404, "not_found", "Route not found.");
      if (request.method !== "POST")
        throw new ApiError(405, "method_not_allowed", "POST is required.");
      const body = await readWebsiteBody(request),
        secret = deps.secret()?.trim();
      if (
        !secret ||
        !(await verifyQueueRequest({
          secret,
          nowSeconds: Math.floor((deps.now?.() ?? new Date()).getTime() / 1000),
          timestamp: request.headers.get("x-wukong-timestamp") ?? "",
          signature: request.headers.get("x-wukong-signature") ?? "",
          path: WINE_DOCUMENT_PATH,
          body,
        }))
      )
        throw new ApiError(
          401,
          "unauthorized",
          "Invalid internal authorization.",
        );
      const input = wineDocumentRequestSchema.parse(JSON.parse(body));
      const outcome = await deps.service(input);
      return Response.json(outcome, {
        status: outcome.status === "completed" ? 200 : 409,
      });
    });
}
