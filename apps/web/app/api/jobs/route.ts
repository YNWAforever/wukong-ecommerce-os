import { z } from "zod";
import {
  buildExportReconciliation,
  resultCapabilities,
} from "../../../lib/export-reconciliation";
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

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(21474836).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  kind: z
    .enum(["batch", "publish_job", "pipeline_run", "export", "import_result"])
    .optional(),
});

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
  return async function jobs(request?: Request): Promise<Response> {
    return withRouteErrors(async () => {
      const context = await requireSessionContext(deps.sessionContext);
      const query = querySchema.parse(
        Object.fromEntries(
          new URL(request?.url ?? "http://local/api/jobs").searchParams,
        ),
      );
      const since = new Date(Date.now() - METRICS_WINDOW_MS);
      const { entries, metrics, exportReconciliations, page } = await deps
        .getDatabase()
        .forWorkspace(context.workspaceId, async (repositories) => {
          const page = await repositories.reads.jobsPage(query);
          const ids = (kind: string) =>
            page.items
              .filter((item) => item.kind === kind)
              .map((item) => item.id);
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
            repositories.enrichmentBatches.getByIds(ids("batch")),
            repositories.publishJobs.getByIds(ids("publish_job")),
            repositories.pipelineRuns.getByIds(ids("pipeline_run")),
            repositories.exportAttempts.getByIds(ids("export")),
            repositories.importResults.getByIds(ids("import_result")),
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

          const readyExports = exports.filter(
            (attempt) => attempt.artifactStatus === "ready",
          );
          const attemptResults =
            await repositories.importResults.listForExportAttempts(
              readyExports.map((attempt) => attempt.id),
            );
          let versionConflicts = 0;
          let staleSourceRejections = 0;
          for (const row of reviewConflictsByReason) {
            if (row.value && VERSION_CONFLICT_REASONS.has(row.value)) {
              versionConflicts += row.count;
            } else {
              staleSourceRejections += row.count;
            }
          }

          const ledgerOrder = new Map(
            page.items.map((item, index) => [item.kind + ":" + item.id, index]),
          );
          return {
            page,
            exportReconciliations: readyExports.map((attempt) => ({
              attempt,
              reconciliation: buildExportReconciliation(
                attempt,
                attemptResults,
              ),
            })),
            entries: buildJobsLedger(
              { batches, publishJobs, pipelineRuns, exports, importResults },
              query.pageSize,
            ).sort(
              (a, b) =>
                ledgerOrder.get(a.kind + ":" + a.id)! -
                ledgerOrder.get(b.kind + ":" + b.id)!,
            ),
            metrics: {
              publishRetries,
              versionConflicts,
              staleSourceRejections,
              importedRows: importSums.parsedRows,
            },
          };
        });

      return jsonResponse(200, {
        entries,
        page: query.page,
        pageSize: query.pageSize,
        totalMatching: page.totalMatching,
        total: page.total,
        counts: page.counts,
        scope: "workspace_all_history",
        metricsScope: { windowDays: 30, since: since.toISOString() },
        metrics,
        exportReconciliations,
        capabilities: resultCapabilities(context.role),
      });
    });
  };
}

export const GET = createJobsHandler({
  sessionContext: authSessionContext,
  getDatabase,
});
