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

// Fetched generously from each of the 5 sources -- the merge-then-truncate
// happens inside buildJobsLedger, not per source. Fetching fewer than the
// display limit from any one source could wrongly under-represent a source
// that happens to have more recent activity than the others.
const SOURCE_FETCH_LIMIT = 100;

// The page's fixed display limit -- matches the design's stated default.
// This is a literal, never a value derived from request input: buildJobsLedger
// throws outside [1, 100], and a route with no query params can't produce a
// value outside that range by construction.
const LEDGER_DISPLAY_LIMIT = 50;

// 30 days: long enough to be a meaningful trend line on a page checked
// periodically, short enough that the aggregate queries stay cheap without
// their own dedicated index -- these queries scan
// audit_events_workspace_created_idx and filter by action/metadata after.
const METRICS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// review_conflict's `reason` values come from two different sources -- the
// approve route's own literals ("version_conflict", "confirmation_ledger_stale")
// and assertApprovalFreshness/assertExportFreshness's FreshnessFailureReason
// union ("not_attested" | "no_remote_link" | "source_import_mismatch" |
// "row_digest_mismatch" | "version_mismatch" | "header_contract_stale") --
// bucketed here into the 2 metrics the design names, rather than an 8-way
// breakdown no tile could usefully show.
const VERSION_CONFLICT_REASONS = new Set([
  "version_conflict",
  "confirmation_ledger_stale",
]);

type JobsRouteDeps = {
  sessionContext: SessionContextPort;
  getDatabase(): Database;
};

export function createJobsHandler(deps: JobsRouteDeps) {
  return async function jobs(): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const since = new Date(Date.now() - METRICS_WINDOW_MS);
      const { entries, metrics } = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const [
            batches,
            publishJobs,
            pipelineRuns,
            exports,
            importResults,
            publishRetries,
            reviewConflictsByReason,
            importSums,
          ] = await Promise.all([
            repositories.enrichmentBatches.listForWorkspace(SOURCE_FETCH_LIMIT),
            repositories.publishJobs.listForWorkspace(SOURCE_FETCH_LIMIT),
            repositories.pipelineRuns.listForWorkspace(SOURCE_FETCH_LIMIT),
            repositories.exportAttempts.listForWorkspace(SOURCE_FETCH_LIMIT),
            repositories.importResults.listForWorkspace(SOURCE_FETCH_LIMIT),
            repositories.audit.countByActionSince(
              "listing.publish_failed",
              since,
            ),
            repositories.audit.countByActionAndMetadataKeySince(
              "listing.review_conflict",
              "reason",
              since,
            ),
            repositories.audit.sumImportMetricsSince(since),
          ]);

          let versionConflicts = 0;
          let staleSourceRejections = 0;
          for (const row of reviewConflictsByReason) {
            if (row.value && VERSION_CONFLICT_REASONS.has(row.value)) {
              versionConflicts += row.count;
            } else {
              staleSourceRejections += row.count;
            }
          }

          return {
            entries: buildJobsLedger(
              { batches, publishJobs, pipelineRuns, exports, importResults },
              LEDGER_DISPLAY_LIMIT,
            ),
            metrics: {
              publishRetries,
              versionConflicts,
              staleSourceRejections,
              importedRows: importSums.parsedRows,
            },
          };
        });

      return jsonResponse(200, { entries, metrics });
    });
  };
}

export const GET = createJobsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
