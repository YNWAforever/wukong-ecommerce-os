import {
  projectWineContent,
  selectWineProposal,
  selectedWinePath,
  wineSectionContent,
  wineAdoptionRequestDigest,
} from "./wine-proposal.js";
import {
  authorizeWineVerifiedEvidence,
  WineEvidenceAuthorizationError,
} from "./wine-verified-evidence.js";
import {
  type ReviewableListing,
  wineCopySnapshotSchema,
  renderWineDescription,
  wineBudgetSnapshotSchema,
  wineEnrichmentPolicySchema,
  wineExecutionSnapshotSchema,
  wineGenerationRequestSchema,
  wineGenerationCandidateSchema,
  validateWineGenerationRequest,
  wineCandidateIssues,
  workingListingSchema,
  workingFieldStateSchema,
  workingFields,
  workingBaselineForReview,
  hasWineSectionMapping,
  wineTextPaths,
  type WineContent,
  type SupportedClaim,
  type EvidenceSource,
  type WineFrozenContext,
} from "@wukong/core";
import { wineAcquisitionPolicySchema } from "@wukong/jobs";
import type { WorkspaceRepositories } from "./client.js";
import { listingInputDigest } from "./repositories/listing-inputs.js";
import type { ListingInputSnapshot } from "./repositories/listing-inputs.js";
import type { ListingOperation } from "./repositories/listing-operations.js";
import type {
  WineVersionOrigin,
  StageRecord,
} from "./repositories/wine-enrichment.js";
import {
  WINE_STAGE_ORDER,
  wineStageOrder,
  parseWineStageResult,
  type WineStageResult,
} from "./wine-stage-artifacts.js";
import { wineStageDependencyDigest } from "./wine-stage-dependencies.js";
import {
  buildWineCopySnapshot,
  wineCopyDependencyDigest,
} from "./wine-copy-snapshot.js";
import { buildWineGenerationRequest } from "./wine-generation-request.js";
import { resolveWineGenerationOwnership } from "./wine-generation-ownership.js";

export type AdoptedWineCoordinates = {
  workspaceId: string;
  listingId: string;
  versionId: string;
  inputRevision: number;
};
export type WineCopySupport = {
  path: string;
  claimId: string;
  claim: SupportedClaim;
  evidenceIds: string[];
  premiseClaimIds: string[];
  text: string;
  span: string;
  originRunId: string;
  originVersionId: string;
  originInputRevision: number;
  sources: EvidenceSource[];
  valid: boolean;
  invalidReason:
    | null
    | "source_changed"
    | "identity_changed"
    | "copy_changed"
    | "ancestry_unavailable";
};
export type ValidatedWineOrigin = {
  workspaceId: string;
  listingId: string;
  versionId: string;
  runId: string;
  inputRevision: number;
  baseVersionId: string | null;
  inputDigest: string;
  sourceDigest: string;
  acceptedAt: string;
  mode: "full" | "research";
  modelPolicy: ReturnType<typeof wineExecutionSnapshotSchema.parse>;
  policy: ReturnType<typeof wineEnrichmentPolicySchema.parse>;
  frozenVerification: WineFrozenContext;
  claims: SupportedClaim[];
};
export type AdoptedWineDependencies =
  | { status: "unavailable"; code: string }
  | {
      status: "available";
      schemaVersion: 1;
      versionId: string;
      originRunId: string;
      inputRevision: number;
      outcome: "complete" | "needs_info";
      current: WineContent | null;
      adopted: WineContent;
      origins: ValidatedWineOrigin[];
      supports: WineCopySupport[];
      unavailableSections: {
        path: string;
        claimIds: string[];
        reason: string;
      }[];
      refreshRequired: boolean;
      provenanceDigest: string;
    };
