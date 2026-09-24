import { z } from "zod";
import { getDatabase } from "../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";
import { ApiError } from "../../../../lib/route-support";
import {
  publicWebsiteScan,
  websiteRoute,
  websiteMethodNotAllowed,
  websiteSession,
  type WebsiteDatabase,
} from "../../../../lib/website/scan-service";
export function createWebsiteScanHandler(deps: {
  session: SessionContextPort;
  getDatabase: () => WebsiteDatabase;
}) {
  return (request: Request, context: { params: Promise<{ id: string }> }) =>
    websiteRoute(async () => {
      const session = await websiteSession(deps.session);
      if (request.method !== "GET")
        throw new ApiError(405, "method_not_allowed", "GET is required.");
      const id = z.uuid().parse((await context.params).id);
      const scan = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (repositories) =>
          repositories.websiteCatalog.getScan(id),
        );
      if (!scan) throw new ApiError(404, "scan_not_found", "Scan not found.");
      return Response.json(publicWebsiteScan(scan));
    });
}
export const GET = createWebsiteScanHandler({
  session: authSessionContext,
  getDatabase,
});

export const POST = () => websiteMethodNotAllowed("GET");
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const HEAD = POST;
export const OPTIONS = POST;
