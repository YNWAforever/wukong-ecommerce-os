import {
  createWorkbookParser,
  workbookPreview,
  type WorkbookParser,
} from "../../../../lib/workbook-import";
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
import type { SessionContextPort } from "../../../../lib/session-context-port";
export const runtime = "nodejs";
export function createWorkbookPreviewHandler(deps: {
  sessionContext: SessionContextPort;
  parseWorkbook: WorkbookParser;
}) {
  return async (request: Request) => {
    const response = await withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      return jsonResponse(
        200,
        workbookPreview(await deps.parseWorkbook(request)),
      );
    });
    response.headers.set("cache-control", "no-store");
    return response;
  };
}
export const POST = createWorkbookPreviewHandler({
  sessionContext: authSessionContext,
  parseWorkbook: createWorkbookParser(),
});
