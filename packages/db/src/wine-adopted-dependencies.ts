import {
  decideWineClaim,
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
  parseWineStageResult,
  type WineStageResult,
} from "./wine-stage-artifacts.js";
import { wineStageDependencyDigest } from "./wine-stage-dependencies.js";
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
const provenance = (sources: EvidenceSource[]) =>
  sources
    .map(({ identity: _i, trust: _t, ...s }) => s)
    .sort((a, b) => a.id.localeCompare(b.id));
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
  for (const stage of WINE_STAGE_ORDER) {
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
  row: WineVersionOrigin;
  run: ListingOperation;
  input: ListingInputSnapshot;
  frozen: WineFrozenContext;
  claims: SupportedClaim[];
  candidate: ReturnType<typeof wineGenerationCandidateSchema.parse>;
  outcome: "complete" | "needs_info";
};
async function validateOrigin(
  r: WorkspaceRepositories,
  c: AdoptedWineCoordinates,
  versionId: string,
  now: string,
): Promise<ValidOrigin> {
  const row = await r.wineEnrichment.readVersionOrigin(c.listingId, versionId);
  requireAdopted(
    row?.runId && row.sections && row.workspaceId === c.workspaceId,
    "adopted_origin_unavailable",
  );
  const run = await r.pipelineRuns.getOperation(row.runId);
  requireAdopted(
    run &&
      run.listingId === c.listingId &&
      run.executionState === "succeeded" &&
      row.pipelineIdempotencyKey === run.idempotencyKey,
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
      ["full", "research"].includes(String(e.wineMode)) &&
      e.wineMode === b.mode &&
      p.enabled &&
      g.rulesVersion === p.rulesVersion &&
      a.rulesVersion === p.rulesVersion &&
      a.policyVersion === p.policyVersion &&
      a.allowedDomains.length > 0 &&
      same([...a.allowedDomains].sort(), [...p.allowedDomains].sort()) &&
      deadline > accepted &&
      deadline - accepted <= 900000 &&
      time >= accepted,
    "adopted_policy_invalid",
  );
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
      commit.versionId === versionId,
    "adopted_artifact_missing",
  );
  requireAdopted(
    q.contentDigest === listingInputDigest(gen.content) &&
      (q.outcome !== "needs_info" || commit.outcome === "needs_info") &&
      (commit.outcome !== "complete" || q.outcome === "ready"),
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
    (!run.baseVersionId || (base && base.sequence < row.sequence)) &&
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
  const adopted = {
    title: row.content.title,
    seo: row.content.seo,
    tags: row.content.tags,
    sections: row.content.wineOwnership?.sections ?? [],
  };
  requireAdopted(
    same(adopted, row.sections) &&
      same(row.sections, {
        ...gen.content,
        sections: own.prior.kind === "legacy" ? [] : gen.content.sections,
      }) &&
      (!row.content.wineOwnership || hasWineSectionMapping(row.content)) &&
      (own.prior.kind !== "legacy" ||
        same(row.content.description, own.prior.description)),
    "adopted_content_invalid",
  );
  const registry = await r.wineEnrichment.readAuthorities(),
    sources = await r.wineEnrichment.readEvidence(run.id);
  requireAdopted(
    same(registry, frozen.authorities) &&
      same(provenance(sources), provenance(frozen.sources)),
    "adopted_authority_changed",
  );
  requireAdopted(
    Date.parse(frozen.now) >= accepted &&
      Date.parse(frozen.now) < deadline &&
      Date.parse(frozen.now) <= time,
    "adopted_frozen_time_invalid",
  );
  requireAdopted(
    frozen.sources.every(
      (s) =>
        Date.parse(s.capturedAt) <= time &&
        (s.kind !== "web" || time - Date.parse(s.capturedAt) < 7 * 86400000),
    ),
    "evidence_refresh_required",
  );
  requireAdopted(
    frozen.acceptedPremises.every(
      (p) =>
        p.state === "accepted" &&
        p.kind === "fact" &&
        p.scope === "product" &&
        claims.some((x) => same(x, p)),
    ),
    "adopted_claim_invalid",
  );
  const context = {
    ...frozen,
    now,
    authorities: registry,
    reliableSourceIds: new Set(frozen.reliableSourceIds),
    trustedObservationSourceIds: new Set(frozen.trustedObservationSourceIds),
  };
  for (const claim of claims) {
    const decision = decideWineClaim({
      identity: frozen.identity,
      claim,
      sources: frozen.sources,
      lockedFields: new Set(frozen.lockedFields),
      context,
    });
    requireAdopted(
      decision.state === "accepted" &&
        same([...decision.evidenceIds].sort(), [...claim.evidenceIds].sort()),
      "adopted_claim_invalid",
    );
  }
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
  const sources = origin.frozen.sources.filter((s) => ids.has(s.id));
  requireAdopted(sources.length === ids.size, "adopted_claim_invalid");
  return sources;
}
/** Transaction-scoped server read. Listing then workspace NKU locks remain held through the caller's admission/COMMIT. */
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
    const now = await r.pipelineRuns.acceptanceTimestamp(),
      origin = await validateOrigin(r, c, c.versionId, now);
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
    const adoptedPaths = wineTextPaths(origin.row.sections!);
    const add = (from: ValidOrigin, path: string, text: string) => {
      const sectionKey = path.startsWith("sections.")
        ? path.split(".")[1]
        : null;
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
        const sources = dependencySources(from, claim);
        const identityChanged =
          claim.scope === "product" &&
          identityFields.some((k) => !same(resolved[k], from.row.content[k]));
        const invalidReason = identityChanged
          ? "identity_changed"
          : sources.some((s) => sourceChanged(s, from.input, currentInput))
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
          originRunId: from.run.id,
          originVersionId: from.row.versionId,
          originInputRevision: from.input.revision,
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
      const sectionKey = path.startsWith("sections.")
        ? path.split(".")[1]
        : null;
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
          const prior =
            origins.get(id) ?? (await validateOrigin(r, c, id, now));
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
            error instanceof AdoptedError
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
    const verifiedOrigins: ValidatedWineOrigin[] = [...origins.values()].map(
      (o) => ({
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
        policy: wineEnrichmentPolicySchema.parse(
          o.run.execution.wineEnrichment,
        ),
        frozenVerification: o.frozen,
        claims: o.claims,
      }),
    );
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
  } catch (error) {
    return {
      status: "unavailable",
      code:
        error instanceof AdoptedError
          ? error.message
          : "adopted_evidence_unavailable",
    };
  }
}
