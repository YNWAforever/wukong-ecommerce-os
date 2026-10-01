import {
  computeReviewMetrics,
  reviewMetricWindow,
} from "../../../lib/review-quality-metrics";
import type { Database } from "@wukong/db";
import { getDatabase } from "../../../lib/intake-runtime";
import { computeCurrentContentGaps } from "../../../lib/current-content-gaps";
import {
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import { authSessionContext } from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";
type QualityRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
  now?(): Date;
};
export function createQualityHandler(deps: QualityRouteDeps) {
  return async function quality(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const now = deps.now?.() ?? new Date(),
        window = reviewMetricWindow(now);
      const summary = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const projection = await repositories.qualityProjection.reconcile(
            computeCurrentContentGaps,
            { limit: 25 },
          );
          const cost = await repositories.aiRuns.summarizeOwnedCostMetadata();
          await repositories.qualityProjection.recordCostSnapshot({
            knownCostUsd: cost.knownCostUsd,
            unknownCostRunCount: cost.unknownCostRunCount,
            asOf: cost.unknownCostReferences.asOf,
          });
          return {
            ...projection,
            totalCostUsd: cost.knownCostUsd,
            unknownCostRunCount: cost.unknownCostRunCount,
            unknownCostReferences: cost.unknownCostReferences,
            reviewMetrics: computeReviewMetrics(
              await repositories.reads.reviewQualityEvidence(
                window.start,
                window.end,
              ),
              now,
            ),
            scope: "workspace_current_content",
            consistency: "revision_aware_projection",
            costScope: "all_history_for_workspace_listings",
          };
        });
      const response = jsonResponse(200, summary);
      response.headers.set("Cache-Control", "no-store");
      return response;
    });
  };
}
export const GET = createQualityHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