class AdoptedError extends Error {}
function requireAdopted(value: unknown, code: string): asserts value {
  if (!value) throw new AdoptedError(code);
}
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
type Succeeded = Extract<WineStageResult, { state: "succeeded" }>;
function saved(row: StageRecord): Succeeded {
  const output = row.output as {
    schemaVersion?: number;
    fresh?: boolean;
    result?: unknown;
  };
  requireAdopted(
    row.state === "succeeded" &&
      output?.schemaVersion === 1 &&
      output.fresh === true,
    "adopted_stage_unavailable",
  );
  const result = parseWineStageResult(output.result, row.stage);
  requireAdopted(result.state === "succeeded", "adopted_stage_unavailable");
  return result;
}
async function chain(r: WorkspaceRepositories, run: ListingOperation) {
  const prefix: StageRecord[] = [];
  const results = new Map<string, Succeeded>();
  const order = wineStageOrder(run.execution.wineMode);
  for (const stage of WINE_STAGE_ORDER.filter((s) => !order.includes(s)))
    requireAdopted(
      !(await r.wineEnrichment.readStage(run.id, stage)),
      "adopted_stage_binding_invalid",
    );
  for (const stage of order) {
    const row = await r.wineEnrichment.readStage(run.id, stage);
    requireAdopted(
      row &&
        row.runId === run.id &&
        row.inputDigest === run.execution.wineInputDigest &&
        row.dependencyDigest === wineStageDependencyDigest(run, prefix),
      "adopted_stage_binding_invalid",
    );
    if (row.state === "skipped") {
      const v = results.get("verification"),
        o = row.output as { schemaVersion?: number; reason?: string };
      requireAdopted(
        ["search_deep", "verification_deep"].includes(stage) &&
          v?.stage === "verification" &&
          !v.needsDeepSearch &&
          o?.schemaVersion === 1 &&
          o.reason === "deep_search_not_required",
        "adopted_stage_unavailable",
      );
    } else results.set(stage, saved(row));
    prefix.push(row);
  }
  return results;
}
function inputMatches(
  input: ListingInputSnapshot,
  run: ListingOperation,
  workspaceId: string,
) {
  const e = run.execution,
    s = e.input as Record<string, unknown>;
  requireAdopted(
    input.workspaceId === workspaceId &&
      input.listingId === run.listingId &&
      input.revision === run.inputRevision &&
      s &&
      s.workspaceId === workspaceId &&
      s.listingId === run.listingId &&
      s.revision === input.revision &&
      s.inputDigest === input.inputDigest &&
      e.wineInputDigest === input.inputDigest &&
      e.wineSourceDigest === listingInputDigest(input.sources),
    "adopted_input_invalid",
  );
  for (const key of [
    "workingContent",
    "fieldStates",
    "sources",
    "note",
  ] as const)
    requireAdopted(same(input[key], s[key]), "adopted_input_invalid");
  requireAdopted(
    input.inputDigest ===
      listingInputDigest({
        note: input.note,
        sources: input.sources,
        workingContent: input.workingContent,
        fieldStates: input.fieldStates,
      }),
    "adopted_input_invalid",
  );
  for (const [key, state] of Object.entries(input.fieldStates)) {
    requireAdopted(
      workingFields.includes(key as never),
      "adopted_input_invalid",
    );
    workingFieldStateSchema.parse(state);
  }
}
type ValidOrigin = {
  identityAnchor?: ReviewableListing;
  row: WineVersionOrigin;
  run: ListingOperation;
  input: ListingInputSnapshot;
  frozen: WineFrozenContext | null;
  claimOrigins?: Map<string, ValidOrigin>;
  originalContexts?: ValidOrigin[];
  claims: SupportedClaim[];
  candidate: ReturnType<typeof wineGenerationCandidateSchema.parse>;
  outcome: "complete" | "needs_info";
};
async function validateOrigin(
  graph: WineOriginGraph,
  versionId: string,
): Promise<ValidOrigin> {
  const { r, scope: c } = graph;
  const row = await r.wineEnrichment.readVersionOrigin(c.listingId, versionId);
  requireAdopted(
    row?.runId && row.sections && row.workspaceId === c.workspaceId,
    "adopted_origin_unavailable",
  );
  const run = await r.pipelineRuns.getOperation(row.runId);
  requireAdopted(
    run && run.listingId === c.listingId && run.executionState === "succeeded",
    "adopted_origin_invalid",
  );
  if (row.adoption) return validateProposalOrigin(graph, row, run);
  requireAdopted(
    row.pipelineIdempotencyKey === run.idempotencyKey,
    "adopted_origin_invalid",
  );
  const source = await authorizeTerminalSource(graph, run);
  const {
    input,
    commit,
    candidate,
    claims,
    frozen,
    ownership: own,
    base,
  } = source;
  // This old complete lineage NEVER authorizes a proposed result or adoption proof.
  requireAdopted(
    commit.outcome !== "proposed" && commit.versionId === versionId,
    "adopted_artifact_missing",
  );
  requireAdopted(
    (!run.baseVersionId || (base && base.sequence < row.sequence)) &&
      run.activeVersionSequence === (base?.sequence ?? 0),
    "adopted_base_invalid",
  );
  if (source.copy) {
    requireAdopted(
      same(row.sections, candidate.content) &&
        same(
          {
            title: row.content.title,
            seo: row.content.seo,
            tags: row.content.tags,
            sections: row.content.wineOwnership?.sections ?? [],
          },
          row.sections,
        ) &&
        hasWineSectionMapping(row.content),
      "adopted_content_invalid",
    );
    requireAdopted(base, "adopted_base_invalid");
    const baseline = workingBaselineForReview(
      workingListingSchema.parse(input.workingContent),
      input.fieldStates,
      base.content,
    ).workingContent;
    requireAdopted(
      same(row.content, {
        ...baseline,
        title: candidate.content.title,
        seo: candidate.content.seo,
        tags: candidate.content.tags,
        description: {
          en: renderWineDescription(candidate.content, "en"),
          "zh-Hant": renderWineDescription(candidate.content, "zh-Hant"),
        },
        wineOwnership: {
          schemaVersion: 1,
          sections: candidate.content.sections,
        },
      }),
      "adopted_content_invalid",
    );
    requireAdopted(source.prior, "adopted_original_required");
    const originalContexts: ValidOrigin[] = [];
    for (const context of source.prior.origins) {
      const original = await graph.visit(context.versionId);
      requireAdopted(
        original.frozen && original.run.id === context.runId,
        "adopted_original_required",
      );
      originalContexts.push(original);
    }
    const claimOrigins = new Map<string, ValidOrigin>();
    for (const pointer of source.copy.claims) {
      const original = originalContexts.find(
        (o) =>
          o.run.id === pointer.originRunId &&
          o.row.versionId === pointer.originVersionId,
      );
      requireAdopted(
        original &&
          original.claims.some(
            (cl) =>
              cl.id === pointer.claimId &&
              listingInputDigest(cl) === pointer.claimDigest,
          ),
        "adopted_claim_invalid",
      );
      claimOrigins.set(pointer.claimId, original);
    }
    return {
      row,
      run,
      input,
      frozen: null,
      claims,
      candidate,
      outcome: commit.outcome,
      claimOrigins,
      originalContexts,
    };
  }
  const adopted = {
    title: row.content.title,
    seo: row.content.seo,
    tags: row.content.tags,
    sections: row.content.wineOwnership?.sections ?? [],
  };
  requireAdopted(
    same(adopted, row.sections) &&
      same(row.sections, {
        ...candidate.content,
        sections: own.prior.kind === "legacy" ? [] : candidate.content.sections,
      }) &&
      (!row.content.wineOwnership || hasWineSectionMapping(row.content)) &&
      (own.prior.kind !== "legacy" ||
        same(row.content.description, own.prior.description)),
    "adopted_content_invalid",
  );
  return {
    row,
    run,
    input,
    frozen,
    claims,
    candidate,
    outcome: commit.outcome,
  };
}
/** Private nominal graph. No exported function accepts a dependency callback or graph. */
class WineOriginGraph {
  private readonly cache = new Map<string, ValidOrigin>();
  private readonly active = new Set<string>();
  constructor(
    readonly r: WorkspaceRepositories,
    readonly scope: Pick<AdoptedWineCoordinates, "workspaceId" | "listingId">,
    readonly now: string,
  ) {}
  async visit(id: string): Promise<ValidOrigin> {
    requireAdopted(!this.active.has(id), "ancestry_cycle");
    requireAdopted(this.active.size < 17, "ancestry_depth");
    if (this.cache.has(id)) return this.cache.get(id)!;
    requireAdopted(this.cache.size + this.active.size < 17, "ancestry_depth");
    this.active.add(id);
    try {
      const value = await validateOrigin(this, id);
      this.cache.set(id, value);
      return value;
    } finally {
      this.active.delete(id);
    }
  }
  dependencies(
    versionId: string,
    input: ListingInputSnapshot,
  ): Promise<Extract<AdoptedWineDependencies, { status: "available" }>> {
    return assembleDependencies(
      this.r,
      { ...this.scope, versionId, inputRevision: input.revision },
      input,
      this.now,
      (id) => this.visit(id),
    );
  }
}

