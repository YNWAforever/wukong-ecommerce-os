import type { Database } from "@wukong/db";
import { wineStageOrder } from "@wukong/db";
import { wineListingJobSchema, wineStageMessageKey } from "@wukong/jobs";
/** Terminal recovery only: a started stage is never leased to another executor. */
export async function recoverWineOperation(
  database: Pick<Database, "forWorkspace">,
  workspaceId: string,
  runId: string,
): Promise<{ failed: boolean; reason?: string }> {
  return database.forWorkspace(workspaceId, async (r) => {
    const initial = await r.pipelineRuns.getOperation(runId);
    if (!initial || initial.execution.flowVersion !== "wine-enrichment-v1")
      return { failed: false };
    await r.listings.lockReviewState(initial.listingId);
    await r.pipelineRuns.lockOperation(runId);
    const run = await r.pipelineRuns.getOperation(runId);
    if (!run || !["queued", "running"].includes(run.executionState))
      return { failed: false };
    const now = Date.parse(await r.pipelineRuns.acceptanceTimestamp());
    const deadline = Date.parse(
      (run.execution.wineAcquisition as { deadlineAt?: string })?.deadlineAt ??
        "",
    );
    let reason: string | undefined;
    // Accepted wine operations have one immutable 15-minute deadline. Malformed snapshots fail closed.
    if (
      !Number.isFinite(deadline) ||
      deadline !== Date.parse(run.acceptedAt) + 900000
    )
      reason = "invalid_accepted_execution";
    else if (now >= deadline) reason = "operation_deadline";
    else {
      const order = wineStageOrder(run.execution.wineMode);
      let next: (typeof order)[number] | undefined;
      for (const stage of order) {
        const record = await r.wineEnrichment.readStage(runId, stage);
        if (!record) {
          next = stage;
          break;
        }
        if (record.state !== "succeeded" && record.state !== "skipped")
          return { failed: false };
      }
      if (next) {
        const rows = await r.dispatchOutbox.pending({
          olderThanSeconds: 0,
          maxRows: 10,
          wineRunId: runId,
        });
        const exhausted = rows.some((row) => {
          const parsed = wineListingJobSchema.safeParse(row.payload);
          return (
            row.attempts >= 5 &&
            parsed.success &&
            row.dedupeKey === wineStageMessageKey(runId, next!) &&
            parsed.data.workspaceId === workspaceId &&
            parsed.data.runId === runId &&
            parsed.data.draftId === run.listingId &&
            parsed.data.inputRevision === run.inputRevision &&
            parsed.data.activeVersionSequence === run.activeVersionSequence &&
            parsed.data.stage === next
          );
        });
        if (exhausted) reason = "dispatch_exhausted";
      }
    }
    if (!reason) return { failed: false };
    await r.pipelineRuns.setOperationState(runId, "failed", reason);
    await r.wineEnrichment.settleTerminalBudgets(runId);
    await r.audit.write({
      workspaceId,
      actorId: "system:sweeper",
      entityId: run.listingId,
      action: "listing.operation_abandoned",
      metadata: { runId, errorCode: reason },
    });
    return { failed: true, reason };
  });
}
