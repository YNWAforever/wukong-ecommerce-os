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
};

export function createQualityHandler(deps: QualityRouteDeps) {
  return async function quality(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const summary = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const listings = await repositories.listings.listRecent();
          const totalCostUsd = await repositories.aiRuns.sumCostForListings(
            listings.map((listing) => listing.id),
          );
          return computeQualitySummary(listings, totalCostUsd);
        });

      return jsonResponse(200, summary);
    });
  };
}

export const GET = createQualityHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