const identityFields = [
  "producer",
  "productType",
  "country",
  "region",
  "vintage",
  "volumeMl",
  "packQuantity",
  "abvPercent",
  "title",
] as const;
function sourceChanged(
  source: EvidenceSource,
  original: ListingInputSnapshot,
  current: ListingInputSnapshot,
) {
  if (source.kind === "merchant") return !same(original.note, current.note);
  if (source.kind === "web") return false;
  const originalAsset = original.sources.find(
      (s) => s.assetId === source.assetId,
    ),
    currentAsset = current.sources.find((s) => s.assetId === source.assetId);
  // Hero/order are presentation choices. Role, analysis selection and immutable asset digest affect evidence.
  return (
    !originalAsset ||
    !currentAsset ||
    originalAsset.digest !== currentAsset.digest ||
    originalAsset.role !== currentAsset.role ||
    originalAsset.use !== currentAsset.use
  );
}
function dependencySources(
  origin: ValidOrigin,
  claim: SupportedClaim,
  seen = new Set<string>(),
): EvidenceSource[] {
  requireAdopted(!seen.has(claim.id), "adopted_claim_cycle");
  const next = new Set(seen).add(claim.id);
  const ids = new Set(claim.evidenceIds);
  for (const id of claim.premiseClaimIds) {
    const premise = origin.claims.find((c) => c.id === id);
    requireAdopted(premise, "adopted_claim_invalid");
    for (const source of dependencySources(origin, premise, next))
      ids.add(source.id);
  }
  requireAdopted(origin.frozen, "adopted_original_required");
  const sources = origin.frozen.sources.filter((s) => ids.has(s.id));
  requireAdopted(sources.length === ids.size, "adopted_claim_invalid");
  return sources;
}
async function assembleDependencies(
  r: WorkspaceRepositories,
  c: AdoptedWineCoordinates,
  currentInput: ListingInputSnapshot,
  now: string,
  visit: (id: string) => Promise<ValidOrigin>,
): Promise<Extract<AdoptedWineDependencies, { status: "available" }>> {
  const origin = await visit(c.versionId);
  const resolved = workingBaselineForReview(
    workingListingSchema.parse(currentInput.workingContent),
    currentInput.fieldStates,
    origin.row.content,
  ).workingContent;
  const current: WineContent | null =
    resolved.wineOwnership && hasWineSectionMapping(resolved)
      ? {
          title: resolved.title,
          seo: resolved.seo,
          tags: resolved.tags,
          sections: resolved.wineOwnership.sections,
        }
      : null;
  const currentPaths = wineTextPaths(
    current ?? {
      title: resolved.title,
      seo: resolved.seo,
      tags: resolved.tags,
      sections: [],
    },
  );
  const supports: WineCopySupport[] = [];
  const unavailableSections: {
    path: string;
    claimIds: string[];
    reason: string;
  }[] = [];
  const origins = new Map<string, ValidOrigin>([
    [origin.row.versionId, origin],
  ]);
  for (const original of origin.originalContexts ?? [])
    origins.set(original.row.versionId, original);
  const participating = new Set<string>();
  const adoptedPaths = wineTextPaths(origin.row.sections!);
  const add = (from: ValidOrigin, path: string, text: string) => {
    const sectionKey = path.startsWith("sections.") ? path.split(".")[1] : null;
    const section = sectionKey
      ? origin.row.sections!.sections.find((s) => s.key === sectionKey)
      : null;
    let count = 0;
    for (const annotation of from.candidate.annotations.filter(
      (a) => a.path === path,
    )) {
      const claim = from.claims.find((x) => x.id === annotation.claimId);
      if (
        !claim ||
        !text.includes(annotation.span) ||
        (section && !section.claimIds.includes(claim.id))
      )
        continue;
      const original = from.claimOrigins?.get(claim.id) ?? from;
      requireAdopted(original.frozen, "adopted_original_required");
      origins.set(original.row.versionId, original);
      participating.add(original.row.versionId);
      const sources = dependencySources(original, claim);
      // Current validated copy can retitle retained prose; later research can inherit
      // a supplying validated copy's title. Neither grants factual-coordinate authority.
      const titleAnchor = origin.claimOrigins
        ? origin.row.content.title
        : from.claimOrigins
          ? from.row.content.title
          : original.row.content.title;
      const identityChanged =
        claim.scope === "product" &&
        identityFields.some(
          (k) =>
            !same(
              resolved[k],
              k === "title"
                ? titleAnchor
                : (original.identityAnchor ?? original.row.content)[k],
            ),
        );
      const invalidReason = identityChanged
        ? "identity_changed"
        : sources.some((s) => sourceChanged(s, original.input, currentInput))
          ? "source_changed"
          : currentPaths.get(path) !== text
            ? "copy_changed"
            : null;
      supports.push({
        path,
        claimId: claim.id,
        claim,
        evidenceIds: claim.evidenceIds,
        premiseClaimIds: claim.premiseClaimIds,
        text,
        span: annotation.span,
        originRunId: original.run.id,
        originVersionId: original.row.versionId,
        originInputRevision: original.input.revision,
        sources,
        valid: invalidReason === null,
        invalidReason,
      });
      count++;
    }
    return count;
  };
  for (const [path, text] of adoptedPaths) {
    if (!text.trim()) continue;
    if (add(origin, path, text)) continue;
    let cursor = origin;
    const seen = new Set<string>([origin.row.versionId]);
    let found = false,
      reason = "ancestry_unavailable";
    const sectionKey = path.startsWith("sections.") ? path.split(".")[1] : null;
    const section = sectionKey
      ? origin.row.sections!.sections.find((s) => s.key === sectionKey)
      : null;
    for (let depth = 0; depth < 16 && cursor.run.baseVersionId; depth++) {
      const id = cursor.run.baseVersionId;
      if (seen.has(id)) {
        reason = "ancestry_cycle";
        break;
      }
      seen.add(id);
      try {
        const prior = origins.get(id) ?? (await visit(id));
        origins.set(id, prior);
        requireAdopted(
          prior.row.sequence < cursor.row.sequence,
          "ancestry_cycle",
        );
        const priorSection = sectionKey
          ? prior.row.sections!.sections.find((s) => s.key === sectionKey)
          : null;
        if (
          wineTextPaths(prior.row.sections!).get(path) !== text ||
          (section && !same(section.claimIds, priorSection?.claimIds))
        )
          break;
        if (add(prior, path, text)) {
          found = true;
          break;
        }
        cursor = prior;
      } catch (error) {
        reason =
          error instanceof AdoptedError ||
          error instanceof WineEvidenceAuthorizationError
            ? error.message
            : "ancestry_unavailable";
        break;
      }
    }
    if (!found)
      unavailableSections.push({
        path,
        claimIds: section?.claimIds ?? [],
        reason,
      });
  }
  const verifiedOrigins: ValidatedWineOrigin[] = [...origins.values()]
    .filter(
      (o) =>
        o.frozen !== null &&
        (!origin.row.adoption || participating.has(o.row.versionId)),
    )
    .map((o) => ({
      workspaceId: c.workspaceId,
      listingId: c.listingId,
      versionId: o.row.versionId,
      runId: o.run.id,
      inputRevision: o.input.revision,
      baseVersionId: o.run.baseVersionId,
      inputDigest: o.input.inputDigest,
      sourceDigest: String(o.run.execution.wineSourceDigest),
      acceptedAt: o.run.acceptedAt,
      mode: o.run.execution.wineMode as "full" | "research",
      modelPolicy: wineExecutionSnapshotSchema.parse(o.run.execution.wineGo),
      policy: wineEnrichmentPolicySchema.parse(o.run.execution.wineEnrichment),
      frozenVerification: o.frozen!,
      claims: o.claims,
    }));
  if (origin.row.adoption) {
    const ids = new Map<string, string>();
    for (const original of verifiedOrigins)
      for (const claim of original.claims) {
        const previous = ids.get(claim.id);
        requireAdopted(
          !previous || previous === original.runId,
          "proposal_claim_origin_collision",
        );
        ids.set(claim.id, original.runId);
      }
  }
  return {
    status: "available",
    schemaVersion: 1,
    versionId: c.versionId,
    originRunId: origin.run.id,
    inputRevision: c.inputRevision,
    outcome: origin.outcome,
    current,
    adopted: origin.row.sections!,
    origins: verifiedOrigins,
    supports,
    unavailableSections,
    refreshRequired:
      origin.outcome === "needs_info" ||
      unavailableSections.length > 0 ||
      supports.some((x) => !x.valid),
    provenanceDigest: listingInputDigest({
      coordinates: c,
      originRunId: origin.run.id,
      now,
      origins: verifiedOrigins,
      supports,
      unavailableSections,
    }),
  };
}
/** Active/current authorization remains separate from historical base traversal. */
export async function readAdoptedWineDependencies(
  r: WorkspaceRepositories,
  c: AdoptedWineCoordinates,
): Promise<AdoptedWineDependencies> {
  try {
    await r.listings.lockReviewState(c.listingId);
    const listing = await r.listings.getById(c.listingId),
      currentInput = await r.listingInputs.getCurrent(c.listingId);
    requireAdopted(
      listing &&
        listing.workspaceId === c.workspaceId &&
        listing.activeVersionId === c.versionId &&
        listing.inputRevision === c.inputRevision &&
        currentInput?.revision === c.inputRevision,
      "adopted_current_changed",
    );
    await r.wineEnrichment.lockAuthorities();
    const now = await r.pipelineRuns.acceptanceTimestamp();
    const graph = new WineOriginGraph(r, c, now);
    return await graph.dependencies(c.versionId, currentInput);
  } catch (error) {
    return {
      status: "unavailable",
      code:
        error instanceof AdoptedError ||
        error instanceof WineEvidenceAuthorizationError
          ? error.message
          : "adopted_evidence_unavailable",
    };
  }
}

