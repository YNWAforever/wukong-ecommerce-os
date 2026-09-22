import { and, eq, gte, inArray, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { aiRuns } from "../schema.js";

export type AppendAiRunInput = {
  listingId: string;
  task:
    | "extract"
    | "generate"
    | "product_shot"
    | "wine_verification"
    | "wine_quality_check";
  idempotencyKey: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  status?: "started" | "succeeded" | "failed";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string | null;
};

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
  beginInvocation(input: BeginAiInvocationInput): Promise<{ claimed: boolean }>;
  finalizeInvocation(input: FinalizeAiInvocationInput): Promise<boolean>;
  append(input: AppendAiRunInput): Promise<void>;
  /**
   * Observed spend across the given drafts, in USD.
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
};

export function createAiRunRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): AiRunRepository {
  return {
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
          estimatedCostUsd: input.estimatedCostUsd.toFixed(6),
          completedAt: new Date(),
        })
        .onConflictDoNothing();
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
