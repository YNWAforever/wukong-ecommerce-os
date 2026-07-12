import { and, eq } from "drizzle-orm";

import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { listingPipelineRuns, listingPipelineSteps } from "../schema.js";

export type PipelineResult = { status: "in_review" | "needs_info"; versionId: string | null };

export type PipelineRunRepository = {
  getCompleted(idempotencyKey: string): Promise<PipelineResult | null>;
  recordStep(input: {
    idempotencyKey: string;
    listingId: string;
    activeVersionSequence: number;
    step: "started" | "extracted" | "generated";
  }): Promise<void>;
  complete(input: {
    idempotencyKey: string;
    listingId: string;
    activeVersionSequence: number;
    status: "in_review" | "needs_info";
    versionId: string | null;
  }): Promise<void>;
};

export function createPipelineRunRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): PipelineRunRepository {
  const runWhere = (idempotencyKey: string) => and(
    eq(listingPipelineRuns.workspaceId, workspaceId),
    eq(listingPipelineRuns.idempotencyKey, idempotencyKey),
  );

  return {
    async getCompleted(idempotencyKey) {
      scope.assertOpen();
      const [run] = await transaction.select({
        status: listingPipelineRuns.resultStatus,
        versionId: listingPipelineRuns.versionId,
      }).from(listingPipelineRuns).where(and(
        runWhere(idempotencyKey),
        eq(listingPipelineRuns.status, "succeeded"),
      )).limit(1);
      if (!run?.status || (run.status !== "in_review" && run.status !== "needs_info")) return null;
      return { status: run.status, versionId: run.versionId };
    },

    async recordStep(input) {
      scope.assertOpen();
      await transaction.insert(listingPipelineRuns).values({
        workspaceId,
        listingId: input.listingId,
        activeVersionSequence: input.activeVersionSequence,
        idempotencyKey: input.idempotencyKey,
        status: "started",
      }).onConflictDoNothing();
      const [run] = await transaction.select({ id: listingPipelineRuns.id })
        .from(listingPipelineRuns).where(runWhere(input.idempotencyKey)).limit(1);
      if (!run) throw new Error("pipeline recovery run is unavailable");
      await transaction.insert(listingPipelineSteps).values({
        workspaceId,
        pipelineRunId: run.id,
        step: input.step,
      }).onConflictDoNothing();
    },

    async complete(input) {
      scope.assertOpen();
      const updated = await transaction.update(listingPipelineRuns).set({
        status: "succeeded",
        resultStatus: input.status,
        versionId: input.versionId,
        errorCode: null,
        updatedAt: new Date(),
      }).where(and(
        runWhere(input.idempotencyKey),
        eq(listingPipelineRuns.listingId, input.listingId),
        eq(listingPipelineRuns.activeVersionSequence, input.activeVersionSequence),
      )).returning({ id: listingPipelineRuns.id });
      if (updated.length !== 1) throw new Error("pipeline recovery run is unavailable");
    },
  };
}
