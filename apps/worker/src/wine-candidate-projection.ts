import { listingInputDigest } from "@wukong/db";
import {
  decideWineClaim,
  renderWineDescription,
  workingListingSchema,
  workingBaselineForReview,
  mergeWorkingCandidate,
  reviewableListingSchema,
  scanCompliance,
  localizedCopyFields,
  listingFactsSchema,
} from "@wukong/core";
import {
  validateWineGenerationRequest,
  wineCandidateIssues,
  wineGenerationRequestSchema,
  wineGenerationCandidateSchema,
} from "@wukong/ai";
import type { WineCandidateProjection } from "./wine-enrichment-runtime.js";
import { parseWineStageResult } from "./wine-enrichment-pipeline.js";
import { readWineGenerationOwnershipFromRepositories } from "./wine-generation-ownership.js";
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
function requireProjection(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
/** DB-only. The stage store owns the transaction, listing/run locks, and terminal commit. */
export const projectWineCandidate: WineCandidateProjection = async (r, c) => {
  const ownership = await readWineGenerationOwnershipFromRepositories(r, c);
  requireProjection(
    ownership.status === "available",
    "projection_ownership_unavailable",
  );
  const result = (stage: string) => {
    const row = c.dependencies.find((d) => d.stage === stage);
    requireProjection(
      row?.state === "succeeded",
      "projection_dependency_missing",
    );
    const wrapper = row.output as {
      schemaVersion?: number;
      fresh?: boolean;
      result?: unknown;
    };
    requireProjection(
      wrapper.schemaVersion === 1 && wrapper.fresh === true,
      "projection_dependency_stale",
    );
    return parseWineStageResult(wrapper.result, row.stage);
  };
  const v = result(
    c.dependencies.some(
      (d) => d.stage === "verification_deep" && d.state === "succeeded",
    )
      ? "verification_deep"
      : "verification",
  );
  const g = result("generation"),
    q = result("quality_check");
  requireProjection(
    v.state === "succeeded" &&
      (v.stage === "verification" || v.stage === "verification_deep") &&
      v.frozenVerification,
    "projection_verification_required",
  );
  requireProjection(
    g.state === "succeeded" && g.stage === "generation" && g.frozenQuality,
    "projection_generation_required",
  );
  requireProjection(
    q.state === "succeeded" &&
      q.stage === "quality_check" &&
      q.contentDigest === listingInputDigest(g.content),
    "projection_quality_required",
  );
  const input = await r.listingInputs.getRevision(
    c.run.listingId,
    c.run.inputRevision,
  );
  requireProjection(input, "projection_input_missing");
  const frozen = v.frozenVerification,
    request = wineGenerationRequestSchema.parse(g.frozenQuality.request),
    candidate = wineGenerationCandidateSchema.parse(g.frozenQuality.candidate);
  const binding = {
    workspaceId: c.job.workspaceId,
    operationId: c.run.id,
    inputRevision: c.run.inputRevision,
  };
  requireProjection(
    same(frozen.binding, binding) && same(request.binding, binding),
    "projection_binding_mismatch",
  );
  requireProjection(
    same(v.identity, frozen.identity) && same(candidate.content, g.content),
    "projection_artifact_mismatch",
  );
  const acceptedLocks = Object.entries(input.fieldStates)
    .filter(([, state]) => state?.owner === "operator" || state?.locked)
    .map(([key]) => key)
    .sort();
  requireProjection(
    same([...frozen.lockedFields].sort(), acceptedLocks),
    "projection_verification_locks_mismatch",
  );
  const expectedOwnership = {
    schemaVersion: 1,
    priorKind: ownership.prior.kind,
    metadata: ownership.prior.metadata,
    legacyDescription:
      ownership.prior.kind === "legacy" ? ownership.prior.description : null,
    lockedPaths: ownership.lockedPaths,
    provenanceDigest: ownership.provenanceDigest,
  };
  requireProjection(
    same(request.ownership, expectedOwnership) &&
      same(request.current, ownership.prior.current) &&
      same(request.lockedPaths, ownership.lockedPaths),
    "projection_ownership_changed",
  );
  const profile = c.run.execution.profile as
    { tone?: unknown; claimPolicy?: unknown } | undefined;
  requireProjection(
    profile &&
      request.tone === profile.tone &&
      same(request.claimPolicy, profile.claimPolicy) &&
      request.section === null &&
      ["full", "research"].includes(String(c.run.execution.wineMode)),
    "projection_policy_mismatch",
  );
  const claims = v.claims.filter((x) => x.state === "accepted");
  requireProjection(same(request.claims, claims), "projection_claims_mismatch");
  validateWineGenerationRequest(request);
  requireProjection(
    wineCandidateIssues(request, candidate).length === 0,
    "projection_candidate_invalid",
  );
  // Serialize the authority decision with reviewer writes through this transaction's COMMIT.
  await r.wineEnrichment.lockAuthorities();
  const authorities = await r.wineEnrichment.readAuthorities();
  const sources = await r.wineEnrichment.readEvidence(c.run.id);
  const provenance = (pool: typeof sources) =>
    pool
      .map(({ identity: _i, trust: _t, ...s }) => s)
      .sort((a, b) => a.id.localeCompare(b.id));
  const now = await r.pipelineRuns.acceptanceTimestamp(),
    time = Date.parse(now);
  const deadline = Date.parse(
    (c.run.execution.wineAcquisition as { deadlineAt: string }).deadlineAt,
  );
  requireProjection(
    time >= Date.parse(c.run.acceptedAt) && time < deadline,
    "projection_deadline",
  );
  requireProjection(
    Date.parse(frozen.now) >= Date.parse(c.run.acceptedAt) &&
      Date.parse(frozen.now) <= time &&
      Date.parse(frozen.now) < deadline,
    "projection_verification_time",
  );
  requireProjection(
    same(authorities, frozen.authorities) &&
      same(provenance(sources), provenance(frozen.sources)),
    "projection_evidence_changed",
  );
  requireProjection(
    frozen.sources.every(
      (s) =>
        Date.parse(s.capturedAt) <= time &&
        (s.kind !== "web" || time - Date.parse(s.capturedAt) < 7 * 86400000),
    ),
    "projection_evidence_expired",
  );
  requireProjection(
    frozen.acceptedPremises.every(
      (p) =>
        p.state === "accepted" &&
        p.kind === "fact" &&
        p.scope === "product" &&
        claims.some((x) => same(x, p)),
    ),
    "projection_premise_mismatch",
  );
  const context = {
    ...frozen,
    now,
    authorities,
    reliableSourceIds: new Set(frozen.reliableSourceIds),
    trustedObservationSourceIds: new Set(frozen.trustedObservationSourceIds),
  };
  for (const claim of [
    ...claims.filter((x) => x.kind === "fact"),
    ...claims.filter((x) => x.kind === "recommendation"),
  ]) {
    const decision = decideWineClaim({
      identity: frozen.identity,
      claim,
      sources: frozen.sources,
      lockedFields: new Set(frozen.lockedFields),
      context,
    });
    requireProjection(
      decision.state === "accepted" &&
        same([...decision.evidenceIds].sort(), [...claim.evidenceIds].sort()),
      "projection_claim_no_longer_supported",
    );
  }
  const review = c.run.baseVersionId
    ? await r.listings.getReviewSnapshot(c.run.listingId)
    : null;
  const baseline = workingBaselineForReview(
    workingListingSchema.parse(input.workingContent),
    input.fieldStates,
    review?.activeVersion?.content,
  );
  const proposed = {
    ...baseline.workingContent,
    ...g.content,
    description: {
      en: renderWineDescription(g.content, "en"),
      "zh-Hant": renderWineDescription(g.content, "zh-Hant"),
    },
    wineOwnership: { schemaVersion: 1 as const, sections: g.content.sections },
  };
  for (const claim of claims) {
    if (
      claim.kind !== "fact" ||
      claim.scope !== "product" ||
      ["sku", "priceHkd", "stockQuantity"].includes(claim.field)
    )
      continue;
    const schema =
      listingFactsSchema.shape[
        claim.field as keyof typeof listingFactsSchema.shape
      ];
    const value = schema?.safeParse(claim.value);
    if (value?.success) Object.assign(proposed, { [claim.field]: value.data });
  }
  // No commercial facts can originate in the generation contract. Merge also preserves every operator field.
  const merged = mergeWorkingCandidate(
    baseline.workingContent,
    baseline.fieldStates,
    proposed,
  );
  if (ownership.prior.kind === "legacy") {
    merged.description = structuredClone(ownership.prior.description);
    delete merged.wineOwnership;
  }
  const protectedPack =
    baseline.fieldStates.packQuantity?.owner === "operator" ||
    baseline.fieldStates.packQuantity?.locked;
  const parsed = reviewableListingSchema.safeParse({
    ...merged,
    packQuantity: protectedPack
      ? merged.packQuantity
      : (merged.packQuantity ?? v.identity.packQuantity),
  });
  const audit = {
    workspaceId: c.job.workspaceId,
    actorId: "wine-worker",
    entityId: c.run.listingId,
  };
  const needsInfo = c.requiredOutcome === "needs_info" || !parsed.success;
  const listing = await r.listings.requireById(c.run.listingId);
  const existingReview = ["in_review", "reopened"].includes(listing.status);
  if (existingReview && needsInfo) {
    requireProjection(
      Date.parse(await r.pipelineRuns.acceptanceTimestamp()) < deadline,
      "projection_deadline",
    );
    // Inspectable generation/check checkpoints retain the full proposal. Do not replace or downgrade a reviewable base.
    return {
      schemaVersion: 1,
      stage: "commit_candidate",
      state: "succeeded",
      versionId: null,
      outcome: "needs_info",
    };
  }
  if (!existingReview)
    await r.listings.startProcessing(c.run.listingId, audit, r.audit);
  let versionId: string | null = null;
  if (parsed.success) {
    const version = await r.listings.appendVersion(
      c.run.listingId,
      parsed.data,
      audit,
      r.audit,
      c.run.idempotencyKey,
    );
    versionId = version.id;
    await r.wineEnrichment.saveSections({
      runId: c.run.id,
      listingId: c.run.listingId,
      versionId,
      content: {
        title: parsed.data.title,
        seo: parsed.data.seo,
        tags: parsed.data.tags,
        sections: parsed.data.wineOwnership?.sections ?? [],
      },
    });
    await r.listings.replaceFlags(
      versionId,
      scanCompliance(localizedCopyFields(parsed.data), {
        criticScores: parsed.data.criticScores,
        awards: parsed.data.awards,
      }),
    );
  }
  await r.listings.complete(
    c.run.listingId,
    {
      status: needsInfo ? "needs_info" : "in_review",
      versionId: versionId ?? c.run.baseVersionId,
      idempotencyKey: c.run.idempotencyKey,
    },
    audit,
    r.audit,
  );
  requireProjection(
    Date.parse(await r.pipelineRuns.acceptanceTimestamp()) < deadline,
    "projection_deadline",
  );
  return {
    schemaVersion: 1,
    stage: "commit_candidate",
    state: "succeeded",
    versionId,
    outcome: needsInfo ? "needs_info" : "complete",
  };
};
