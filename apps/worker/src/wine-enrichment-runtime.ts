import { wineStageDependencyDigest } from "./wine-stage-dependencies.js";
import {
  wineBudgetSnapshotSchema,
  wineEnrichmentPolicySchema,
  type WineStage,
} from "@wukong/core";
import { wineExecutionSnapshotSchema } from "@wukong/ai";
import {
  wineAcquisitionPolicySchema,
  wineListingJobSchema,
  wineStageMessageKey,
  type WineListingJob,
} from "@wukong/jobs";
import {
  listingInputDigest,
  type Database,
  type ListingOperation,
  type WorkspaceRepositories,
  type StageRecord,
} from "@wukong/db";
import {
  WINE_STAGE_ORDER,
  parseWineStageResult,
  type WineStageContext,
  type WineStageResult,
  type WineStageStore,
  type WineDeliveryResult,
} from "./wine-enrichment-pipeline.js";

/** Task9 supplies this DB-only transaction port. No network I/O is permitted here. */
export type WineCandidateProjection = (
  repos: WorkspaceRepositories,
  context: WineStageContext & { requiredOutcome: "ready" | "needs_info" },
) => Promise<
  Extract<WineStageResult, { stage: "commit_candidate"; state: "succeeded" }>
>;
type Options = { now?: () => Date; projectCandidate?: WineCandidateProjection };
const blocked = (code: string): WineDeliveryResult => ({
  status: "blocked",
  code,
});
function savedResult(record: StageRecord): WineStageResult {
  const value = record.output as {
    schemaVersion?: number;
    fresh?: boolean;
    result?: unknown;
  };
  if (
    value?.schemaVersion !== 1 ||
    value.fresh !== true ||
    record.state !== "succeeded"
  )
    throw Error("stage dependency unavailable");
  return parseWineStageResult(value.result, record.stage);
}
function validDependencies(
  run: ListingOperation,
  dependencies: StageRecord[],
): boolean {
  const prefix: StageRecord[] = [];
  try {
    for (const record of dependencies) {
      if (
        record.runId !== run.id ||
        record.inputDigest !== run.execution.wineInputDigest ||
        record.dependencyDigest !== wineStageDependencyDigest(run, prefix)
      )
        return false;
      if (record.state === "skipped") {
        const verification = prefix.find((x) => x.stage === "verification");
        const result = verification ? savedResult(verification) : null;
        const output = record.output as {
          schemaVersion?: number;
          reason?: string;
        };
        if (
          !["search_deep", "verification_deep"].includes(record.stage) ||
          output?.schemaVersion !== 1 ||
          output.reason !== "deep_search_not_required" ||
          !result ||
          result.state !== "succeeded" ||
          result.stage !== "verification" ||
          result.needsDeepSearch
        )
          return false;
      } else if (savedResult(record).state !== "succeeded") return false;
      prefix.push(record);
    }
    return true;
  } catch {
    return false;
  }
}
async function records(r: WorkspaceRepositories, runId: string) {
  const result: StageRecord[] = [];
  for (const stage of WINE_STAGE_ORDER) {
    const value = await r.wineEnrichment.readStage(runId, stage);
    if (value) result.push(value);
  }
  return result;
}
/** Only full/research acceptance exists. copy/section fail closed until adopted dependency wiring. */
async function accepted(
  r: WorkspaceRepositories,
  run: ListingOperation,
): Promise<boolean> {
  try {
    const e = run.execution,
      b = wineBudgetSnapshotSchema.parse(e.wineBudget),
      g = wineExecutionSnapshotSchema.parse(e.wineGo),
      p = wineEnrichmentPolicySchema.parse(e.wineEnrichment),
      a = wineAcquisitionPolicySchema.parse(e.wineAcquisition);
    const input = await r.listingInputs.getRevision(
      run.listingId,
      run.inputRevision,
    );
    const snapshot = e.input as Record<string, unknown>;
    return Boolean(
      e.schemaVersion === 1 &&
      e.flowVersion === "wine-enrichment-v1" &&
      input &&
      snapshot &&
      snapshot.listingId === run.listingId &&
      snapshot.workspaceId === input.workspaceId &&
      snapshot.revision === run.inputRevision &&
      snapshot.inputDigest === input.inputDigest &&
      e.wineInputDigest === input.inputDigest &&
      e.wineSourceDigest === listingInputDigest(input.sources) &&
      listingInputDigest(snapshot.sources) === e.wineSourceDigest &&
      e.wineMode === b.mode &&
      p.enabled &&
      g.rulesVersion === p.rulesVersion &&
      a.rulesVersion === p.rulesVersion &&
      a.policyVersion === p.policyVersion &&
      a.allowedDomains.length > 0 &&
      listingInputDigest([...a.allowedDomains].sort()) ===
        listingInputDigest([...p.allowedDomains].sort()) &&
      Date.parse(a.deadlineAt) > Date.parse(run.acceptedAt) &&
      Date.parse(a.deadlineAt) - Date.parse(run.acceptedAt) <= 900000,
    );
  } catch {
    return false;
  }
}
/** Each method resolves only AFTER its transaction commits. No automatic lease replay exists. */
export function createWineStageStore(
  db: Pick<Database, "forWorkspace">,
  options: Options = {},
): WineStageStore {
  const now = async (r: WorkspaceRepositories) =>
    options.now?.() ?? new Date(await r.pipelineRuns.acceptanceTimestamp());
  async function locked(r: WorkspaceRepositories, job: WineListingJob) {
    await r.pipelineRuns.lockOperation(job.runId);
    const run = await r.pipelineRuns.getOperation(job.runId);
    if (
      !run ||
      run.listingId !== job.draftId ||
      run.inputRevision !== job.inputRevision ||
      run.activeVersionSequence !== job.activeVersionSequence ||
      run.execution.flowVersion !== job.flowVersion
    )
      return null;
    return run;
  }
  async function fence(r: WorkspaceRepositories, run: ListingOperation) {
    if (!["queued", "running"].includes(run.executionState))
      return "operation_terminal";
    const listing = await r.listings.getById(run.listingId),
      current = await r.pipelineRuns.getCurrentOperation(run.listingId);
    if (
      !listing ||
      listing.inputRevision !== run.inputRevision ||
      listing.activeVersionId !== run.baseVersionId ||
      current?.id !== run.id
    )
      return "operation_superseded";
    const deadline = Date.parse(
        (run.execution.wineAcquisition as { deadlineAt: string }).deadlineAt,
      ),
      time = (await now(r)).getTime();
    if (time >= deadline || time < Date.parse(run.acceptedAt))
      return "operation_deadline";
    return null;
  }
  async function stop(
    r: WorkspaceRepositories,
    run: ListingOperation,
    code: string,
  ): Promise<WineDeliveryResult> {
    await r.pipelineRuns.setOperationState(
      run.id,
      code === "operation_superseded" ? "superseded" : "failed",
      code,
    );
    await r.wineEnrichment.settleTerminalBudgets(run.id);
    return { status: "stopped", code };
  }
  async function complete(
    r: WorkspaceRepositories,
    context: WineStageContext,
    result: WineStageResult,
    projected = false,
  ): Promise<WineDeliveryResult> {
    const job = wineListingJobSchema.parse(context.job),
      run = await locked(r, job);
    if (!run) return blocked("operation_envelope_mismatch");
    const all = await records(r, run.id),
      stage = all.find((x) => x.stage === job.stage);
    if (!stage) return blocked("stage_not_claimed");
    if (stage.state !== "started") return { status: "duplicate" };
    const dependencies = all.filter(
      (x) =>
        WINE_STAGE_ORDER.indexOf(x.stage) < WINE_STAGE_ORDER.indexOf(job.stage),
    );
    const digest = wineStageDependencyDigest(run, dependencies);
    if (
      stage.inputDigest !== run.execution.wineInputDigest ||
      stage.dependencyDigest !== digest ||
      context.dependencyDigest !== digest
    )
      return blocked("stage_dependency_mismatch");
    if (result.state === "succeeded" && result.stage === "extraction") {
      const observedAt = result.observedAt;
      const time = Date.parse(observedAt);
      const serverTime = (await now(r)).getTime();
      if (
        time < Date.parse(run.acceptedAt) ||
        time > serverTime ||
        time >=
          Date.parse(
            (run.execution.wineAcquisition as { deadlineAt: string })
              .deadlineAt,
          ) ||
        result.evidence.some((s) => s.capturedAt !== observedAt)
      )
        result = {
          schemaVersion: 1,
          stage: "extraction",
          state: "blocked",
          code: "extraction_observation_time_invalid",
        };
    }
    if (
      result.state === "succeeded" &&
      result.stage === "generation" &&
      result.frozenQuality
    ) {
      const binding = result.frozenQuality.request.binding;
      if (
        binding.workspaceId !== job.workspaceId ||
        binding.operationId !== run.id ||
        binding.inputRevision !== run.inputRevision
      )
        result = {
          schemaVersion: 1,
          stage: "generation",
          state: "blocked",
          code: "generation_binding_mismatch",
        };
    }
    const stale = projected ? null : await fence(r, run);
    // Results survive a revision change, but cannot enqueue or adopt into the current listing.
    const terminal = {
      ...stage,
      state:
        result.state === "succeeded"
          ? ("succeeded" as const)
          : result.state === "unknown"
            ? ("unknown" as const)
            : ("failed" as const),
      output: {
        schemaVersion: 1,
        result,
        fresh: !stale,
        ...(result.state === "succeeded" &&
        result.stage === "verification" &&
        result.needsDeepSearch
          ? {
              deepSearchDecision: {
                schemaVersion: 1,
                required: true,
                reasons: result.deepSearchReasons,
              },
            }
          : {}),
      },
      updatedAt: (await now(r)).toISOString(),
    };
    if (!(await r.wineEnrichment.finishStage(terminal)))
      throw Error("stage completion lost");
    if (stale) return stop(r, run, stale);
    if (result.state !== "succeeded") {
      await stop(r, run, result.code);
      return blocked(result.code);
    }
    if (
      (result.stage === "search_basic" || result.stage === "search_deep") &&
      result.partial
    ) {
      const extraction = dependencies.find((x) => x.stage === "extraction");
      const photo = extraction ? savedResult(extraction) : null;
      if (
        !photo ||
        photo.state !== "succeeded" ||
        photo.stage !== "extraction" ||
        photo.identity.status !== "matched" ||
        !photo.identity.producer ||
        !photo.identity.productName ||
        !photo.identity.volumeMl ||
        !photo.identity.packQuantity
      ) {
        await stop(r, run, "photo_identity_incomplete");
        return blocked("photo_identity_incomplete");
      }
    }
    if (result.stage === "commit_candidate") {
      await r.pipelineRuns.setOperationState(run.id, "succeeded", null, result);
      await r.wineEnrichment.settleTerminalBudgets(run.id);
      return {
        status: "completed",
        versionId: result.versionId,
        outcome: result.outcome,
      };
    }
    let next = WINE_STAGE_ORDER[WINE_STAGE_ORDER.indexOf(job.stage) + 1]!;
    if (result.stage === "verification" && !result.needsDeepSearch) {
      const accumulated = [
        ...dependencies,
        (await r.wineEnrichment.readStage(run.id, job.stage))!,
      ];
      for (const skipped of ["search_deep", "verification_deep"] as const) {
        const record: StageRecord = {
          runId: run.id,
          stage: skipped,
          inputDigest: String(run.execution.wineInputDigest),
          dependencyDigest: wineStageDependencyDigest(run, accumulated),
          state: "skipped",
          output: { schemaVersion: 1, reason: "deep_search_not_required" },
          updatedAt: (await now(r)).toISOString(),
        };
        if (
          !(await r.wineEnrichment.claimStage(record)) ||
          !(await r.wineEnrichment.finishStage(record))
        )
          throw Error("deep skip conflict");
        accumulated.push((await r.wineEnrichment.readStage(run.id, skipped))!);
      }
      next = "generation";
    }
    await r.dispatchOutbox.record([
      {
        listingId: run.listingId,
        dedupeKey: wineStageMessageKey(run.id, next),
        payload: { ...job, stage: next },
      },
    ]);
    return { status: "advanced", nextStage: next };
  }
  return {
    async claim(raw) {
      const job = wineListingJobSchema.parse(raw);
      return db.forWorkspace(job.workspaceId, async (r) => {
        const run = await locked(r, job);
        if (!run) return blocked("operation_envelope_mismatch");
        if (!(await accepted(r, run)))
          return blocked("invalid_accepted_execution");
        if (!["full", "research"].includes(String(run.execution.wineMode)))
          return blocked("evidence_refresh_required");
        const stale = await fence(r, run);
        if (stale) return stop(r, run, stale);
        const all = await records(r, run.id),
          existing = all.find((x) => x.stage === job.stage);
        if (existing) {
          if (existing.state === "started")
            return blocked("stage_outcome_unknown");
          const dependencies = all.filter(
            (x) =>
              WINE_STAGE_ORDER.indexOf(x.stage) <
              WINE_STAGE_ORDER.indexOf(job.stage),
          );
          if (existing.state !== "succeeded") return { status: "duplicate" };
          if (!validDependencies(run, [...dependencies, existing]))
            return blocked("stage_dependency_mismatch");
          const result = savedResult(existing);
          if (result.state !== "succeeded") return { status: "duplicate" };
          const lastFence = await fence(r, run);
          if (lastFence) return stop(r, run, lastFence);
          return {
            status: "duplicate",
            committed: {
              context: {
                schemaVersion: 1,
                job,
                run,
                dependencyDigest: existing.dependencyDigest,
                dependencies,
              },
              result,
            },
          };
        }
        const expected = WINE_STAGE_ORDER.find(
          (stage) =>
            !all.some(
              (x) =>
                x.stage === stage &&
                (x.state === "succeeded" || x.state === "skipped"),
            ),
        );
        if (expected !== job.stage) return blocked("stage_dependency_missing");
        if (job.stage === "commit_candidate" && !options.projectCandidate)
          return blocked("candidate_projection_unavailable");
        const dependencies = all.filter(
          (x) =>
            WINE_STAGE_ORDER.indexOf(x.stage) <
            WINE_STAGE_ORDER.indexOf(job.stage),
        );
        // Validate persisted dependencies before permitting subsequent execution.
        if (!validDependencies(run, dependencies))
          return blocked("stage_dependency_mismatch");
        if (job.stage === "commit_candidate") {
          const q = dependencies.find((x) => x.stage === "quality_check"),
            g = dependencies.find((x) => x.stage === "generation");
          if (!q || !g) return blocked("quality_check_required");
          const quality = savedResult(q),
            generation = savedResult(g);
          if (
            quality.state !== "succeeded" ||
            quality.stage !== "quality_check" ||
            generation.state !== "succeeded" ||
            generation.stage !== "generation" ||
            quality.contentDigest !== listingInputDigest(generation.content)
          )
            return blocked("quality_content_mismatch");
        }
        const lastFence = await fence(r, run);
        if (lastFence) return stop(r, run, lastFence);
        const digest = wineStageDependencyDigest(run, dependencies);
        if (
          !(await r.wineEnrichment.claimStage({
            runId: run.id,
            stage: job.stage,
            inputDigest: String(run.execution.wineInputDigest),
            dependencyDigest: digest,
          }))
        )
          return blocked("stage_outcome_unknown");
        await r.pipelineRuns.setOperationState(run.id, "running");
        return {
          status: "claimed",
          context: {
            schemaVersion: 1,
            job,
            run,
            dependencyDigest: digest,
            dependencies,
          },
        };
      });
    },
    async finish(context, raw) {
      const result = parseWineStageResult(raw, context.job.stage);
      if (result.stage === "commit_candidate")
        throw Error("use transaction-scoped candidate projection");
      return db.forWorkspace(context.job.workspaceId, (r) =>
        complete(r, context, result),
      );
    },
    async commitCandidate(context) {
      if (!options.projectCandidate)
        return blocked("candidate_projection_unavailable");
      return db.forWorkspace(context.job.workspaceId, async (r) => {
        const run = await locked(r, context.job);
        if (!run) return blocked("operation_envelope_mismatch");
        const stale = await fence(r, run);
        if (stale) return stop(r, run, stale);
        if (context.job.stage !== "commit_candidate")
          return blocked("stage_dependency_mismatch");
        const all = await records(r, run.id),
          quality = all.find((x) => x.stage === "quality_check"),
          generation = all.find((x) => x.stage === "generation");
        const claimed = all.find((x) => x.stage === "commit_candidate");
        if (!claimed) return blocked("stage_not_claimed");
        if (claimed.state !== "started") return { status: "duplicate" };
        const dependencies = all.filter((x) => x.stage !== "commit_candidate"),
          digest = wineStageDependencyDigest(run, dependencies);
        if (
          context.dependencyDigest !== digest ||
          claimed.dependencyDigest !== digest ||
          claimed.inputDigest !== run.execution.wineInputDigest
        )
          return blocked("stage_dependency_mismatch");
        if (!quality || !generation) return blocked("quality_check_required");
        const q = savedResult(quality),
          g = savedResult(generation);
        if (
          q.state !== "succeeded" ||
          q.stage !== "quality_check" ||
          g.state !== "succeeded" ||
          g.stage !== "generation" ||
          q.contentDigest !== listingInputDigest(g.content)
        )
          return blocked("quality_content_mismatch");
        const results = all
          .filter((x) => x.state === "succeeded")
          .map(savedResult);
        const latestIdentity = [...results]
          .reverse()
          .find((x) => x.state === "succeeded" && "identity" in x);
        const needsInfo =
          q.outcome === "needs_info" ||
          !latestIdentity ||
          !("identity" in latestIdentity) ||
          latestIdentity.identity.status !== "matched" ||
          results.some(
            (x) =>
              x.state === "succeeded" &&
              "issues" in x &&
              x.issues.some((i) => i.blocking),
          );
        const freshContext = {
          ...context,
          run,
          dependencies: all.filter((x) => x.stage !== "commit_candidate"),
          requiredOutcome: needsInfo
            ? ("needs_info" as const)
            : ("ready" as const),
        };
        const result = parseWineStageResult(
          await options.projectCandidate!(r, freshContext),
          "commit_candidate",
        );
        if (
          result.state !== "succeeded" ||
          result.stage !== "commit_candidate" ||
          (needsInfo && result.outcome !== "needs_info")
        )
          throw Error("projection violates required review outcome");
        return complete(r, context, result, true);
      });
    },
  };
}
