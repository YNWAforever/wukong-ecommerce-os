import { z } from "zod";
import type { Database } from "@wukong/db";
import { getDatabase } from "../../../../../lib/intake-runtime";
import {
  buildExportReconciliation,
  resultCapabilities,
} from "../../../../../lib/export-reconciliation";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../lib/route-support";
import { authSessionContext } from "../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../lib/session-context-port";
export function createExportDetailHandler(deps: {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
}) {
  return async (
    _request: Request,
    context: { params: Promise<{ id: string }> },
  ) =>
    withRouteErrors(async () => {
      const session = await requireSessionContext(deps.sessionContext);
      const { id } = await context.params;
      if (!z.uuid().safeParse(id).success)
        throw new ApiError(
          404,
          "export_attempt_not_found",
          "Export attempt not found.",
        );
      const detail = await deps
        .getDatabase()
        .forWorkspace(session.workspaceId, async (repositories) => {
          const attempt = await repositories.exportAttempts.getById(id);
          if (!attempt)
            throw new ApiError(
              404,
              "export_attempt_not_found",
              "Export attempt not found.",
            );
          const results =
            await repositories.importResults.listForExportAttempts([id]);
          return {
            attempt,
            reconciliation: buildExportReconciliation(attempt, results),
          };
        });
      return jsonResponse(200, {
        ...detail,
        capabilities: resultCapabilities(session.role),
      });
    });
}
export const GET = createExportDetailHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