async function authorizeTerminalSource(
  graph: WineOriginGraph,
  run: ListingOperation,
) {
  const { r, scope: c, now } = graph;
  requireAdopted(
    run && run.listingId === c.listingId && run.executionState === "succeeded",
    "adopted_origin_invalid",
  );
  const input = await r.listingInputs.getRevision(
    c.listingId,
    run.inputRevision,
  );
  requireAdopted(input, "adopted_input_invalid");
  inputMatches(input, run, c.workspaceId);
  const e = run.execution,
    b = wineBudgetSnapshotSchema.parse(e.wineBudget),
    p = wineEnrichmentPolicySchema.parse(e.wineEnrichment),
    g = wineExecutionSnapshotSchema.parse(e.wineGo),
    a = wineAcquisitionPolicySchema.parse(e.wineAcquisition);
  const accepted = Date.parse(run.acceptedAt),
    deadline = Date.parse(a.deadlineAt),
    time = Date.parse(now);
  requireAdopted(
    e.schemaVersion === 1 &&
      e.flowVersion === "wine-enrichment-v1" &&
      ["full", "research", "copy", "section"].includes(String(e.wineMode)) &&
      e.wineMode === b.mode &&
      p.enabled &&
      g.rulesVersion === p.rulesVersion &&
      a.rulesVersion === p.rulesVersion &&
      a.policyVersion === p.policyVersion &&
      (!["full", "research"].includes(String(e.wineMode)) ||
        a.allowedDomains.length > 0) &&
      same([...a.allowedDomains].sort(), [...p.allowedDomains].sort()) &&
      deadline > accepted &&
      deadline - accepted <= 900000 &&
      time >= accepted,
    "adopted_policy_invalid",
  );
  if (e.wineMode === "copy" || e.wineMode === "section")
    return authorizeCopySource(graph, run, input);
  const stages = await chain(r, run),
    v = stages.get("verification_deep") ?? stages.get("verification"),
    gen = stages.get("generation"),
    q = stages.get("quality_check"),
    commit = stages.get("commit_candidate");
  requireAdopted(
    v &&
      (v.stage === "verification" || v.stage === "verification_deep") &&
      v.frozenVerification &&
      gen?.stage === "generation" &&
      gen.frozenQuality &&
      q?.stage === "quality_check" &&
      commit?.stage === "commit_candidate" &&
      (commit.outcome !== "proposed" ||
        (commit.proposal.inputRevision === run.inputRevision &&
          commit.proposal.baseVersionId === run.baseVersionId)),
    "adopted_artifact_missing",
  );
  requireAdopted(
    q.contentDigest === listingInputDigest(gen.content) &&
      (q.outcome !== "needs_info" || commit.outcome === "needs_info") &&
      (commit.outcome === "needs_info" || q.outcome === "ready"),
    "adopted_quality_invalid",
  );
  requireAdopted(
    commit.outcome === "needs_info" ||
      (v.identity.status === "matched" &&
        ![...stages.values()].some(
          (x) => "issues" in x && x.issues.some((i) => i.blocking),
        )),
    "adopted_quality_invalid",
  );
  const frozen = v.frozenVerification,
    request = wineGenerationRequestSchema.parse(gen.frozenQuality.request),
    candidate = wineGenerationCandidateSchema.parse(
      gen.frozenQuality.candidate,
    ),
    binding = {
      workspaceId: c.workspaceId,
      operationId: run.id,
      inputRevision: run.inputRevision,
    };
  requireAdopted(
    same(frozen.binding, binding) &&
      same(request.binding, binding) &&
      same(v.identity, frozen.identity) &&
      same(candidate.content, gen.content),
    "adopted_artifact_binding_invalid",
  );
  const base = run.baseVersionId
    ? await r.wineEnrichment.readVersionOrigin(c.listingId, run.baseVersionId)
    : null;
  requireAdopted(
    (!run.baseVersionId || base) &&
      run.activeVersionSequence === (base?.sequence ?? 0),
    "adopted_base_invalid",
  );
  const working = workingListingSchema.parse(input.workingContent);
  requireAdopted(
    (!working.wineOwnership || hasWineSectionMapping(working)) &&
      (!base?.content.wineOwnership || hasWineSectionMapping(base.content)),
    "adopted_ownership_invalid",
  );
  const own = resolveWineGenerationOwnership(input, working, base?.content, {
    ...binding,
    listingId: c.listingId,
    baseVersionId: run.baseVersionId,
  });
  requireAdopted(
    same(request.ownership, {
      schemaVersion: 1,
      priorKind: own.prior.kind,
      metadata: own.prior.metadata,
      legacyDescription:
        own.prior.kind === "legacy" ? own.prior.description : null,
      lockedPaths: own.lockedPaths,
      provenanceDigest: own.provenanceDigest,
    }) &&
      same(request.current, own.prior.current) &&
      same(request.lockedPaths, own.lockedPaths),
    "adopted_ownership_invalid",
  );
  const profile = e.profile as { tone?: unknown; claimPolicy?: unknown };
  requireAdopted(
    profile &&
      request.tone === profile.tone &&
      same(request.claimPolicy, profile.claimPolicy) &&
      request.section === null,
    "adopted_policy_invalid",
  );
  const claims = v.claims.filter((x) => x.state === "accepted");
  requireAdopted(
    same(request.claims, claims) &&
      same(
        [...frozen.lockedFields].sort(),
        Object.entries(input.fieldStates)
          .filter(([, s]) => s?.owner === "operator" || s?.locked)
          .map(([k]) => k)
          .sort(),
      ),
    "adopted_claim_invalid",
  );
  validateWineGenerationRequest(request);
  requireAdopted(
    wineCandidateIssues(request, candidate).length === 0,
    "adopted_candidate_invalid",
  );
  await authorizeWineVerifiedEvidence(r, {
    workspaceId: c.workspaceId,
    run,
    input,
    frozen,
    claims,
    now,
  });
  const projected = projectWineContent(
    input,
    base?.content,
    run,
    gen,
    claims,
    v.identity,
    own,
  );
  if (commit.outcome === "proposed")
    requireAdopted(
      projected.success && same(projected.data, commit.proposal.content),
      "proposal_content_invalid",
    );
  return {
    run,
    input,
    commit,
    candidate,
    claims,
    frozen,
    ownership: own,
    base,
    projected,
    copy: null,
    prior: null,
  };
}
async function authorizeCopySource(
  graph: WineOriginGraph,
  run: ListingOperation,
  input: ListingInputSnapshot,
) {
  const { r, scope: c, now } = graph;
  const accepted = wineCopySnapshotSchema.parse(run.execution.wineCopy);
  requireAdopted(
    accepted.mode === run.execution.wineMode &&
      accepted.baseVersionId === run.baseVersionId &&
      accepted.workspaceId === c.workspaceId &&
      accepted.listingId === c.listingId &&
      accepted.inputRevision === run.inputRevision &&
      accepted.dependencyDigest === wineCopyDependencyDigest(accepted),
    "adopted_copy_binding_invalid",
  );
  const base = await r.wineEnrichment.readVersionOrigin(
    c.listingId,
    accepted.baseVersionId,
  );
  requireAdopted(base, "adopted_base_invalid");
  requireAdopted(
    run.activeVersionSequence === base.sequence,
    "adopted_base_invalid",
  );
  const working = workingListingSchema.parse(input.workingContent);
  requireAdopted(
    (!working.wineOwnership || hasWineSectionMapping(working)) &&
      (!base.content.wineOwnership || hasWineSectionMapping(base.content)),
    "adopted_ownership_invalid",
  );
  const own = resolveWineGenerationOwnership(input, working, base.content, {
    workspaceId: c.workspaceId,
    listingId: c.listingId,
    operationId: run.id,
    inputRevision: run.inputRevision,
    baseVersionId: run.baseVersionId,
  });
  // The base need not remain active. Reconstruct using THIS historical copy's exact accepted input.
  const prior = await graph.dependencies(accepted.baseVersionId, input);
  const rebuilt = buildWineCopySnapshot({
    adopted: prior,
    input,
    ownership: own,
    mode: accepted.mode,
    section: accepted.section,
    policy: wineEnrichmentPolicySchema.parse(run.execution.wineEnrichment),
    model: wineExecutionSnapshotSchema.parse(run.execution.wineGo),
  });
  requireAdopted(
    rebuilt.snapshot.dependencyDigest === accepted.dependencyDigest,
    "adopted_copy_dependency_invalid",
  );
  const stages = await chain(r, run),
    gen = stages.get("generation"),
    q = stages.get("quality_check"),
    commit = stages.get("commit_candidate");
  requireAdopted(
    gen?.stage === "generation" &&
      gen.frozenQuality &&
      q?.stage === "quality_check" &&
      commit?.stage === "commit_candidate" &&
      (commit.outcome !== "proposed" ||
        (commit.proposal.inputRevision === run.inputRevision &&
          commit.proposal.baseVersionId === run.baseVersionId)),
    "adopted_artifact_missing",
  );
  const request = wineGenerationRequestSchema.parse(gen.frozenQuality.request),
    candidate = wineGenerationCandidateSchema.parse(
      gen.frozenQuality.candidate,
    );
  requireAdopted(
    same(
      request,
      buildWineGenerationRequest(run, own, rebuilt.claims, accepted.section),
    ) && same(candidate.content, gen.content),
    "adopted_artifact_binding_invalid",
  );
  requireAdopted(
    wineCandidateIssues(request, candidate).length === 0,
    "adopted_candidate_invalid",
  );
  requireAdopted(
    q.contentDigest === listingInputDigest(gen.content) &&
      (q.outcome !== "needs_info" || commit.outcome === "needs_info") &&
      (commit.outcome === "needs_info" ||
        (q.outcome === "ready" &&
          ![...stages.values()].some(
            (x) => "issues" in x && x.issues.some((i) => i.blocking),
          ))),
    "adopted_quality_invalid",
  );
  const identity = prior.origins[0]?.frozenVerification.identity;
  requireAdopted(identity, "adopted_original_required");
  const projected = projectWineContent(
    input,
    base.content,
    run,
    gen,
    rebuilt.claims,
    identity,
    own,
  );
  if (commit.outcome === "proposed")
    requireAdopted(
      projected.success && same(projected.data, commit.proposal.content),
      "proposal_content_invalid",
    );
  return {
    run,
    input,
    commit,
    candidate,
    claims: rebuilt.claims,
    frozen: null,
    ownership: own,
    base,
    projected,
    copy: accepted,
    prior,
  };
}
type WineTerminalSource = Awaited<ReturnType<typeof authorizeTerminalSource>>;

