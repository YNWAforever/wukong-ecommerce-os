import {
  computeReviewMetrics,
  reviewMetricWindow,
} from "../../../lib/review-quality-metrics";
import type { Database } from "@wukong/db";

import { getDatabase } from "../../../lib/intake-runtime";
import { computeQualitySummary } from "../../../lib/quality-summary";
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
      const now = deps.now?.() ?? new Date();
      const window = reviewMetricWindow(now);
      const summary = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const scanStartedAt = new Date().toISOString();
          const summary = computeQualitySummary([], 0);
          let totalListings = 0,
            noActiveVersion = 0,
            unassessableActiveVersion = 0;
          let afterId: string | undefined;
          for (;;) {
            const ids = await repositories.reads.scanListingIds(afterId, 100);
            if (ids.length === 0) break;
            const listings = await repositories.listings.getByIds(ids);
            const cost = await repositories.aiRuns.sumCostForListings(ids);
            const chunk = computeQualitySummary(listings, cost);
            totalListings += listings.length;
            noActiveVersion += listings.filter(
              (item) => !(item.activeVersionId ?? item.activeVersion?.id),
            ).length;
            unassessableActiveVersion += listings.filter(
              (item) => item.activeVersionId && !item.activeVersion,
            ).length;
            summary.totalAssessed += chunk.totalAssessed;
            summary.cleanCount += chunk.cleanCount;
            summary.hasGapsCount += chunk.hasGapsCount;
            summary.totalCostUsd += chunk.totalCostUsd;
            for (const key of Object.keys(
              summary.gapCounts,
            ) as (keyof typeof summary.gapCounts)[])
              summary.gapCounts[key] += chunk.gapCounts[key];
            if (ids.length < 100) break;
            afterId = ids.at(-1);
          }
          return {
            ...summary,
            reviewMetrics: computeReviewMetrics(
              await repositories.reads.reviewQualityEvidence(
                window.start,
                window.end,
              ),
              now,
            ),
            totalListings,
            noActiveVersion,
            unassessableActiveVersion,
            scope: "workspace_active_versions",
            consistency: "bounded_scan",
            scanStartedAt,
            scanCompletedAt: new Date().toISOString(),
            costScope: "all_history_for_workspace_listings",
          };
        });

      return jsonResponse(200, summary);
    });
  };
}

export const GET = createQualityHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
