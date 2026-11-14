import { z } from "zod";
import { WEBSITE_INGRESS_PATH } from "@wukong/jobs";
import { createCloudflareIngressClient } from "../../../../../lib/cloudflare-queue-runtime";
import { getDatabase } from "../../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";
import { ApiError } from "../../../../../lib/route-support";
import {
  dispatchWebsiteScan,
  type WebsiteDispatchDeps,
} from "../../../../../lib/website/scan-dispatch";
import {
  publicWebsiteScan,
  readWebsiteBody,
  websiteMethodNotAllowed,
  websiteRoute,
  websiteSession,
} from "../../../../../lib/website/scan-service";
const retrySchema = z
  .object({
    revision: z.number().int().safe().min(0),
    attempts: z.number().int().safe().min(0),
  })
  .strict();
export function createWebsiteScanRetryHandler(
  deps: WebsiteDispatchDeps & { session: SessionContextPort },
) {
  return (request: Request, context: { params: Promise<{ id: string }> }) =>
    websiteRoute(async () => {
      const session = await websiteSession(deps.session);
      if (request.method !== "POST")
        throw new ApiError(405, "method_not_allowed", "POST is required.");
      const id = z.uuid().parse((await context.params).id);
      const input = retrySchema.parse(
        JSON.parse(await readWebsiteBody(request)),
      );
      const scan = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          repositories.websiteCatalog.getScan(id),
        );
      if (!scan) throw new ApiError(404, "scan_not_found", "Scan not found.");
      if (
        scan.revision !== input.revision ||
        scan.dispatchAttempts !== input.attempts
      )
        throw new ApiError(
          409,
          "scan_changed",
          "The scan changed. Refresh its recorded state.",
        );
      const result = await dispatchWebsiteScan(deps, scan, session);
      if (!result.claimed)
        throw new ApiError(
          409,
          "dispatch_not_retryable",
          "Delivery cannot be retried now. Refresh the scan state.",
        );
      return Response.json(publicWebsiteScan(result.scan, deps.now?.()), {
        status: 202,
      });
    });
}
export const POST = createWebsiteScanRetryHandler({
  session: authSessionContext,
  getDatabase,
  enqueue: (job) =>
    createCloudflareIngressClient().enqueue(WEBSITE_INGRESS_PATH, job),
});
export const GET = () => websiteMethodNotAllowed("POST");
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
