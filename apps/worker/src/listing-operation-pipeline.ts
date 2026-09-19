import {
  evidenceForAutomaticFields,
  listingFactsSchema,
  workingListingSchema,
  mergeWorkingCandidate,
  emptyWorkingListing,
  type WorkingFieldStates,
} from "@wukong/core";
import { PipelineStepBusyError } from "./listing-pipeline.js";
import type { ListingOperation } from "@wukong/db";
import type {
  ListingPipelineInput,
  PipelineDependencies,
  PipelineResult,
  PipelineAttemptOptions,
  PipelineRepositories,
} from "./listing-pipeline.js";

export type PipelineOperationHooks = {
  reusableExtraction?(run: ListingOperation): Promise<unknown | null>;
  retainCandidate?(id: string, candidate: unknown): Promise<void>;
  get(id: string): Promise<ListingOperation | null>;
  matches(run: ListingOperation): Promise<boolean>;
  mark(
    id: string,
    state: "running" | "succeeded" | "failed" | "superseded",
    error?: string | null,
    candidate?: unknown,
  ): Promise<void>;
};
class SupersededOperation extends Error {}
export async function runPersistedListingOperation(
  input: ListingPipelineInput,
  deps: PipelineDependencies,
  options: PipelineAttemptOptions,
  execute: (
    input: ListingPipelineInput,
    deps: PipelineDependencies,
    options: PipelineAttemptOptions,
  ) => Promise<PipelineResult>,
): Promise<PipelineResult> {
  const run = await deps.withWorkspace(input.workspaceId, (repos) =>
    repos.operations!.get(input.runId!),
  );
  if (
    !run ||
    run.execution.flowVersion !== undefined ||
    run.listingId !== input.draftId ||
    run.inputRevision !== input.inputRevision ||
    run.activeVersionSequence !== input.activeVersionSequence
  )
    throw new Error("operation envelope mismatch");
  if (!["queued", "running"].includes(run.executionState)) {
    await deps.settleOperation?.(input.workspaceId, run.id);
    return { status: "needs_info", versionId: null };
  }
  const snapshot = run.execution.input as {
    note: string | null;
    sources: { assetId: string; use: string }[];
    workingContent: unknown;
    fieldStates: WorkingFieldStates;
  };
  const working = workingListingSchema.parse(snapshot.workingContent);
  let candidate: unknown;
  let stale = false;
  let ownedFailure = false;
  const guard = async (repos: PipelineRepositories) => {
    if (!(await repos.operations!.matches(run))) {
      stale = true;
      throw new SupersededOperation();
    }
  };
  let ai: typeof deps.ai;
  const getAI = () =>
    (ai ??= deps.aiForOperation?.(input.workspaceId, run) ?? deps.ai);
  const wrapped: PipelineDependencies = {
    ...deps,
    ai: {
      ...deps.ai,
      async extract(request) {
        const result = await getAI().extract({
          ...request,
          note: snapshot.note,
        });
        candidate = {
          stage: "extract",
          content: { ...emptyWorkingListing(), ...result.facts },
          evidence: result.evidence,
        };
        await deps.withWorkspace(input.workspaceId, async (repos) =>
          repos.operations!.retainCandidate?.(run.id, candidate),
        );
        const merged = mergeWorkingCandidate(working, snapshot.fieldStates, {
          ...emptyWorkingListing(),
          ...result.facts,
        });
        return {
          ...result,
          evidence: evidenceForAutomaticFields(
            snapshot.fieldStates,
            result.evidence,
          ),
          facts: listingFactsSchema.parse({
            ...merged,
            packQuantity: merged.packQuantity ?? 1,
          }),
        };
      },
      async generate(request) {
        const operatorProvidedFields = (
          Object.keys(listingFactsSchema.shape) as Array<
            keyof import("@wukong/core").ListingFacts
          >
        ).filter(
          (field) =>
            snapshot.fieldStates[field]?.owner === "operator" ||
            snapshot.fieldStates[field]?.locked,
        );
        const result = await getAI().generate({
          ...request,
          operatorProvidedFields,
        });
        const merged = mergeWorkingCandidate(
          working,
          snapshot.fieldStates,
          result.listing,
        );
        candidate = { content: result.listing, evidence: request.evidence };
        await deps.withWorkspace(input.workspaceId, async (repos) =>
          repos.operations!.retainCandidate?.(run.id, candidate),
        );
        return {
          ...result,
          listing: {
            ...merged,
            packQuantity: merged.packQuantity ?? result.listing.packQuantity,
          },
        };
      },
    },
    async withWorkspace(workspaceId, work) {
      return deps.withWorkspace(workspaceId, async (repos) =>
        work({
          ...repos,
          listings: {
            ...repos.listings,
            async requireById(id) {
              const value = await repos.listings.requireById(id);
              return { ...value, note: snapshot.note };
            },
            async startProcessing(...args) {
              await guard(repos);
              return repos.listings.startProcessing(...args);
            },
            async appendVersion(...args) {
              await guard(repos);
              return repos.listings.appendVersion(...args);
            },
            async complete(...args) {
              await guard(repos);
              if (run.baseVersionId && args[1].versionId === null)
                args[1] = { ...args[1], versionId: run.baseVersionId };
              return repos.listings.complete(...args);
            },
            async fail(...args) {
              if (
                stale ||
                (!ownedFailure && !(await repos.operations!.matches(run)))
              )
                return;
              return repos.listings.fail(...args);
            },
          },
          pipelineRuns: {
            ...repos.pipelineRuns,
            async claimStep(args) {
              const claim = await repos.pipelineRuns.claimStep(args);
              if (
                args.step === "extracted" &&
                claim.claimed &&
                claim.leaseToken
              ) {
                const cached =
                  await repos.operations!.reusableExtraction?.(run);
                if (cached) {
                  const cachedFacts = listingFactsSchema.safeParse(
                    (cached as { facts?: unknown }).facts,
                  );
                  if (cachedFacts.success) {
                    candidate = {
                      stage: "extract",
                      content: {
                        ...emptyWorkingListing(),
                        ...cachedFacts.data,
                      },
                      evidence:
                        (cached as { evidence?: unknown }).evidence ?? [],
                    };
                    await repos.operations!.retainCandidate?.(
                      run.id,
                      candidate,
                    );
                  }
                  await repos.pipelineRuns.recordStep({
                    ...args,
                    leaseToken: claim.leaseToken,
                    output: cached,
                  });
                  await repos.audit.write({
                    workspaceId: input.workspaceId,
                    actorId: "worker:listing-pipeline",
                    entityId: input.draftId,
                    action: "listing.extraction_reused",
                    metadata: { runId: run.id, parentRunId: run.retryOfRunId },
                  });
                  return {
                    ...claim,
                    claimed: false,
                    completed: true,
                    output: cached,
                  };
                }
              }
              return claim;
            },
            async complete(args) {
              await repos.pipelineRuns.complete(args);
              await repos.operations!.mark(run.id, "succeeded");
            },
            async fail(args) {
              if (stale || !(await repos.operations!.matches(run)))
                return false;
              const failed = await repos.pipelineRuns.fail(args);
              if (failed) {
                ownedFailure = true;
                await repos.operations!.mark(run.id, "failed", args.errorCode);
              }
              return failed;
            },
          },
          workspaces: run.execution.profile
            ? {
                requireProfile: async () =>
                  run.execution
                    .profile as import("@wukong/core").WorkspaceProfile,
              }
            : repos.workspaces,
          aiRuns:
            run.execution.provider === "fake"
              ? repos.aiRuns
              : { append: async () => {} },
          sourceAssets: {
            ...repos.sourceAssets,
            async listForListing(id) {
              const assets = await repos.sourceAssets.listForListing(id);
              return snapshot.sources
                .filter((source) => source.use === "analyse")
                .map((source) => {
                  const asset = assets.find(
                    (asset) => asset.id === source.assetId,
                  );
                  if (!asset) throw new Error("operation source unavailable");
                  return asset;
                });
            },
          },
        }),
      );
    },
  };
  try {
    await deps.withWorkspace(input.workspaceId, async (repos) => {
      await guard(repos);
      await repos.operations!.mark(run.id, "running");
    });
    const result = await execute(input, wrapped, {
      ...options,
      isTerminalError: (error) => !(error instanceof PipelineStepBusyError),
    });
    await deps.withWorkspace(input.workspaceId, (repos) =>
      repos.operations!.mark(run.id, "succeeded", null, candidate),
    );
    await deps.settleOperation?.(input.workspaceId, run.id);
    return result;
  } catch (error) {
    const stored = await deps.withWorkspace(input.workspaceId, (repos) =>
      repos.operations!.get(run.id),
    );
    if (
      stale ||
      stored?.executionState === "superseded" ||
      error instanceof SupersededOperation
    ) {
      await deps.withWorkspace(input.workspaceId, (repos) =>
        repos.operations!.mark(
          run.id,
          "superseded",
          "input_superseded",
          candidate,
        ),
      );
      await deps.settleOperation?.(input.workspaceId, run.id);
      return { status: "needs_info", versionId: null };
    }
    const terminal = !(error instanceof PipelineStepBusyError);
    if (terminal)
      await deps.withWorkspace(input.workspaceId, (repos) =>
        repos.operations!.mark(run.id, "failed", "pipeline_failure", candidate),
      );
    if (terminal) await deps.settleOperation?.(input.workspaceId, run.id);
    throw error;
  }
}
