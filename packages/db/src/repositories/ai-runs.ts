import { and, eq, inArray, sql } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { aiRuns } from "../schema.js";

export type AppendAiRunInput = {
  listingId: string;
  task: "extract" | "generate";
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

export type AiRunRepository = {
  append(input: AppendAiRunInput): Promise<void>;
  /**
   * Observed spend across the given drafts, in USD.
   *
   * `estimated_cost_usd` is a numeric column written via `toFixed(6)`, so it
   * returns as a string and must be cast before summing. Budgets are enforced
   * on this number rather than on a running total stored elsewhere, so the
   * budget can never drift out of sync with the runs it is counting.
   */
  sumCostForListings(listingIds: readonly string[]): Promise<number>;
};

export function createAiRunRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): AiRunRepository {
  return {
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

    async sumCostForListings(listingIds) {
      scope.assertOpen();
      if (listingIds.length === 0) return 0;
      const [row] = await transaction
        .select({
          total: sql<string>`coalesce(sum(${aiRuns.estimatedCostUsd}::numeric), 0)::text`,
        })
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.workspaceId, workspaceId),
            inArray(aiRuns.listingId, [...listingIds]),
          ),
        );
      return Number(row?.total ?? 0);
    },
  };
}
