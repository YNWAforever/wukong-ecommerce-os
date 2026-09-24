import type { WorkbookSaveInput, WorkbookSaveResult } from "@wukong/db";
import {
  createWorkbookParser,
  createWorkbookSaver,
  type WorkbookParser,
} from "../../../lib/workbook-import";
import { getDatabase } from "../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";
export const runtime = "nodejs";
export const maxDuration = 300;
export type WorkbookSaveRouteDeps = {
  sessionContext: SessionContextPort;
  parseWorkbook: WorkbookParser;
  saveWorkbook(
    input: WorkbookSaveInput & { workspaceId: string },
  ): Promise<WorkbookSaveResult>;
};
export function createWorkbookSaveHandler(deps: WorkbookSaveRouteDeps) {
  return async (request: Request) => {
    const response = await withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      if (!requireWorkspaceRole("operator", context.role))
        throw new ApiError(
          403,
          "insufficient_role",
          "Operator access is required.",
        );
      const parsed = await deps.parseWorkbook(request);
      if (
        request.headers.get("x-workbook-sha256") !== parsed.workbookSha256 ||
        request.headers.get("x-workbook-header-sha256") !==
          parsed.headerContractSha256
      )
        throw new ApiError(
          409,
          "workbook_preview_mismatch",
          "The workbook or column contract changed. Preview the file again.",
        );
      if (!parsed.prepared.products.length)
        throw new ApiError(
          422,
          "workbook_no_eligible_products",
          "No eligible products can be imported. Review the preview issues.",
        );
      return jsonResponse(
        201,
        await deps.saveWorkbook({
          ...parsed,
          workspaceId: context.workspaceId,
          actorId: context.actorId,
        }),
      );
    });
    response.headers.set("cache-control", "no-store");
    return response;
  };
}
export const POST = createWorkbookSaveHandler({
  sessionContext: authSessionContext,
  parseWorkbook: createWorkbookParser(),
  saveWorkbook: createWorkbookSaver({ getDatabase }),
});
