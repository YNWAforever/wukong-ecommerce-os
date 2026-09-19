import { listingInputDigest } from "@wukong/db";
import {
  renderWineDescription,
  workingListingSchema,
  workingBaselineForReview,
  mergeWorkingCandidate,
  reviewableListingSchema,
  scanCompliance,
  localizedCopyFields,
  listingFactsSchema,
} from "@wukong/core";
import type { WineCandidateProjection } from "./wine-enrichment-runtime.js";
import {
  readWineGenerationRequestFromRepositories,
  authorizeWineFrozenQuality,
  committedGeneration,
} from "./wine-generation-context.js";
import { savedResult, wineRequiredOutcome } from "./wine-stage-authority.js";
function requireProjection(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
/** DB-only. The stage store owns the transaction, listing/run locks, and terminal commit. */
export const projectWineCandidate: WineCandidateProjection = async (r, c) => {
  const { request, ownership, identity, input } =
    await readWineGenerationRequestFromRepositories(r, c);
  const g = committedGeneration(c);
  const frozen = authorizeWineFrozenQuality(g, request);
  requireProjection(
    g.state === "succeeded" && g.stage === "generation",
    "projection_generation_required",
  );
  const qrow = c.dependencies.find((d) => d.stage === "quality_check");
  requireProjection(qrow, "projection_quality_required");
  const q = savedResult(qrow);
  requireProjection(
    q.state === "succeeded" &&
      q.stage === "quality_check" &&
      q.contentDigest === listingInputDigest(frozen.candidate.content),
    "projection_quality_required",
  );
  requireProjection(
    q.outcome !== "ready" || !q.issues.some((i) => i.blocking),
    "projection_quality_inconsistent",
  );
  const claims = request.claims;
  const deadline = Date.parse(
    (c.run.execution.wineAcquisition as { deadlineAt: string }).deadlineAt,
  );
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
  for (const claim of ["full", "research"].includes(
    String(c.run.execution.wineMode),
  )
    ? claims
    : []) {
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
      : (merged.packQuantity ?? identity.packQuantity),
  });
  const audit = {
    workspaceId: c.job.workspaceId,
    actorId: "wine-worker",
    entityId: c.run.listingId,
  };
  const needsInfo =
    c.requiredOutcome === "needs_info" ||
    wineRequiredOutcome(c.run, c.dependencies) === "needs_info" ||
    !parsed.success;
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