/** Terminal proposal inspection authority only. No version creation/adoption, no provider call.
 * Internal module export: deliberately not re-exported from the package index in this patch.
 * Caller must own the workspace transaction. Locks survive until its commit.
 */
export async function readWineTerminalProposal(
  r: WorkspaceRepositories,
  c: { workspaceId: string; listingId: string; runId: string },
) {
  await r.listings.lockReviewState(c.listingId);
  const listing = await r.listings.getById(c.listingId);
  const current = await r.listingInputs.getCurrent(c.listingId);
  const run = await r.pipelineRuns.getOperation(c.runId);
  const latest = await r.pipelineRuns.getCurrentOperation(c.listingId);
  requireAdopted(
    listing &&
      listing.workspaceId === c.workspaceId &&
      current &&
      run &&
      run.listingId === c.listingId &&
      run.executionState === "succeeded" &&
      latest?.id === run.id &&
      listing.inputRevision === run.inputRevision &&
      current.revision === run.inputRevision &&
      run.baseVersionId !== null &&
      listing.activeVersionId === run.baseVersionId,
    "proposal_current_changed",
  );
  await r.wineEnrichment.lockAuthorities();
  const now = await r.pipelineRuns.acceptanceTimestamp();
  const graph = new WineOriginGraph(r, c, now);
  const source = await authorizeTerminalSource(graph, run);
  requireAdopted(
    source.commit.outcome === "proposed" &&
      source.commit.proposal.inputRevision === current.revision &&
      source.commit.proposal.baseVersionId === listing.activeVersionId &&
      source.input.inputDigest === current.inputDigest,
    "proposal_binding_invalid",
  );
  const stage = await r.wineEnrichment.readStage(run.id, "commit_candidate");
  requireAdopted(stage, "adopted_stage_unavailable");
  return {
    source,
    proposal: source.commit.proposal,
    proposalStageDigest: listingInputDigest(stage.output),
    now,
  };
}

