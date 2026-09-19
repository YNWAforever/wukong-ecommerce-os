import { sql } from "drizzle-orm";
import {
  transitionListing,
  type AuditContext,
  type AuditWriter,
  type ListingStatus,
} from "@wukong/core";
import type { WorkspaceTransaction, WorkspaceScope } from "../client.js";
export function createListingOperationRecoveryRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  return {
    async failAbandonedOperation(
      input: { runId: string; olderThanSeconds: number; maxAttempts: number },
      context: AuditContext,
      audit: AuditWriter,
    ): Promise<{ failed: boolean; reason?: string }> {
      scope.assertOpen();
      const age = Math.max(900, input.olderThanSeconds);
      const attempts = Math.max(5, input.maxAttempts);
      if (
        !Number.isSafeInteger(age) ||
        age > 86400 ||
        !Number.isSafeInteger(attempts) ||
        attempts > 100
      )
        throw new Error("invalid recovery bounds");
      const drafts = await tx.execute(
        sql`select d.id,d.status,d.active_version_id,d.current_run_id from listing_drafts d join listing_pipeline_runs r on r.workspace_id=d.workspace_id and r.listing_id=d.id where r.workspace_id=${workspaceId} and r.id=${input.runId}::uuid for update of d`,
      );
      const draft = drafts[0];
      if (!draft) return { failed: false };
      const runs = await tx.execute(
        sql`select * from listing_pipeline_runs where workspace_id=${workspaceId} and id=${input.runId}::uuid for update`,
      );
      const run = runs[0];
      if (
        !run ||
        (run.execution as Record<string, unknown>)?.flowVersion ===
          "wine-enrichment-v1" ||
        !["queued", "running"].includes(String(run.execution_state))
      )
        return { failed: false };
      await tx.execute(
        sql`select id from listing_pipeline_steps where workspace_id=${workspaceId} and pipeline_run_id=${input.runId}::uuid for update`,
      );
      const eligible =
        await tx.execute(sql`select r.id,case when o.attempts>=${attempts} then 'dispatch_exhausted' when o.id is null then 'dispatch_record_missing' else 'operation_abandoned' end reason
   from listing_pipeline_runs r left join listing_dispatch_outbox o on o.workspace_id=r.workspace_id and o.dedupe_key=r.idempotency_key
   where r.workspace_id=${workspaceId} and r.id=${input.runId}::uuid and r.updated_at<now()-make_interval(secs=>${age})
   and not exists(select 1 from listing_pipeline_steps p where p.workspace_id=r.workspace_id and p.pipeline_run_id=r.id and p.state='running' and p.updated_at>=now()-interval '360 seconds')
   and (r.execution_state='running' or o.id is null or o.attempts>=${attempts} or o.dispatched_at<now()-make_interval(secs=>${age}))`);
      if (!eligible[0]) return { failed: false };
      const reason = String(eligible[0].reason);
      await tx.execute(
        sql`update listing_pipeline_runs set execution_state='failed',status='failed',error_code=${reason},updated_at=now() where workspace_id=${workspaceId} and id=${input.runId}::uuid`,
      );
      await tx.execute(
        sql`update listing_pipeline_steps set state='failed',lease_token=gen_random_uuid(),updated_at=now() where workspace_id=${workspaceId} and pipeline_run_id=${input.runId}::uuid and state='running'`,
      );
      const auditContext = {
        ...context,
        workspaceId,
        entityId: String(draft.id),
      };
      if (
        draft.current_run_id === input.runId &&
        draft.active_version_id === null &&
        ["received", "processing", "needs_info", "failed"].includes(
          String(draft.status),
        )
      ) {
        const status = await transitionListing(
          draft.status as ListingStatus,
          "abandon_processing",
          auditContext,
          audit,
        );
        await tx.execute(
          sql`update listing_drafts set status=${status},updated_at=now() where workspace_id=${workspaceId} and id=${String(draft.id)}::uuid`,
        );
      }
      // No physical outcome is invented. Missing or unsettled calls keep the full
      // hold unknown; measured completed invocations may settle their actual sum.
      await tx.execute(sql`with calls as(select count(*)::int call_count,bool_or(status='started' or estimated_cost_usd is null) has_unknown,sum(estimated_cost_usd) settled from ai_runs where workspace_id=${workspaceId} and pipeline_run_id=${input.runId}::uuid)
   update ai_budget_reservations r set state=case when calls.call_count=0 or calls.has_unknown then 'unknown' else 'settled' end,settled_usd=case when calls.call_count=0 or calls.has_unknown then null else calls.settled end,updated_at=now()
   from calls where r.workspace_id=${workspaceId} and r.pipeline_run_id=${input.runId}::uuid and r.state='held'`);
      await audit.write({
        ...auditContext,
        action: "listing.operation_abandoned",
        metadata: { runId: input.runId, errorCode: reason },
      });
      return { failed: true, reason };
    },
  };
}
