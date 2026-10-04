import { z } from "zod";
import type { RepairSourceObservation } from "../../../../../lib/bulk-export-contract";
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
          const reconciliation = buildExportReconciliation(attempt, results);
          const repairSourceObservations: RepairSourceObservation[] = [];
          if (
            attempt.artifactStatus === "ready" &&
            resultCapabilities(session.role).canGenerateBulkUpdate
          ) {
            const evidence = attempt.provenance?.evidence;
            const rejected = reconciliation.members.filter(
              (member) => member.latestResult?.outcome === "rejected",
            );
            if (Array.isArray(evidence) && rejected.length <= 100)
              for (const member of rejected) {
                const previous = evidence.find(
                  (binding) => binding.listingId === member.listingId,
                );
                const current =
                  await repositories.platformProducts.getByListingId(
                    member.listingId,
                  );
                if (
                  current?.origin === "import" &&
                  current.sourceImportId &&
                  current.contentDigest &&
                  previous?.connectionId === current.connectionId &&
                  previous.remoteProductId === current.remoteProductId
                )
                  repairSourceObservations.push({
                    listingId: member.listingId,
                    contentDigest: current.contentDigest,
                    sourceImportId: current.sourceImportId,
                    remoteProductId: current.remoteProductId,
                  });
              }
          }
          return {
            attempt,
            reconciliation,
            ...(resultCapabilities(session.role).canGenerateBulkUpdate
              ? { repairSourceObservations }
              : {}),
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
