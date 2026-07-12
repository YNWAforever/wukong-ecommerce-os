import { and, eq } from "drizzle-orm";

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

export type AiRunRepository = { append(input: AppendAiRunInput): Promise<void> };

export function createAiRunRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): AiRunRepository {
  return {
    async append(input) {
      scope.assertOpen();
      await transaction.insert(aiRuns).values({
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
      }).onConflictDoNothing();
    },
  };
}