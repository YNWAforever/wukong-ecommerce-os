import { sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import {
  batchItemRecovery,
  type BatchRecovery,
} from "./batch-item-recovery.js";

export type BatchItemDetail = {
  id: string;
  listingId: string;
  pipelineRunId: string | null;
  inputRevision: number | null;
  outcome: string | null;
  status: string;
  retryOfItemId: string | null;
  isCurrent: boolean;
  recovery?: BatchRecovery;
  canRetry?: boolean;
  sku?: string | null;
  sourceRef?: string | null;
  lastStage?: string;
  updatedAt?: string;
  thumbnailAssetId?: string | null;
  thumbnailUrl?: string | null;
  thumbnailState?: "ready" | "unavailable";
};
export class BatchControlConflict extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function createBatchControlRepository(
  tx: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
) {
  return {
    async setArchived(batchId: string, archived: boolean) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`update enrichment_batches set archived_at=${archived ? sql`now()` : sql`null`},updated_at=now() where workspace_id=${workspaceId} and id=${batchId}::uuid returning id`,
      );
      if (rows.length !== 1) throw new BatchControlConflict("batch_not_found");
    },
    async beginCommand(input: {
      batchId: string;
      expectedControlRevision: number;
      idempotencyKey: string;
      digest: string;
    }) {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select control_revision,command_receipts from enrichment_batches where workspace_id=${workspaceId} and id=${input.batchId}::uuid for update`,
      );
      if (!rows[0]) throw new BatchControlConflict("batch_not_found");
      const receipts = rows[0].command_receipts as Record<
        string,
        { digest: string; result: Record<string, unknown> }
      >;
      const replay = receipts[input.idempotencyKey];
      if (replay) {
        if (replay.digest !== input.digest)
          throw new BatchControlConflict("idempotency_conflict");
        return {
          replay: replay.result,
          revision: Number(replay.result.controlRevision),
        };
      }
      if (Number(rows[0].control_revision) !== input.expectedControlRevision)
        throw new BatchControlConflict("batch_revision_conflict");
      await tx.execute(
        sql`update enrichment_batches set control_revision=control_revision+1,updated_at=now() where workspace_id=${workspaceId} and id=${input.batchId}::uuid`,
      );
      return { replay: null, revision: input.expectedControlRevision + 1 };
    },
    async finishCommand(input: {
      batchId: string;
      idempotencyKey: string;
      digest: string;
      result: Record<string, unknown>;
    }) {
      scope.assertOpen();
      await tx.execute(
        sql`update enrichment_batches set command_receipts=command_receipts || jsonb_build_object(${input.idempotencyKey}::text,${JSON.stringify({ digest: input.digest, result: input.result })}::jsonb) where workspace_id=${workspaceId} and id=${input.batchId}::uuid`,
      );
    },
    async listItemDetails(batchId: string): Promise<BatchItemDetail[]> {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select i.id,i.listing_id,i.pipeline_run_id,i.input_revision,i.outcome,i.status,i.retry_of_item_id,i.is_current,i.updated_at,r.error_code,
          coalesce(current_input.working_content->>'sku',p.remote_product_id) sku,p.id source_ref,image.id thumbnail_asset_id,
          coalesce((select case when a.stage in ('extract','generate','verify') then a.stage else 'unknown' end from ai_runs a where a.workspace_id=i.workspace_id and a.pipeline_run_id=i.pipeline_run_id order by a.created_at desc limit 1),'unknown') last_stage,
          (exists(select 1 from ai_budget_reservations a where a.workspace_id=i.workspace_id and a.pipeline_run_id=i.pipeline_run_id and a.state in ('held','unknown')) or exists(select 1 from ai_runs a where a.workspace_id=i.workspace_id and a.pipeline_run_id=i.pipeline_run_id and (a.status='started' or a.estimated_cost_usd is null or a.usage_certainty='unknown'))) cost_unknown
          from enrichment_batch_items i
          left join listing_pipeline_runs r on r.workspace_id=i.workspace_id and r.id=i.pipeline_run_id
          left join listing_drafts d on d.workspace_id=i.workspace_id and d.id=i.listing_id
          left join listing_input_revisions current_input on current_input.workspace_id=i.workspace_id and current_input.listing_id=i.listing_id and current_input.revision=d.input_revision
          left join lateral(select id,remote_product_id from platform_products where workspace_id=i.workspace_id and listing_id=i.listing_id order by updated_at desc,id desc limit 1) p on true
          left join lateral(select a.id from source_assets a where a.workspace_id=i.workspace_id and a.listing_id=i.listing_id and a.kind like 'image/%'
            and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(current_input.sources)='array' then current_input.sources else '[]'::jsonb end) source where source->>'assetId'=a.id::text)
            order by a.created_at,a.id limit 1) image on true
          where i.workspace_id=${workspaceId} and i.batch_id=${batchId}::uuid order by i.created_at,i.id`,
      );
      return rows.map((r) => ({
        id: String(r.id),
        listingId: String(r.listing_id),
        pipelineRunId: r.pipeline_run_id as string | null,
        inputRevision: r.input_revision as number | null,
        outcome: r.outcome as string | null,
        status: String(r.status),
        retryOfItemId: r.retry_of_item_id as string | null,
        isCurrent: Boolean(r.is_current),
        ...(r.outcome !== null || r.cost_unknown
          ? batchItemRecovery({
              outcome: r.outcome as string | null,
              errorCode: r.error_code as string | null,
              costUnknown: Boolean(r.cost_unknown),
              isCurrent: Boolean(r.is_current),
            })
          : { canRetry: false }),
        sku: r.sku as string | null,
        sourceRef: r.source_ref ? String(r.source_ref).slice(0, 8) : null,
        lastStage: String(r.last_stage),
        updatedAt: new Date(r.updated_at as string).toISOString(),
        thumbnailAssetId: r.thumbnail_asset_id as string | null,
      }));
    },
    async cancelBoundItems(batchId: string) {
      scope.assertOpen();
      // Lock the same draft rows used by adoption before fencing their bound runs.
      // A newer manual operation is never selected by this join.
      await tx.execute(
        sql`select d.id from listing_drafts d join enrichment_batch_items i on i.workspace_id=d.workspace_id and i.listing_id=d.id where i.workspace_id=${workspaceId} and i.batch_id=${batchId}::uuid and i.is_current order by d.id for update of d`,
      );
      await tx.execute(
        sql`update listing_pipeline_runs r set execution_state='cancelled',status='succeeded',error_code='batch_cancelled',updated_at=now() from enrichment_batch_items i where i.workspace_id=${workspaceId} and i.batch_id=${batchId}::uuid and i.is_current and r.workspace_id=i.workspace_id and r.id=i.pipeline_run_id and r.execution_state in ('queued','running')`,
      );
      // An unsent message can have an ambiguous network acknowledgement. Keep the
      // hold rather than inventing a refund; workers check the terminal fence.
      await tx.execute(
        sql`update ai_budget_reservations r set state='unknown',updated_at=now() from enrichment_batch_items i join listing_pipeline_runs p on p.workspace_id=i.workspace_id and p.id=i.pipeline_run_id where i.workspace_id=${workspaceId} and i.batch_id=${batchId}::uuid and p.execution_state='cancelled' and r.workspace_id=i.workspace_id and r.pipeline_run_id=i.pipeline_run_id and r.state='held'`,
      );
      await tx.execute(
        sql`update enrichment_batch_items set status='skipped',outcome='cancelled',updated_at=now() where workspace_id=${workspaceId} and batch_id=${batchId}::uuid and is_current and status in ('pending','queued')`,
      );
    },
    async allocateRetries(
      batchId: string,
      itemIds: string[],
    ): Promise<Array<{ listingId: string; retryOfRunId: string }>> {
      scope.assertOpen();
      const rows = await tx.execute(
        sql`select id,listing_id,pipeline_run_id,outcome from enrichment_batch_items where workspace_id=${workspaceId} and batch_id=${batchId}::uuid and id in (${sql.join(
          itemIds.map((id) => sql`${id}::uuid`),
          sql`,`,
        )}) and is_current and outcome='failed' and pipeline_run_id is not null for update`,
      );
      if (rows.length !== itemIds.length)
        throw new BatchControlConflict("invalid_retry_selection");
      const output = [];
      for (const row of rows) {
        await tx.execute(
          sql`update enrichment_batch_items set is_current=false where workspace_id=${workspaceId} and id=${row.id}::uuid`,
        );
        await tx.execute(
          sql`insert into enrichment_batch_items(workspace_id,batch_id,listing_id,retry_of_item_id,status,content_fence) select ${workspaceId},${batchId}::uuid,${row.listing_id}::uuid,${row.id}::uuid,'queued',content_fence from enrichment_batch_items where workspace_id=${workspaceId} and id=${row.id}::uuid`,
        );
        output.push({
          listingId: String(row.listing_id),
          retryOfRunId: String(row.pipeline_run_id),
        });
      }
      return output;
    },
  };
}
