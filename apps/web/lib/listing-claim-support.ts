import {
  claimIdentitySnapshot,
  enrichmentIdentitySchema,
  savedMarketVariant,
  sameProductIdentity,
  complianceCopyField,
  externalClaimSchema,
  externalClaimSourceSchema,
  evaluateExternalClaimSupport,
  renderExternalClaim,
  readWorkingField,
  claimCopyFields,
  type ClaimCopyField,
} from "@wukong/core";
import { listingInputDigest, type WorkspaceRepositories } from "@wukong/db";
export async function readCopyClaimSupports(
  repos: Pick<WorkspaceRepositories, "listingEnrichment" | "listingInputs">,
  listingId: string,
  content: Record<string, unknown>,
) {
  if (
    !repos.listingEnrichment?.claimSupportReady ||
    !(await repos.listingEnrichment.claimSupportReady())
  )
    return [];
  const input = await repos.listingInputs.getCurrent(listingId);
  if (!input) return [];
  const rows = await repos.listingEnrichment.claimSupports(listingId);
  return rows.map((row) => {
    const p = row.payload as Record<string, any>,
      field = p.copyField as ClaimCopyField,
      claim = externalClaimSchema.safeParse(p.claim);
    const validField = claimCopyFields.includes(field);
    const manual =
      p.claim?.kind === "manual" &&
      typeof p.claim.text === "string" &&
      p.claim.text.length > 0 &&
      p.claim.text.length <= 500 &&
      p.claimText === p.claim.text &&
      typeof p.manualReason === "string" &&
      p.manualReason.length >= 20 &&
      externalClaimSourceSchema.safeParse(p.source).success;
    const supported =
      claim.success &&
      evaluateExternalClaimSupport(claim.data, {
        claim: claim.data,
        source: p.source,
        match: "matched",
      }).status === "supported";
    const sourceIdentity = enrichmentIdentitySchema.safeParse(
      row.matched_identity ?? (claim.success ? claim.data.product : undefined),
    );
    const savedTitle = (content.title as { en?: string } | undefined)?.en ?? "",
      variant = savedMarketVariant(input.note);
    const identityMatches =
      sourceIdentity.success &&
      variant !== null &&
      sameProductIdentity(savedTitle, sourceIdentity.data.productName) &&
      sameProductIdentity(variant, sourceIdentity.data.marketVariant);
    const valid =
      identityMatches &&
      validField &&
      (manual ||
        (supported &&
          p.claimText ===
            renderExternalClaim(
              claim.data!,
              field.endsWith("zh-Hant") ? "zh-Hant" : "en",
            ))) &&
      !row.invalidated &&
      !row.rejected &&
      p.copyText === readWorkingField(content as never, field) &&
      listingInputDigest(p.identitySnapshot) ===
        listingInputDigest(claimIdentitySnapshot(content)) &&
      listingInputDigest(p.sourceSnapshot) ===
        listingInputDigest({ note: input.note, sources: input.sources });
    return {
      kind: manual ? ("manual" as const) : ("external" as const),
      actorId: String(row.actor_id),
      createdAt: String(row.created_at),
      manualReason: manual ? String(p.manualReason) : null,
      id: String(row.id),
      suggestionId: String(row.suggestion_id),
      inputRevision: Number(row.input_revision),
      copyField: field,
      field: complianceCopyField[field],
      text: String(p.claimText ?? ""),
      valid: Boolean(valid),
      source: p.source,
      claim: p.claim,
    };
  });
}
