import type { Database } from "@wukong/db";

import { getDatabase } from "../../../lib/intake-runtime";
import { buildJobsLedger } from "../../../lib/jobs-ledger";
import {
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../lib/route-support";
import { authSessionContext } from "../../../lib/session-context";
import type { SessionContextPort } from "../../../lib/session-context-port";

// Fetched generously from each of the 4 sources -- the merge-then-truncate
// happens inside buildJobsLedger, not per source. Fetching fewer than the
// display limit from any one source could wrongly under-represent a source
// that happens to have more recent activity than the others.
const SOURCE_FETCH_LIMIT = 100;

// The page's fixed display limit -- matches the design's stated default.
// This is a literal, never a value derived from request input: buildJobsLedger
// throws outside [1, 100], and a route with no query params can't produce a
// value outside that range by construction.
const LEDGER_DISPLAY_LIMIT = 50;

type JobsRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
};

export function createJobsHandler(deps: JobsRouteDeps) {
  return async function jobs(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const entries = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const [batches, publishJobs, pipelineRuns, exports] =
            await Promise.all([
              repositories.enrichmentBatches.listForWorkspace(
                SOURCE_FETCH_LIMIT,
              ),
              repositories.publishJobs.listForWorkspace(SOURCE_FETCH_LIMIT),
              repositories.pipelineRuns.listForWorkspace(SOURCE_FETCH_LIMIT),
              repositories.exportAttempts.listForWorkspace(SOURCE_FETCH_LIMIT),
            ]);

          return buildJobsLedger(
            { batches, publishJobs, pipelineRuns, exports },
            LEDGER_DISPLAY_LIMIT,
          );
        });

      return jsonResponse(200, { entries });
    });
  };
}

export const GET = createJobsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