/** Explicit alternate lineage. Old complete artifacts and their key/content checks remain independent. */
async function validateProposalOrigin(
  graph: WineOriginGraph,
  row: WineVersionOrigin,
  run: ListingOperation,
): Promise<ValidOrigin> {
  const { r, scope: c, now } = graph,
    proof = row.adoption!;
  const source = await authorizeTerminalSource(graph, run);
  const { commit, input, base } = source;
  requireAdopted(
    commit.outcome === "proposed" && base,
    "adopted_artifact_missing",
  );
  const stage = await r.wineEnrichment.readStage(run.id, "commit_candidate");
  requireAdopted(
    stage &&
      proof.proposalRunId === run.id &&
      proof.proposalStageDigest === listingInputDigest(stage.output) &&
      proof.proposalContentDigest === commit.proposal.contentDigest &&
      proof.sourceInputRevision === run.inputRevision &&
      proof.sourceInputDigest === input.inputDigest &&
      proof.baseVersionId === run.baseVersionId &&
      proof.baseVersionId === base.versionId &&
      base.sequence < row.sequence &&
      run.activeVersionSequence === base.sequence &&
      row.pipelineIdempotencyKey === null &&
      row.createdBy === proof.actorId &&
      Date.parse(proof.adoptedAt) >= Date.parse(run.acceptedAt) &&
      Date.parse(proof.adoptedAt) <= Date.parse(now),
    "adopted_proposal_binding_invalid",
  );
  requireAdopted(
    proof.requestDigest ===
      wineAdoptionRequestDigest({
        workspaceId: c.workspaceId,
        listingId: c.listingId,
        runId: run.id,
        actorId: proof.actorId,
        expectedInputRevision: input.revision,
        baseVersionId: base.versionId,
        selectedPaths: proof.selectedPaths,
      }),
    "adopted_proposal_request_invalid",
  );
  const content = selectWineProposal(
    {
      input,
      base: base.content,
      proposal: commit.proposal.content,
      ownership: source.ownership,
    },
    proof.selectedPaths,
  );
  requireAdopted(
    proof.adoptedContentDigest === listingInputDigest(content) &&
      same(content, row.content) &&
      same(wineSectionContent(content), row.sections),
    "adopted_content_invalid",
  );
  const candidate = {
    ...source.candidate,
    annotations: source.candidate.annotations.filter((a) =>
      selectedWinePath(proof.selectedPaths, a.path),
    ),
  };
  let claimOrigins: Map<string, ValidOrigin> | undefined,
    originalContexts: ValidOrigin[] | undefined;
  if (source.copy) {
    requireAdopted(source.prior, "adopted_original_required");
    originalContexts = [];
    claimOrigins = new Map();
    for (const context of source.prior.origins) {
      const original = await graph.visit(context.versionId);
      requireAdopted(
        original.frozen && original.run.id === context.runId,
        "adopted_original_required",
      );
      originalContexts.push(original);
    }
    for (const pointer of source.copy.claims) {
      const original = originalContexts.find(
        (o) =>
          o.run.id === pointer.originRunId &&
          o.row.versionId === pointer.originVersionId,
      );
      requireAdopted(
        original &&
          original.claims.some(
            (cl) =>
              cl.id === pointer.claimId &&
              listingInputDigest(cl) === pointer.claimDigest,
          ),
        "adopted_claim_invalid",
      );
      claimOrigins.set(pointer.claimId, original);
    }
  }
  return {
    row,
    run,
    input,
    frozen: source.frozen,
    claims: source.claims,
    candidate,
    outcome: "complete",
    identityAnchor: commit.proposal.content,
    ...(claimOrigins ? { claimOrigins, originalContexts } : {}),
  };
}
