import type { WineStage } from "@wukong/core";
import {
  listingInputDigest,
  parseWineStageResult,
  type WineStageResult,
} from "@wukong/db";
import type { ListingOperation, StageRecord } from "@wukong/db";
import { wineListingJobSchema, type WineListingJob } from "@wukong/jobs";
export {
  WINE_STAGE_ORDER,
  parseWineStageResult,
  type WineStageResult,
} from "@wukong/db";
export type WineStageContext = {
  schemaVersion: 1;
  job: WineListingJob;
  run: ListingOperation;
  dependencyDigest: string;
  dependencies: StageRecord[];
};
export type WinePostCommitDiagnostic = {
  code: "post_commit_skipped" | "post_commit_oversized" | "post_commit_failed";
};
export type WineCommittedStage = {
  context: WineStageContext;
  result: Extract<WineStageResult, { state: "succeeded" }>;
};
/** Idempotent optional work; re-read committed authority before any side effects. */
export type WineAfterCommit = (
  committed: WineCommittedStage,
) => Promise<void | { code: "post_commit_skipped" | "post_commit_oversized" }>;
export type WineDeliveryResult =
  | {
      status: "advanced";
      nextStage: WineStage;
      postCommitDiagnostic?: WinePostCommitDiagnostic;
    }
  | { status: "duplicate"; postCommitDiagnostic?: WinePostCommitDiagnostic }
  | {
      status: "completed";
      versionId: string | null;
      outcome: "complete" | "needs_info";
    }
  | { status: "blocked" | "stopped"; code: string };
export type WineClaim =
  | Exclude<WineDeliveryResult, { status: "duplicate" }>
  | { status: "duplicate"; committed?: WineCommittedStage }
  | { status: "claimed"; context: WineStageContext };
export type WineStageStore = {
  claim(job: WineListingJob): Promise<WineClaim>;
  finish(
    context: WineStageContext,
    result: WineStageResult,
  ): Promise<WineDeliveryResult>;
  commitCandidate(context: WineStageContext): Promise<WineDeliveryResult>;
};
export type WineStageExecutor = (
  context: WineStageContext,
) => Promise<WineStageResult>;
/** A delivery owns one stage. Awaiting claim has already COMMITTED before execute. */
export async function runWineStage(
  raw: WineListingJob,
  deps: {
    store: WineStageStore;
    execute: WineStageExecutor;
    afterCommit?: WineAfterCommit;
  },
): Promise<WineDeliveryResult> {
  const job = wineListingJobSchema.parse(raw),
    claim = await deps.store.claim(job);
  if (claim.status === "duplicate") {
    return claim.committed
      ? afterCommitted(
          { status: "duplicate" },
          claim.committed,
          deps.afterCommit,
        )
      : { status: "duplicate" };
  }
  if (claim.status !== "claimed") return claim;
  if (job.stage === "commit_candidate")
    return deps.store.commitCandidate(claim.context);
  let result: WineStageResult;
  try {
    result = parseWineStageResult(
      await deps.execute(structuredClone(claim.context)),
      job.stage,
    );
  } catch {
    result = {
      schemaVersion: 1,
      state: "unknown",
      stage: job.stage,
      code: "stage_execution_unknown",
    };
  }
  // A DB failure is propagated, never converted into a fresh execution attempt.
  const delivery = await deps.store.finish(claim.context, result);
  if (delivery.status === "advanced" && result.state === "succeeded")
    return afterCommitted(
      delivery,
      { context: claim.context, result },
      deps.afterCommit,
    );
  return delivery;
}

/** Hook diagnostics never rewrite a checkpoint or remove an already committed outbox. */
async function afterCommitted(
  delivery: Extract<WineDeliveryResult, { status: "advanced" | "duplicate" }>,
  committed: WineCommittedStage,
  hook?: WineAfterCommit,
): Promise<WineDeliveryResult> {
  if (!hook) return delivery;
  try {
    const diagnostic = await hook(structuredClone(committed));
    if (diagnostic === undefined) return delivery;
    if (
      !diagnostic ||
      typeof diagnostic !== "object" ||
      Object.keys(diagnostic).length !== 1 ||
      !["post_commit_skipped", "post_commit_oversized"].includes(
        diagnostic.code,
      )
    )
      throw Error("invalid postcommit diagnostic");
    return { ...delivery, postCommitDiagnostic: { code: diagnostic.code } };
  } catch {
    return {
      ...delivery,
      postCommitDiagnostic: { code: "post_commit_failed" },
    };
  }
}
