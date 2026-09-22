import { and, eq, inArray, sql } from "drizzle-orm";

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
        task: "extract" | "generate" | "product_shot";
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

export type AiRunRepository = {
  append(input: AppendAiRunInput): Promise<void>;
  /**
   * Known cost subtotal across the given drafts, in USD; excludes unknown costs.
   *
   * `estimated_cost_usd` is a numeric column written via `toFixed(6)`, so it
   * returns as a string and must be cast before summing. Budgets are enforced
   * on this number rather than on a running total stored elsewhere, so the
   * budget can never drift out of sync with the runs it is counting.
   */
  sumCostForListings(listingIds: readonly string[]): Promise<number>;
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
