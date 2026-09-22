import {
  listingInputDigest,
  authorizeWineVerifiedEvidence,
  type Database,
  type WorkspaceRepositories,
  wineStageOrder,
  readWineCopyDependencies,
  buildWineGenerationRequest,
  wineStageDependencyDigest,
} from "@wukong/db";
import {
  wineGenerationRequestSchema,
  wineGenerationCandidateSchema,
  validateWineGenerationRequest,
  wineCandidateIssues,
  type WineGenerationRequest,
} from "@wukong/core";
import {
  savedResult,
  validDependencies,
  accepted,
} from "./wine-stage-authority.js";
import { readWineGenerationOwnershipFromRepositories } from "./wine-generation-ownership.js";
import type {
  WineStageContext,
  WineStageResult,
} from "./wine-enrichment-pipeline.js";
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
export class WineGenerationFenceError extends Error {}
function requireGeneration(value: unknown, code: string): asserts value {
  if (!value) throw new WineGenerationFenceError(code);
}
/** Called within an owned transaction, never HTTP. The registry lock survives through caller COMMIT. */
export async function readWineGenerationRequestFromRepositories(
  r: WorkspaceRepositories,
  c: WineStageContext,
) {
  requireGeneration(
    ["generation", "quality_check", "commit_candidate"].includes(c.job.stage),
    "generation_stage_invalid",
  );
  const own = await readWineGenerationOwnershipFromRepositories(r, c);
  requireGeneration(
    own.status === "available",
    "generation_ownership_unavailable",
  );
  requireGeneration(await accepted(r, c.run), "generation_execution_invalid");
  const order = wineStageOrder(c.run.execution.wineMode);
  const prefix = [];
  for (const name of order.slice(0, order.indexOf(c.job.stage))) {
    const row = await r.wineEnrichment.readStage(c.run.id, name);
    requireGeneration(row, "generation_dependency_missing");
    prefix.push(row);
  }
  requireGeneration(
    validDependencies(c.run, prefix) &&
      same(prefix, c.dependencies) &&
      c.dependencyDigest === wineStageDependencyDigest(c.run, prefix),
    "generation_dependency_invalid",
  );
  const stage = await r.wineEnrichment.readStage(c.run.id, c.job.stage);
  requireGeneration(
    stage?.state === "started" &&
      stage.inputDigest === c.run.execution.wineInputDigest &&
      stage.dependencyDigest === c.dependencyDigest,
    "generation_checkpoint_invalid",
  );
  if (
    c.run.execution.wineMode === "copy" ||
    c.run.execution.wineMode === "section"
  ) {
    const copy = await readWineCopyDependencies(r, c.run, own);
    const request = buildWineGenerationRequest(
      c.run,
      own,
      copy.claims,
      copy.snapshot.section,
    );
    requireGeneration(
      Date.parse(await r.pipelineRuns.acceptanceTimestamp()) <
        Date.parse(
          (c.run.execution.wineAcquisition as { deadlineAt: string })
            .deadlineAt,
        ),
      "generation_deadline",
    );
    return {
      request,
      ownership: own,
      identity: copy.identity,
      input: copy.input,
    };
  }
  const row =
    prefix.find(
      (x) => x.stage === "verification_deep" && x.state === "succeeded",
    ) ?? prefix.find((x) => x.stage === "verification");
  requireGeneration(row, "generation_verification_required");
  const verified = savedResult(row);
  requireGeneration(
    verified.state === "succeeded" &&
      (verified.stage === "verification" ||
        verified.stage === "verification_deep") &&
      verified.frozenVerification,
    "generation_verification_required",
  );
  const frozen = verified.frozenVerification;
  requireGeneration(
    same(frozen.identity, verified.identity),
    "generation_identity_mismatch",
  );
  const input = await r.listingInputs.getRevision(
    c.run.listingId,
    c.run.inputRevision,
  );
  requireGeneration(input, "generation_input_missing");
  requireGeneration(
    same(
      [...frozen.lockedFields].sort(),
      Object.entries(input.fieldStates)
        .filter(([, s]) => s?.owner === "operator" || s?.locked)
        .map(([key]) => key)
        .sort(),
    ),
    "generation_locks_mismatch",
  );
  await r.wineEnrichment.lockAuthorities();
  const now = await r.pipelineRuns.acceptanceTimestamp();
  const claims = verified.claims.filter((x) => x.state === "accepted");
  await authorizeWineVerifiedEvidence(r, {
    workspaceId: c.job.workspaceId,
    run: c.run,
    input,
    frozen,
    claims,
    now,
  });
  const profile = c.run.execution.profile as
    { tone?: unknown; claimPolicy?: unknown } | undefined;
  requireGeneration(profile, "generation_profile_required");
  const request = wineGenerationRequestSchema.parse({
    schemaVersion: 1,
    binding: frozen.binding,
    claims,
    current: own.prior.current,
    ownership: {
      schemaVersion: 1,
      priorKind: own.prior.kind,
      metadata: own.prior.metadata,
      legacyDescription:
        own.prior.kind === "legacy" ? own.prior.description : null,
      lockedPaths: own.lockedPaths,
      provenanceDigest: own.provenanceDigest,
    },
    lockedPaths: own.lockedPaths,
    tone: profile.tone,
    claimPolicy: profile.claimPolicy,
    section: null,
  });
  validateWineGenerationRequest(request);
  requireGeneration(
    Date.parse(await r.pipelineRuns.acceptanceTimestamp()) <
      Date.parse(
        (c.run.execution.wineAcquisition as { deadlineAt: string }).deadlineAt,
      ),
    "generation_deadline",
  );
  return { request, ownership: own, identity: verified.identity, input };
}
export async function readWineGenerationRequest(
  database: Pick<Database, "forWorkspace">,
  c: WineStageContext,
) {
  return database.forWorkspace(c.job.workspaceId, (r) =>
    readWineGenerationRequestFromRepositories(r, c),
  );
}
/** Never invent missing annotations or replace the persisted request with a newly generated one. */
export function authorizeWineFrozenQuality(
  result: WineStageResult,
  request: WineGenerationRequest,
) {
  requireGeneration(
    result.state === "succeeded" &&
      result.stage === "generation" &&
      result.frozenQuality,
    "generation_frozen_quality_required",
  );
  const frozen = result.frozenQuality;
  const saved = wineGenerationRequestSchema.parse(frozen.request),
    candidate = wineGenerationCandidateSchema.parse(frozen.candidate);
  requireGeneration(
    same(saved, request) && same(candidate.content, result.content),
    "generation_frozen_quality_mismatch",
  );
  requireGeneration(
    wineCandidateIssues(saved, candidate).length === 0,
    "generation_candidate_invalid",
  );
  return { request: saved, candidate };
}
export function committedGeneration(c: WineStageContext) {
  const row = c.dependencies.find((x) => x.stage === "generation");
  requireGeneration(row, "generation_frozen_quality_required");
  return savedResult(row);
}
