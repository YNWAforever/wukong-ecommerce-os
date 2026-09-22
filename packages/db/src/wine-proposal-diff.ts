import { z } from "zod";
import {
  workingFields,
  readWorkingField,
  workingBaselineForReview,
  workingListingSchema,
  type ContentSection,
} from "@wukong/core";
import type { WorkspaceRepositories } from "./client.js";
import { listingInputDigest } from "./repositories/listing-inputs.js";
import { parseWineStageResult } from "./wine-stage-artifacts.js";
import { readWineTerminalProposal } from "./wine-adopted-dependencies.js";
import { resolveWineGenerationOwnership } from "./wine-generation-ownership.js";
import {
  assertWineProposalPath,
  selectWineProposal,
  wineAdoptionRequestDigest,
  wineAdoptionProofSchema,
  wineSectionContent,
} from "./wine-proposal.js";
import { sanitizeWineDisplay } from "./wine-display.js";
const scopeSchema = z
  .object({
    workspaceId: z.string().min(1),
    listingId: z.uuid(),
    runId: z.uuid(),
  })
  .strict();
type Scope = z.infer<typeof scopeSchema>;
const same = (a: unknown, b: unknown) =>
  listingInputDigest(a) === listingInputDigest(b);
function terminal(raw: unknown) {
  try {
    const result = parseWineStageResult(raw, "commit_candidate");
    return result.state === "succeeded" &&
      result.stage === "commit_candidate" &&
      result.outcome === "proposed"
      ? result.proposal
      : null;
  } catch {
    return null;
  }
}
/** Historical immutable event display only. This never grants current evidence or adoption authority. */
export async function readWineProposalAdoption(
  r: WorkspaceRepositories,
  raw: Scope,
): Promise<{ versionId: string } | null> {
  const c = scopeSchema.parse(raw);
  const row = await r.wineEnrichment.readAdoptionByProposalRun(
    c.listingId,
    c.runId,
  );
  if (!row) return null;
  const run = await r.pipelineRuns.getOperation(c.runId);
  const stage = await r.wineEnrichment.readStage(c.runId, "commit_candidate");
  const wrapper = stage?.output as
    { schemaVersion?: number; fresh?: boolean; result?: unknown } | undefined;
  const proposal = terminal(wrapper?.result),
    proof = row.adoption ? wineAdoptionProofSchema.parse(row.adoption) : null;
  const input = run
    ? await r.listingInputs.getRevision(c.listingId, run.inputRevision)
    : null;
  const base = run?.baseVersionId
    ? await r.wineEnrichment.readVersionOrigin(c.listingId, run.baseVersionId)
    : null;
  if (
    !run ||
    run.listingId !== c.listingId ||
    run.executionState !== "succeeded" ||
    run.execution.flowVersion !== "wine-enrichment-v1" ||
    !input ||
    !base ||
    !proposal ||
    !proof ||
    !stage ||
    stage.runId !== run.id ||
    stage.stage !== "commit_candidate" ||
    stage.state !== "succeeded" ||
    wrapper?.schemaVersion !== 1 ||
    wrapper.fresh !== true ||
    proof.proposalStageDigest !== listingInputDigest(stage.output) ||
    Date.parse(proof.adoptedAt) < Date.parse(run.acceptedAt) ||
    proof.proposalContentDigest !== proposal.contentDigest ||
    proof.proposalRunId !== run.id ||
    proof.sourceInputRevision !== run.inputRevision ||
    proof.sourceInputDigest !== input.inputDigest ||
    stage.inputDigest !== input.inputDigest ||
    run.execution.wineInputDigest !== input.inputDigest ||
    proof.baseVersionId !== run.baseVersionId ||
    proposal.baseVersionId !== run.baseVersionId ||
    proposal.inputRevision !== run.inputRevision ||
    row.workspaceId !== c.workspaceId ||
    row.listingId !== c.listingId ||
    row.runId !== run.id ||
    row.pipelineIdempotencyKey !== null ||
    row.createdBy !== proof.actorId ||
    row.sequence <= base.sequence ||
    run.activeVersionSequence !== base.sequence ||
    !same(row.sections, wineSectionContent(row.content)) ||
    proof.adoptedContentDigest !== listingInputDigest(row.content) ||
    proof.requestDigest !==
      wineAdoptionRequestDigest({
        ...c,
        actorId: proof.actorId,
        expectedInputRevision: proof.sourceInputRevision,
        baseVersionId: proof.baseVersionId,
        selectedPaths: proof.selectedPaths,
      })
  )
    throw Error("proposal_adoption_invalid");
  const ownership = resolveWineGenerationOwnership(
    input,
    workingListingSchema.parse(input.workingContent),
    base.content,
    {
      workspaceId: c.workspaceId,
      listingId: c.listingId,
      operationId: run.id,
      inputRevision: run.inputRevision,
      baseVersionId: base.versionId,
    },
  );
  if (
    ownership.status !== "available" ||
    !same(
      selectWineProposal(
        { input, base: base.content, proposal: proposal.content, ownership },
        proof.selectedPaths,
      ),
      row.content,
    )
  )
    throw Error("proposal_adoption_invalid");
  return { versionId: row.versionId };
}
export type WineProposalDiff = {
  runId: string;
  inputRevision: number;
  baseVersionId: string | null;
  contentDigest: string | null;
  current: { inputRevision: number; activeVersionId: string | null };
  state: "available" | "stale" | "rejected" | "blocked" | "adopted";
  reason: string | null;
  adoptedVersionId: string | null;
  differences: {
    path: string;
    kind: "field" | "section";
    before: unknown;
    after: unknown;
    selectable: boolean;
    reason: string | null;
  }[];
};
/** Caller authenticates reviewer before entering the scoped transaction. No raw authority leaves this service. */
export async function readWineProposalDiff(
  r: WorkspaceRepositories,
  raw: Scope,
): Promise<WineProposalDiff> {
  const c = scopeSchema.parse(raw);
  await r.listings.lockReviewState(c.listingId);
  const listing = await r.listings.getById(c.listingId),
    run = await r.pipelineRuns.getOperation(c.runId);
  if (
    !listing ||
    listing.workspaceId !== c.workspaceId ||
    !run ||
    run.listingId !== c.listingId
  )
    throw Error("proposal_not_found");
  const stage = await r.wineEnrichment.readStage(run.id, "commit_candidate");
  const wrapper = stage?.output as
    { fresh?: boolean; result?: unknown; rejectedResult?: unknown } | undefined;
  const proposed =
    terminal(wrapper?.rejectedResult) ?? terminal(wrapper?.result);
  const dto: WineProposalDiff = {
    runId: run.id,
    inputRevision: run.inputRevision,
    baseVersionId: run.baseVersionId,
    contentDigest: proposed?.contentDigest ?? null,
    current: {
      inputRevision: listing.inputRevision,
      activeVersionId: listing.activeVersionId,
    },
    state: "blocked",
    reason: "proposal_unavailable",
    adoptedVersionId: null,
    differences: [],
  };
  try {
    const adopted = await readWineProposalAdoption(r, c);
    if (adopted) {
      dto.state = "adopted";
      dto.reason = null;
      dto.adoptedVersionId = adopted.versionId;
      return dto;
    }
  } catch {
    dto.reason = "proposal_adoption_invalid";
    return dto;
  }
  if (!proposed) {
    const generation = await r.wineEnrichment.readStage(run.id, "generation");
    const rejected = generation?.output as
      | { schemaVersion?: number; fresh?: boolean; rejectedResult?: unknown }
      | undefined;
    if (
      generation?.runId === run.id &&
      generation.inputDigest === run.execution.wineInputDigest &&
      rejected?.schemaVersion === 1 &&
      rejected.fresh === false &&
      rejected.rejectedResult
    ) {
      dto.state = "rejected";
      dto.reason = "proposal_rejected";
    }
    return dto;
  }
  if (wrapper?.rejectedResult) {
    dto.state = "rejected";
    dto.reason = "proposal_rejected";
  } else if (
    wrapper?.fresh !== true ||
    listing.inputRevision !== run.inputRevision ||
    listing.activeVersionId !== run.baseVersionId ||
    (await r.pipelineRuns.getCurrentOperation(c.listingId))?.id !== run.id
  ) {
    dto.state = "stale";
    dto.reason = "proposal_current_changed";
  } else if (
    !["in_review", "reopened", "needs_info"].includes(listing.status)
  ) {
    dto.reason = "proposal_status_changed";
  } else {
    try {
      await readWineTerminalProposal(r, c);
      dto.state = "available";
      dto.reason = null;
    } catch (error) {
      dto.reason =
        error instanceof Error && error.message === "evidence_refresh_required"
          ? "evidence_refresh_required"
          : "proposal_authorization_unavailable";
    }
  }
  const input = await r.listingInputs.getCurrent(c.listingId);
  const base = listing.activeVersionId
    ? await r.wineEnrichment.readVersionOrigin(
        c.listingId,
        listing.activeVersionId,
      )
    : null;
  if (!input || !base) return dto;
  const baseline = workingBaselineForReview(
    workingListingSchema.parse(input.workingContent),
    input.fieldStates,
    base.content,
  );
  const ownership = resolveWineGenerationOwnership(
    input,
    workingListingSchema.parse(input.workingContent),
    base.content,
    {
      workspaceId: c.workspaceId,
      listingId: c.listingId,
      operationId: run.id,
      inputRevision: input.revision,
      baseVersionId: base.versionId,
    },
  );
  const source = {
    input,
    base: base.content,
    proposal: proposed.content,
    ownership,
  };
  const add = (
    path: string,
    kind: "field" | "section",
    before: unknown,
    after: unknown,
  ) => {
    let reason = dto.reason;
    if (!reason) {
      try {
        if (ownership.status !== "available")
          throw Error("proposal_path_protected");
        assertWineProposalPath({ ...source, ownership }, path);
      } catch {
        reason = "proposal_path_protected";
      }
    }
    dto.differences.push({
      path,
      kind,
      before: sanitizeWineDisplay(before),
      after: sanitizeWineDisplay(after),
      selectable: !reason,
      reason,
    });
  };
  // Include allowed fields even if equal so UI can select a complete atomic metadata set when required.
  for (const path of workingFields) {
    try {
      assertWineProposalPath(source, path);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "proposal_selection_invalid"
      )
        continue;
    }
    add(
      path,
      "field",
      readWorkingField(baseline.workingContent, path),
      readWorkingField(proposed.content, path),
    );
  }
  const text = (s: ContentSection | undefined) =>
    s ? { en: s.en, "zh-Hant": s["zh-Hant"] } : null;
  for (const section of proposed.content.wineOwnership?.sections ?? [])
    add(
      `sections.${section.key}`,
      "section",
      text(
        baseline.workingContent.wineOwnership?.sections.find(
          (s) => s.key === section.key,
        ),
      ),
      text(section),
    );
  return dto;
}
