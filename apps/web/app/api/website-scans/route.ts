import type { WebsiteScan } from "@wukong/db";
import { z } from "zod";
import { normalizeWebsiteUrl } from "@wukong/core";
import { WEBSITE_INGRESS_PATH, type WebsiteJob } from "@wukong/jobs";
import { createCloudflareIngressClient } from "../../../lib/cloudflare-queue-runtime";
import { getDatabase } from "../../../lib/intake-runtime";
import { authSessionContext } from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";
import { ApiError } from "../../../lib/route-support";
import { dispatchWebsiteScan } from "../../../lib/website/scan-dispatch";
import {
  publicWebsiteScan,
  readWebsiteBody,
  websiteRoute,
  websiteMethodNotAllowed,
  websiteSession,
  type WebsiteDatabase,
} from "../../../lib/website/scan-service";
const bodySchema = z
  .object({
    url: z
      .string()
      .max(4096)
      .transform((value) => normalizeWebsiteUrl(value))
      .refine((value) => value !== null),
    requestKey: z.string().min(1).max(200),
  })
  .strict();
export function createWebsiteScansHandler(deps: {
  session: SessionContextPort;
  getDatabase: () => WebsiteDatabase;
  enqueue: (job: WebsiteJob) => Promise<unknown>;
  now?: () => Date;
}) {
  return (request: Request) =>
    websiteRoute(async () => {
      const session = await websiteSession(deps.session);
      if (request.method !== "POST")
        throw new ApiError(405, "method_not_allowed", "POST is required.");
      const input = bodySchema.parse(
        JSON.parse(await readWebsiteBody(request)),
      );
      const database = deps.getDatabase();
      let scan: WebsiteScan;
      try {
        scan = await database.forWorkspace(
          session.workspaceId,
          (repositories) =>
            repositories.websiteCatalog.createScan({
              url: input.url!,
              requestKey: input.requestKey,
              requestedBy: session.actorId,
              now: deps.now?.(),
            }),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Website request key conflict"
        )
          throw new ApiError(
            409,
            "request_key_conflict",
            "This request key belongs to another URL.",
          );
        throw error;
      }
      if (scan.state === "queued" || scan.state === "running")
        scan = (await dispatchWebsiteScan(deps, scan, session)).scan;
      return Response.json(publicWebsiteScan(scan, deps.now?.()), {
        status: 202,
      });
    });
}
export const POST = createWebsiteScansHandler({
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
