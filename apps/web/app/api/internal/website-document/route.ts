import {
  WEBSITE_DOCUMENT_PATH,
  websiteDocumentRequestSchema,
  verifyQueueRequest,
} from "@wukong/jobs";
import { getDatabase } from "../../../../lib/intake-runtime";
import { ApiError } from "../../../../lib/route-support";
import {
  createWebsiteDocumentService,
  readWebsiteBody,
  websiteRoute,
} from "../../../../lib/website/scan-service";
import type { PublicFetch } from "../../../../lib/website/public-fetch";
import type { WebsiteDatabase } from "../../../../lib/website/scan-service";
export const runtime = "nodejs";
export function createWebsiteDocumentHandler(deps: {
  secret: () => string | undefined;
  now?: () => Date;
  service?: ReturnType<typeof createWebsiteDocumentService>;
  getDatabase?: () => WebsiteDatabase;
  publicFetch?: PublicFetch;
}) {
  return (request: Request) =>
    websiteRoute(async () => {
      if (new URL(request.url).pathname !== WEBSITE_DOCUMENT_PATH)
        throw new ApiError(404, "not_found", "Route not found.");
      if (request.method !== "POST")
        throw new ApiError(405, "method_not_allowed", "POST is required.");
      const body = await readWebsiteBody(request);
      const secret = deps.secret()?.trim();
      if (
        !secret ||
        !(await verifyQueueRequest({
          secret,
          nowSeconds: Math.floor((deps.now?.() ?? new Date()).getTime() / 1000),
          timestamp: request.headers.get("x-wukong-timestamp") ?? "",
          signature: request.headers.get("x-wukong-signature") ?? "",
          path: WEBSITE_DOCUMENT_PATH,
          body,
        }))
      )
        throw new ApiError(
          401,
          "unauthorized",
          "Invalid internal authorization.",
        );
      const input = websiteDocumentRequestSchema.parse(JSON.parse(body));
      const service =
        deps.service ??
        createWebsiteDocumentService({
          database: (deps.getDatabase ?? getDatabase)(),
          publicFetch: deps.publicFetch,
          now: deps.now,
        });
      const outcome = await service(input);
      if (outcome.status === "stale")
        return Response.json({ status: "stale" }, { status: 409 });
      if (outcome.status === "in_progress")
        return Response.json({ status: "in_progress" }, { status: 202 });
      if (outcome.status !== "completed")
        throw new ApiError(409, "stale", "Step is unavailable.");
      return Response.json({
        status: "completed",
        observation: {
          state: outcome.result.state,
          ...outcome.result.checkpoint.preview,
        },
      });
    });
}
export const POST = createWebsiteDocumentHandler({
  secret: () => process.env.QUEUE_INGRESS_SECRET,
});
