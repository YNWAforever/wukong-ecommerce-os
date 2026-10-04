import { and, eq, gte, inArray, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { aiRuns, listingVersions } from "../schema.js";

type AiRunInputBase = {
  listingId: string;
  idempotencyKey: string;
  provider: string;
  model: string;
  promptVersion: string;
  latencyMs: number;
  status?: "started" | "succeeded" | "failed";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string | null;
};

export type AppendAiRunInput = AiRunInputBase &
  (
    | {
        task:
          | "extract"
          | "generate"
          | "product_shot"
          | "wine_verification"
          | "wine_quality_check";
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd: number;
      }
    | {
        task: "verify";
        listingVersionId: string;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedCostUsd: number | null;
        /** Validated verification record crossing the JSON boundary; no AI dependency. */
        output: Record<string, unknown>;
      }
  );

export type AiRunCostSummary = {
  knownCostUsd: number;
  unknownCostRunCount: number;
};

export type UnknownAiCostReference = {
  aiRunId: string;
  listingId: string;
  pipelineRunId: string | null;
  batchId: string | null;
  stage: string | null;
  createdAt: string;
};
export type OwnedAiCostMetadata = AiRunCostSummary & {
  unknownCostReferences: {
    asOf: string;
    total: number;
    limit: 25;
    hasMore: boolean;
    items: UnknownAiCostReference[];
  };
};
const SAFE_COST_STAGES = new Set([
  "extract",
  "generate",
  "extraction",
  "generation",
  "verification",
  "verification_deep",
  "quality_check",
]);

export type BeginAiInvocationInput = {
  listingId: string;
  pipelineRunId: string;
  task:
    | "extract"
    | "generate"
    | "product_shot"
    | "wine_verification"
    | "wine_quality_check";
  stage: string;
  callOrdinal: number;
  provider: string;
  model: string;
  promptVersion: string;
};
export type FinalizeAiInvocationInput = {
  pipelineRunId: string;
  stage: string;
  callOrdinal: number;
  status: "succeeded" | "failed";
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  estimatedCostUsd: string | null;
  usageCertainty: "measured" | "estimated" | "unknown";
  failureCategory?: string | null;
  httpStatus?: number | null;
  providerCode?: string | null;
  providerRequestId?: string | null;
};

export type AiRunRepository = {
  summarizeOwnedCostMetadata(): Promise<OwnedAiCostMetadata>;
  beginInvocation(input: BeginAiInvocationInput): Promise<{ claimed: boolean }>;
  finalizeInvocation(input: FinalizeAiInvocationInput): Promise<boolean>;
  append(input: AppendAiRunInput): Promise<void>;
  /**
   * Known cost subtotal across the given drafts, in USD; excludes unknown costs.
   *
   * `estimated_cost_usd` is a numeric column written via `toFixed(6)`, so it
   * returns as a string and must be cast before summing. Budgets are enforced
   * on this number rather than on a running total stored elsewhere, so the
   * budget can never drift out of sync with the runs it is counting.
   *
   * `since` remains available for legacy reports. New enrichment batches bind
   * every item to an exact immutable pipeline run and account through that
   * run's reservation, so their admission does not use this time window.
   */
  sumCostForListings(
    listingIds: readonly string[],
    options?: { since?: Date },
  ): Promise<number>;
  summarizeCostForListings(
    listingIds: readonly string[],
  ): Promise<AiRunCostSummary>;
};

export function createAiRunRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): AiRunRepository {
  return {
    async summarizeOwnedCostMetadata() {
      scope.assertOpen();
      // This exact live population powers BOTH the NULL count/references and known subtotal.
      // Owned lineage joins never echo a foreign pointer, and archive visibility never erases spend.
      const [row] = await transaction.execute(sql`
        with owned as materialized (
          select a.id,a.listing_id,a.pipeline_run_id,a.stage,a.created_at,a.estimated_cost_usd
          from ai_runs a join listing_drafts d on d.workspace_id=${workspaceId} and d.id=a.listing_id
          where a.workspace_id=${workspaceId}
        ), unknown_items as (
          select a.id,a.listing_id,p.id pipeline_run_id,b.id batch_id,a.stage,a.created_at
          from owned a
          left join listing_pipeline_runs p on p.workspace_id=${workspaceId} and p.listing_id=a.listing_id and p.id=a.pipeline_run_id
          left join lateral (
            select batch.id from enrichment_batch_items item
            join enrichment_batches batch on batch.workspace_id=${workspaceId} and batch.id=item.batch_id
            where item.workspace_id=${workspaceId} and item.listing_id=a.listing_id and item.pipeline_run_id=p.id
            order by batch.id limit 1
          ) b on true
          where a.estimated_cost_usd is null order by a.created_at desc,a.id desc limit 25
        )
        select clock_timestamp() as as_of,
          (select coalesce(sum(estimated_cost_usd),0)::text from owned) as known,
          (select count(*)::int from owned where estimated_cost_usd is null) as unknown,
          coalesce((select jsonb_agg(jsonb_build_object('aiRunId',id,'listingId',listing_id,'pipelineRunId',pipeline_run_id,'batchId',batch_id,'stage',stage,'createdAt',created_at) order by created_at desc,id desc) from unknown_items),'[]'::jsonb) as items
      `);
      if (!row) throw Error("AI cost metadata observation missing");
      const total = Number(row.unknown),
        knownCostUsd = Number(row.known);
      if (
        !Number.isSafeInteger(total) ||
        total < 0 ||
        !Number.isFinite(knownCostUsd) ||
        knownCostUsd < 0 ||
        !Array.isArray(row.items)
      )
        throw Error("AI cost metadata invariant");
      const items = (row.items as UnknownAiCostReference[]).map((item) => ({
        aiRunId: item.aiRunId,
        listingId: item.listingId,
        pipelineRunId: item.pipelineRunId,
        batchId: item.batchId,
        stage:
          item.stage && SAFE_COST_STAGES.has(item.stage) ? item.stage : null,
        createdAt: new Date(item.createdAt).toISOString(),
      }));
      return {
        knownCostUsd,
        unknownCostRunCount: total,
        unknownCostReferences: {
          asOf: new Date(row.as_of as string).toISOString(),
          total,
          limit: 25,
          hasMore: total > items.length,
          items,
        },
      };
    },
    async beginInvocation(input) {
      scope.assertOpen();
      const inserted = await transaction.execute(
        sql`insert into ai_runs(workspace_id,listing_id,task,idempotency_key,provider,model,status,input,latency_ms,pipeline_run_id,stage,call_ordinal,usage_certainty) values(${workspaceId},${input.listingId},${input.task},${`${input.pipelineRunId}:${input.stage}:${input.callOrdinal}`},${input.provider},${input.model},'started',${JSON.stringify({ promptVersion: input.promptVersion })}::jsonb,0,${input.pipelineRunId},${input.stage},${input.callOrdinal},'unknown') on conflict (workspace_id,pipeline_run_id,stage,call_ordinal) where pipeline_run_id is not null do nothing returning id`,
      );
      return { claimed: Boolean(inserted[0]) };
    },
    async finalizeInvocation(input) {
      scope.assertOpen();
      const updated = await transaction.execute(
        sql`update ai_runs set status=${input.status},input_tokens=${input.inputTokens},output_tokens=${input.outputTokens},latency_ms=${input.latencyMs},estimated_cost_usd=${input.estimatedCostUsd}::numeric,usage_certainty=${input.usageCertainty},failure_category=${input.failureCategory ?? null},http_status=${input.httpStatus ?? null},provider_code=${input.providerCode ?? null},provider_request_id=${input.providerRequestId ?? null},completed_at=now() where workspace_id=${workspaceId} and pipeline_run_id=${input.pipelineRunId} and stage=${input.stage} and call_ordinal=${input.callOrdinal} and status='started' returning id`,
      );
      return Boolean(updated[0]);
    },
    async append(input) {
      scope.assertOpen();
      if (input.task === "verify") {
        if (
          !input.listingVersionId ||
          input.output?.listingVersionId !== input.listingVersionId
        ) {
          throw new Error("verification output version does not match");
        }
        const validTokens = [input.inputTokens, input.outputTokens].every(
          (value) => value === null || (Number.isInteger(value) && value >= 0),
        );
        const validCost =
          input.estimatedCostUsd === null ||
          (Number.isFinite(input.estimatedCostUsd) &&
            input.estimatedCostUsd >= 0);
        if (!validTokens || !validCost) {
          throw new Error(
            "verification usage must be nonnegative and finite; tokens must be integers",
          );
        }
        const [version] = await transaction
          .select({ id: listingVersions.id })
          .from(listingVersions)
          .where(
            and(
              eq(listingVersions.workspaceId, workspaceId),
              eq(listingVersions.listingId, input.listingId),
              eq(listingVersions.id, input.listingVersionId),
            ),
          );
        if (!version)
          throw new Error("verification version does not belong to listing");
      }
      await transaction
        .insert(aiRuns)
        .values({
          workspaceId,
          listingId: input.listingId,
          promptVersionId: null,
          task: input.task,
          idempotencyKey: input.idempotencyKey,
          provider: input.provider,
          model: input.model,
          status: input.status ?? "succeeded",
          input: input.input ?? {},
          output: input.output ?? {},
          error: input.error ?? null,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          latencyMs: input.latencyMs,
          estimatedCostUsd:
            input.estimatedCostUsd === null
              ? null
              : input.estimatedCostUsd.toFixed(6),
          completedAt: new Date(),
        })
        .onConflictDoNothing();
    },

    async summarizeCostForListings(listingIds) {
      scope.assertOpen();
      if (listingIds.length === 0)
        return { knownCostUsd: 0, unknownCostRunCount: 0 };
      const [row] = await transaction
        .select({
          known: sql<string>`coalesce(sum(${aiRuns.estimatedCostUsd}::numeric), 0)::text`,
          unknown: sql<number>`(count(*) filter (where ${aiRuns.estimatedCostUsd} is null))::int`,
        })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.workspaceId, workspaceId),
            inArray(aiRuns.listingId, [...listingIds]),
          ),
        );
      return {
        knownCostUsd: Number(row?.known ?? 0),
        unknownCostRunCount: row?.unknown ?? 0,
      };
    },

    async sumCostForListings(listingIds, options) {
      scope.assertOpen();
      if (listingIds.length === 0) return 0;
      const [row] = await transaction
        .select({
          total: sql<string>`coalesce(sum(${aiRuns.estimatedCostUsd}::numeric), 0)::text`,
        })
        .from(aiRuns)
        .where(
          // `and` drops undefined, so an absent `since` leaves the query
          // exactly as it was.
          and(
            eq(aiRuns.workspaceId, workspaceId),
            inArray(aiRuns.listingId, [...listingIds]),
            options?.since ? gte(aiRuns.createdAt, options.since) : undefined,
          ),
        );
      return Number(row?.total ?? 0);
    },
  };
}
