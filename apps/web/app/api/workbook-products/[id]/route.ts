import { z } from "zod";
import type { Database } from "@wukong/db";
import { getDatabase } from "../../../../lib/intake-runtime";
import { authSessionContext } from "../../../../lib/session-context";
import type { SessionContextPort } from "../../../../lib/session-context-port";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../lib/route-support";
export function createWorkbookProductHandler(deps: {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
}) {
  return async (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => {
    const response = await withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      if (request.method !== "GET")
        throw new ApiError(405, "method_not_allowed", "GET is required.");
      const id = z.uuid().parse((await context.params).id);
      const product = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, (r) =>
          r.workbookCatalog.getProduct(id),
        );
      if (!product)
        throw new ApiError(404, "not_found", "Workbook product not found.");
      return jsonResponse(200, product);
    });
    response.headers.set("cache-control", "no-store");
    return response;
  };
}
export const GET = createWorkbookProductHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
