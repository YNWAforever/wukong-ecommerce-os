import { and, desc, eq, exists, lt, not, sql } from "drizzle-orm";
import type { WorkspaceScope, WorkspaceTransaction } from "../client.js";
import { listingPipelineRuns, listingPipelineSteps } from "../schema.js";

export type PipelineResult = {
  status: "in_review" | "needs_info";
  versionId: string | null;
};
export type PipelineStepName = "started" | "extracted" | "generated";
export type PipelineRunState = {
  idempotencyKey: string;
  status: "started" | "succeeded" | "failed";
  resultStatus: PipelineResult["status"] | null;
  versionId: string | null;
  errorCode: string | null;
  steps: ReadonlyMap<
    PipelineStepName,
    { state: "running" | "completed"; output: unknown }
  >;
};
/**
 * How long a claimed step is treated as live before another delivery may steal
 * it. Must outlive the worst-case provider call, or a redelivery reclaims a
 * step that is still running and the extraction is paid for twice.
 */
export const PIPELINE_STEP_LEASE_MS = 300_000;

export type PipelineRunSummary = {
  id: string;
  listingId: string;
  versionId: string | null;
  status: "started" | "succeeded" | "failed";
  errorCode: string | null;
  createdAt: Date;
};
export type StepClaim = {
  claimed: boolean;
  completed: boolean;
  output: unknown;
  leaseToken: string | null;
  /**
   * When the blocking lease goes stale, set only when another holder owns the
   * step. Callers schedule their retry from this instead of a flat delay --
   * a redelivery before this instant can only fail the same way.
   */
  leaseExpiresAt: Date | null;
};
export type PipelineRunRepository = {
  getCompleted(key: string): Promise<PipelineResult | null>;
  getState(key: string): Promise<PipelineRunState | null>;
  /** Newest-first, this workspace's pipeline runs only. `limit` defaults to
   * 100 and must be between 1 and 100. */
  listForWorkspace(limit?: number): Promise<PipelineRunSummary[]>;
  claimStep(input: {
    idempotencyKey: string;
    listingId: string;
    activeVersionSequence: number;
    step: PipelineStepName;
  }): Promise<StepClaim>;
  recordStep(input: {
    idempotencyKey: string;
    listingId: string;
    activeVersionSequence: number;
    step: PipelineStepName;
    leaseToken: string;
    output?: unknown;
  }): Promise<void>;
  complete(input: {
    idempotencyKey: string;
    listingId: string;
    activeVersionSequence: number;
    step: PipelineStepName;
    leaseToken?: string;
    status: PipelineResult["status"];
    versionId: string | null;
  }): Promise<void>;
  fail(input: {
    idempotencyKey: string;
    listingId: string;
    activeVersionSequence: number;
    errorCode: string;
    step: PipelineStepName;
    leaseToken?: string;
  }): Promise<boolean>;
  releaseStep(input: {
    idempotencyKey: string;
    step: PipelineStepName;
    leaseToken: string;
  }): Promise<void>;
  /**
   * Returns a failed run to `started` so an operator can re-drive it, and drops
   * any step still marked `running`. A failed run has no live worker by
   * definition -- those rows are orphaned leases, and leaving them would block
   * the retry until they went stale. Completed steps are kept so the retry does
   * not pay for extraction again. No-op unless the run is currently failed.
   */
  reopenFailed(idempotencyKey: string): Promise<boolean>;
};

