import { z } from "zod";
import { scanCompliance, localizedCopyFields } from "@wukong/core";
import type { WorkspaceRepositories } from "./client.js";
import { listingInputDigest } from "./repositories/listing-inputs.js";
import {
  readWineTerminalProposal,
  readAdoptedWineDependencies,
} from "./wine-adopted-dependencies.js";
import {
  selectWineProposal,
  wineAdoptionProofSchema,
  wineAdoptionRequestDigest,
  wineSectionContent,
} from "./wine-proposal.js";
const requestSchema = z
  .object({
    workspaceId: z.string().min(1),
    listingId: z.string().uuid(),
    runId: z.string().uuid(),
    actorId: z.string().min(1),
    expectedInputRevision: z.number().int().positive(),
    baseVersionId: z.string().uuid(),
    operationKey: z.string().uuid(),
    selectedPaths: z.array(z.string()).min(1).max(100),
  })
  .strict();
export type AdoptWineProposalInput = z.infer<typeof requestSchema>;
/** Authenticated server port. Caller owns workspace transaction; this savepoint also protects caught failures. */
export async function adoptWineProposal(
  r: WorkspaceRepositories,
  raw: AdoptWineProposalInput,
): Promise<{ versionId: string; runId: string; inputRevision: number }> {
  const input = requestSchema.parse(raw);
  return r.pipelineRuns.withAcceptanceSavepoint(async () => {
    await r.listings.lockReviewState(input.listingId);
    const listing = await r.listings.getById(input.listingId);
    if (!listing || listing.workspaceId !== input.workspaceId)
      throw Error("proposal_not_found");
    const requestDigest = wineAdoptionRequestDigest(input);
    const replay = await r.wineEnrichment.readAdoptionByOperationKey(
      input.listingId,
      input.operationKey,
    );
    if (replay) {
      if (
        !replay.adoption ||
        replay.adoption.requestDigest !== requestDigest ||
        replay.adoption.operationKey !== input.operationKey ||
        replay.adoption.actorId !== input.actorId ||
        replay.adoption.proposalRunId !== input.runId ||
        replay.adoption.baseVersionId !== input.baseVersionId ||
        replay.adoption.sourceInputRevision !== input.expectedInputRevision ||
        listingInputDigest(replay.adoption.selectedPaths) !==
          listingInputDigest([...input.selectedPaths].sort()) ||
        replay.adoption.adoptedContentDigest !==
          listingInputDigest(replay.content) ||
        replay.createdBy !== input.actorId ||
        replay.pipelineIdempotencyKey !== null
      )
        throw Error("idempotency_conflict");
      return {
        versionId: replay.versionId,
        runId: replay.adoption.proposalRunId,
        inputRevision: replay.adoption.sourceInputRevision,
      };
    }
    if (!["in_review", "reopened", "needs_info"].includes(listing.status))
      throw Error("proposal_status_changed");
    if (
      listing.inputRevision !== input.expectedInputRevision ||
      listing.activeVersionId !== input.baseVersionId
    )
      throw Error("proposal_current_changed");
    const authorized = await readWineTerminalProposal(r, input);
    const { source, proposal, proposalStageDigest, now } = authorized;
    if (
      source.run.inputRevision !== input.expectedInputRevision ||
      !source.base ||
      source.base.versionId !== input.baseVersionId
    )
      throw Error("proposal_binding_invalid");
    const content = selectWineProposal(
      {
        input: source.input,
        base: source.base.content,
        proposal: proposal.content,
        ownership: source.ownership,
      },
      input.selectedPaths,
    );
    const proof = wineAdoptionProofSchema.parse({
      schemaVersion: 1,
      proposalRunId: input.runId,
      proposalStageDigest,
      proposalContentDigest: proposal.contentDigest,
      sourceInputRevision: source.input.revision,
      sourceInputDigest: source.input.inputDigest,
      baseVersionId: input.baseVersionId,
      selectedPaths: [...input.selectedPaths].sort(),
      adoptedContentDigest: listingInputDigest(content),
      operationKey: input.operationKey,
      requestDigest,
      actorId: input.actorId,
      adoptedAt: now,
    });
    const audit = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      entityId: input.listingId,
    };
    const version = await r.listings.appendVersion(
      input.listingId,
      content,
      audit,
      r.audit,
    );
    await r.wineEnrichment.saveSections({
      runId: input.runId,
      listingId: input.listingId,
      versionId: version.id,
      content: wineSectionContent(content),
      adoption: proof,
    });
    await r.listings.replaceFlags(
      version.id,
      scanCompliance(localizedCopyFields(content), {
        criticScores: content.criticScores,
        awards: content.awards,
      }),
    );
    await r.listings.complete(
      input.listingId,
      {
        status: "in_review",
        versionId: version.id,
        idempotencyKey: input.operationKey,
      },
      audit,
      r.audit,
    );
    // Validate the actual FK-bound immutable version through the same downstream reader, inside the savepoint.
    const adopted = await readAdoptedWineDependencies(r, {
      workspaceId: input.workspaceId,
      listingId: input.listingId,
      versionId: version.id,
      inputRevision: source.input.revision,
    });
    if (adopted.status !== "available") throw Error(adopted.code);
    if (adopted.supports.some((s) => !s.valid))
      throw Error("proposal_support_incompatible");
    await r.audit.write({
      ...audit,
      action: "listing.wine_proposal_adopted",
      metadata: {
        runId: input.runId,
        versionId: version.id,
        selectedPaths: proof.selectedPaths,
        proposalContentDigest: proposal.contentDigest,
      },
    });
    return {
      versionId: version.id,
      runId: input.runId,
      inputRevision: source.input.revision,
    };
  });
}