export function createPipelineRunRepository(
  transaction: WorkspaceTransaction,
  workspaceId: string,
  scope: WorkspaceScope,
): PipelineRunRepository {
  const runWhere = (key: string) =>
    and(
      eq(listingPipelineRuns.workspaceId, workspaceId),
      eq(listingPipelineRuns.idempotencyKey, key),
    );

  const ensureRun = async (input: {
    idempotencyKey: string;
    listingId: string;
    activeVersionSequence: number;
  }) => {
    await transaction
      .insert(listingPipelineRuns)
      .values({
        workspaceId,
        listingId: input.listingId,
        activeVersionSequence: input.activeVersionSequence,
        idempotencyKey: input.idempotencyKey,
        status: "started",
      })
      .onConflictDoNothing();
    const [run] = await transaction
      .select({
        id: listingPipelineRuns.id,
        listingId: listingPipelineRuns.listingId,
        activeVersionSequence: listingPipelineRuns.activeVersionSequence,
        status: listingPipelineRuns.status,
      })
      .from(listingPipelineRuns)
      .where(runWhere(input.idempotencyKey))
      .limit(1);
    if (
      !run ||
      run.listingId !== input.listingId ||
      run.activeVersionSequence !== input.activeVersionSequence
    ) {
      throw new Error(
        "pipeline recovery run does not match queued listing revision",
      );
    }
    return run;
  };

  const stepLeaseExists = (
    runId: unknown,
    step: PipelineStepName,
    leaseToken: string,
  ) =>
    exists(
      transaction
        .select({ one: sql.raw("1") })
        .from(listingPipelineSteps)
        .where(
          and(
            eq(listingPipelineSteps.workspaceId, workspaceId),
            eq(listingPipelineSteps.pipelineRunId, runId as never),
            eq(listingPipelineSteps.step, step),
            eq(listingPipelineSteps.leaseToken, leaseToken),
          ),
        ),
    );

  const completedStepExists = (runId: unknown, step: PipelineStepName) =>
    exists(
      transaction
        .select({ one: sql.raw("1") })
        .from(listingPipelineSteps)
        .where(
          and(
            eq(listingPipelineSteps.workspaceId, workspaceId),
            eq(listingPipelineSteps.pipelineRunId, runId as never),
            eq(listingPipelineSteps.step, step),
            eq(listingPipelineSteps.state, "completed"),
          ),
        ),
    );

  const runningStepExists = (runId: unknown) =>
    exists(
      transaction
        .select({ one: sql.raw("1") })
        .from(listingPipelineSteps)
        .where(
          and(
            eq(listingPipelineSteps.workspaceId, workspaceId),
            eq(listingPipelineSteps.pipelineRunId, runId as never),
            eq(listingPipelineSteps.state, "running"),
          ),
        ),
    );

  const stepCanComplete = (
    runId: unknown,
    step: PipelineStepName,
    leaseToken: string | undefined,
  ) =>
    leaseToken
      ? stepLeaseExists(runId, step, leaseToken)
      : and(completedStepExists(runId, step), not(runningStepExists(runId)));
  return {
    async getCompleted(key) {
      scope.assertOpen();
      const [run] = await transaction
        .select({
          status: listingPipelineRuns.resultStatus,
          versionId: listingPipelineRuns.versionId,
        })
        .from(listingPipelineRuns)
        .where(and(runWhere(key), eq(listingPipelineRuns.status, "succeeded")))
        .limit(1);
      if (!run?.status || !["in_review", "needs_info"].includes(run.status)) {
        return null;
      }
      return {
        status: run.status as "in_review" | "needs_info",
        versionId: run.versionId,
      };
    },

    async getState(key) {
      scope.assertOpen();
      const [run] = await transaction
        .select({
          id: listingPipelineRuns.id,
          idempotencyKey: listingPipelineRuns.idempotencyKey,
          status: listingPipelineRuns.status,
          resultStatus: listingPipelineRuns.resultStatus,
          versionId: listingPipelineRuns.versionId,
          errorCode: listingPipelineRuns.errorCode,
        })
        .from(listingPipelineRuns)
        .where(runWhere(key))
        .limit(1);
      if (!run) return null;
      const rows = await transaction
        .select({
          step: listingPipelineSteps.step,
          state: listingPipelineSteps.state,
          output: listingPipelineSteps.output,
        })
        .from(listingPipelineSteps)
        .where(
          and(
            eq(listingPipelineSteps.workspaceId, workspaceId),
            eq(listingPipelineSteps.pipelineRunId, run.id),
          ),
        );
      const steps = new Map<
        PipelineStepName,
        { state: "running" | "completed"; output: unknown }
      >();
      for (const row of rows) {
        if (
          row.step === "started" ||
          row.step === "extracted" ||
          row.step === "generated"
        ) {
          steps.set(row.step, {
            state: row.state === "completed" ? "completed" : "running",
            output: row.output,
          });
        }
      }
      return {
        idempotencyKey: run.idempotencyKey,
        status: run.status as "started" | "succeeded" | "failed",
        resultStatus:
          run.resultStatus === "in_review" || run.resultStatus === "needs_info"
            ? run.resultStatus
            : null,
        versionId: run.versionId,
        errorCode: run.errorCode,
        steps,
      };
    },

    async listForWorkspace(limit = 100) {
      scope.assertOpen();
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("pipeline run limit must be between 1 and 100");
      }
      const rows = await transaction
        .select({
          id: listingPipelineRuns.id,
          listingId: listingPipelineRuns.listingId,
          versionId: listingPipelineRuns.versionId,
          status: listingPipelineRuns.status,
          errorCode: listingPipelineRuns.errorCode,
          createdAt: listingPipelineRuns.createdAt,
        })
        .from(listingPipelineRuns)
        .where(eq(listingPipelineRuns.workspaceId, workspaceId))
        // Rows created within one shared `db.forWorkspace` transaction share
        // Postgres's per-transaction `now()`, so `created_at` alone can tie --
        // `id` breaks the tie deterministically instead of leaving same-instant
        // rows in an arbitrary order.
        .orderBy(
          desc(listingPipelineRuns.createdAt),
          desc(listingPipelineRuns.id),
        )
        .limit(limit);
      return rows.map((row) => ({
        id: row.id,
        listingId: row.listingId,
        versionId: row.versionId,
        status: row.status as "started" | "succeeded" | "failed",
        errorCode: row.errorCode,
        createdAt: row.createdAt,
      }));
    },

    async claimStep(input) {
      scope.assertOpen();
      const run = await ensureRun(input);
      if (run.status === "succeeded") {
        return {
          claimed: false,
          completed: true,
          output: null,
          leaseToken: null,
          leaseExpiresAt: null,
        };
      }

      const inserted = await transaction
        .insert(listingPipelineSteps)
        .values({
          workspaceId,
          pipelineRunId: run.id,
          step: input.step,
          state: "running",
          output: null,
          updatedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({
          id: listingPipelineSteps.id,
          leaseToken: listingPipelineSteps.leaseToken,
        });
      if (inserted.length) {
        return {
          claimed: true,
          completed: false,
          output: null,
          leaseToken: inserted[0]!.leaseToken,
          leaseExpiresAt: null,
        };
      }

      const [existing] = await transaction
        .select({
          id: listingPipelineSteps.id,
          state: listingPipelineSteps.state,
          output: listingPipelineSteps.output,
          updatedAt: listingPipelineSteps.updatedAt,
          leaseToken: listingPipelineSteps.leaseToken,
        })
        .from(listingPipelineSteps)
        .where(
          and(
            eq(listingPipelineSteps.workspaceId, workspaceId),
            eq(listingPipelineSteps.pipelineRunId, run.id),
            eq(listingPipelineSteps.step, input.step),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("pipeline step is unavailable");
      if (existing.state === "completed") {
        return {
          claimed: false,
          completed: true,
          output: existing.output,
          leaseToken: null,
          leaseExpiresAt: null,
        };
      }

      const staleBefore = new Date(Date.now() - PIPELINE_STEP_LEASE_MS);
      const reclaimed = await transaction
        .update(listingPipelineSteps)
        .set({
          state: "running",
          leaseToken: sql.raw("gen_random_uuid()"),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(listingPipelineSteps.id, existing.id),
            eq(listingPipelineSteps.state, "running"),
            lt(listingPipelineSteps.updatedAt, staleBefore),
          ),
        )
        .returning({ leaseToken: listingPipelineSteps.leaseToken });
      return reclaimed.length
        ? {
            claimed: true,
            completed: false,
            output: null,
            leaseToken: reclaimed[0]!.leaseToken,
            leaseExpiresAt: null,
          }
        : {
            claimed: false,
            completed: false,
            output: null,
            leaseToken: null,
            leaseExpiresAt: new Date(
              existing.updatedAt.getTime() + PIPELINE_STEP_LEASE_MS,
            ),
          };
    },

    async recordStep(input) {
      scope.assertOpen();
      const run = await ensureRun(input);
      const updated = await transaction
        .update(listingPipelineSteps)
        .set({
          state: "completed",
          output: input.output ?? null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(listingPipelineSteps.workspaceId, workspaceId),
            eq(listingPipelineSteps.pipelineRunId, run.id),
            eq(listingPipelineSteps.step, input.step),
            eq(listingPipelineSteps.leaseToken, input.leaseToken),
          ),
        )
        .returning({ id: listingPipelineSteps.id });
      if (!updated.length) throw new Error("pipeline step lease lost");
    },

    async complete(input) {
      scope.assertOpen();
      const updated = await transaction
        .update(listingPipelineRuns)
        .set({
          status: "succeeded",
          resultStatus: input.status,
          versionId: input.versionId,
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            runWhere(input.idempotencyKey),
            eq(listingPipelineRuns.listingId, input.listingId),
            eq(
              listingPipelineRuns.activeVersionSequence,
              input.activeVersionSequence,
            ),
            stepCanComplete(
              listingPipelineRuns.id,
              input.step,
              input.leaseToken,
            ),
          ),
        )
        .returning({ id: listingPipelineRuns.id });
      if (!updated.length) throw new Error("pipeline step lease lost");
    },

    async fail(input) {
      scope.assertOpen();
      const [run] = await transaction
        .select({ id: listingPipelineRuns.id })
        .from(listingPipelineRuns)
        .where(runWhere(input.idempotencyKey))
        .limit(1);
      if (!run) return false;
      const leaseGuard = input.leaseToken
        ? stepLeaseExists(run.id, input.step, input.leaseToken)
        : not(
            exists(
              transaction
                .select({ one: sql.raw("1") })
                .from(listingPipelineSteps)
                .where(
                  and(
                    eq(listingPipelineSteps.workspaceId, workspaceId),
                    eq(listingPipelineSteps.pipelineRunId, run.id),
                    eq(listingPipelineSteps.state, "running"),
                  ),
                ),
            ),
          );
      const updated = await transaction
        .update(listingPipelineRuns)
        .set({
          status: "failed",
          errorCode: input.errorCode,
          updatedAt: new Date(),
        })
        .where(
          and(
            runWhere(input.idempotencyKey),
            eq(listingPipelineRuns.listingId, input.listingId),
            eq(
              listingPipelineRuns.activeVersionSequence,
              input.activeVersionSequence,
            ),
            eq(listingPipelineRuns.status, "started"),
            leaseGuard,
          ),
        )
        .returning({ id: listingPipelineRuns.id });
      return updated.length > 0;
    },

    async reopenFailed(idempotencyKey) {
      scope.assertOpen();
      const [run] = await transaction
        .select({ id: listingPipelineRuns.id })
        .from(listingPipelineRuns)
        .where(
          and(
            runWhere(idempotencyKey),
            eq(listingPipelineRuns.status, "failed"),
          ),
        )
        .limit(1);
      if (!run) return false;
      await transaction
        .delete(listingPipelineSteps)
        .where(
          and(
            eq(listingPipelineSteps.workspaceId, workspaceId),
            eq(listingPipelineSteps.pipelineRunId, run.id),
            eq(listingPipelineSteps.state, "running"),
          ),
        );
      const updated = await transaction
        .update(listingPipelineRuns)
        .set({ status: "started", errorCode: null, updatedAt: new Date() })
        .where(
          and(
            runWhere(idempotencyKey),
            eq(listingPipelineRuns.status, "failed"),
          ),
        )
        .returning({ id: listingPipelineRuns.id });
      return updated.length > 0;
    },

    async releaseStep(input) {
      scope.assertOpen();
      const [run] = await transaction
        .select({ id: listingPipelineRuns.id })
        .from(listingPipelineRuns)
        .where(runWhere(input.idempotencyKey))
        .limit(1);
      if (!run) return;
      await transaction
        .delete(listingPipelineSteps)
        .where(
          and(
            eq(listingPipelineSteps.workspaceId, workspaceId),
            eq(listingPipelineSteps.pipelineRunId, run.id),
            eq(listingPipelineSteps.step, input.step),
            eq(listingPipelineSteps.state, "running"),
            eq(listingPipelineSteps.leaseToken, input.leaseToken),
          ),
        );
    },
  };
}
