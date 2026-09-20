import { z } from "zod";
import {
  renderWineDescription,
  workingListingSchema,
  workingBaselineForReview,
  mergeWorkingCandidate,
  reviewableListingSchema,
  listingFactsSchema,
  workingFields,
  readWorkingField,
  wineTextPaths,
  type WorkingField,
  type ReviewableListing,
  type WineContent,
  type ProductIdentity,
  type SupportedClaim,
} from "@wukong/core";
import { listingInputDigest } from "./repositories/listing-inputs.js";
import type { ListingInputSnapshot } from "./repositories/listing-inputs.js";
import type { ListingOperation } from "./repositories/listing-operations.js";
import type { WineGenerationOwnership } from "./wine-generation-ownership.js";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const wineAdoptionProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalRunId: z.string().uuid(),
    proposalStageDigest: digest,
    proposalContentDigest: digest,
    sourceInputRevision: z.number().int().positive(),
    sourceInputDigest: digest,
    baseVersionId: z.string().uuid(),
    selectedPaths: z.array(z.string()).min(1).max(100),
    adoptedContentDigest: digest,
    operationKey: z.string().uuid(),
    requestDigest: digest,
    actorId: z.string().min(1),
    adoptedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (v) =>
      v.selectedPaths.every((p, i) => i === 0 || v.selectedPaths[i - 1]! < p),
    "Sorted unique selection required",
  );
export type WineAdoptionProof = z.infer<typeof wineAdoptionProofSchema>;
export function wineSectionContent(content: ReviewableListing): WineContent {
  return {
    title: content.title,
    seo: content.seo,
    tags: content.tags,
    sections: content.wineOwnership?.sections ?? [],
  };
}
/** Identical protected projection for Worker commit and later terminal proof reconstruction. */
export function projectWineContent(
  input: ListingInputSnapshot,
  base: ReviewableListing | undefined,
  run: ListingOperation,
  g: { content: WineContent },
  claims: SupportedClaim[],
  identity: ProductIdentity,
  ownership: Extract<WineGenerationOwnership, { status: "available" }>,
) {
  const baseline = workingBaselineForReview(
    workingListingSchema.parse(input.workingContent),
    input.fieldStates,
    base,
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
    String(run.execution.wineMode),
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
  return parsed;
}

export function wineAdoptionRequestDigest(c: {
  workspaceId: string;
  listingId: string;
  runId: string;
  actorId: string;
  expectedInputRevision: number;
  baseVersionId: string;
  selectedPaths: string[];
}) {
  return listingInputDigest({
    action: "adopt_wine_proposal",
    workspaceId: c.workspaceId,
    listingId: c.listingId,
    runId: c.runId,
    actorId: c.actorId,
    expectedInputRevision: c.expectedInputRevision,
    baseVersionId: c.baseVersionId,
    selectedPaths: [...c.selectedPaths].sort(),
  });
}
export const selectedWinePath = (selected: readonly string[], path: string) =>
  selected.some((p) => p === path || path.startsWith(p + "."));
const factualIdentityFields = [
  "producer",
  "productType",
  "country",
  "region",
  "vintage",
  "volumeMl",
  "packQuantity",
  "abvPercent",
] as const;
/** Server-only deterministic selection. Unknown/operator/merchant paths are never overridden. */
export function selectWineProposal(
  source: {
    input: ListingInputSnapshot;
    base: ReviewableListing;
    proposal: ReviewableListing;
    ownership: Extract<WineGenerationOwnership, { status: "available" }>;
  },
  selectedPaths: string[],
) {
  if (
    !selectedPaths.length ||
    selectedPaths.length > 100 ||
    new Set(selectedPaths).size !== selectedPaths.length
  )
    throw Error("proposal_selection_invalid");
  const baseline = workingBaselineForReview(
    workingListingSchema.parse(source.input.workingContent),
    source.input.fieldStates,
    source.base,
  );
  const next = structuredClone(baseline.workingContent);
  // Proof and request digest use sorted paths; newly added sections use that same canonical order.
  const paths = [...selectedPaths].sort();
  for (const path of paths) {
    if (
      source.ownership.lockedPaths.some(
        (p) => path === p || path.startsWith(p + "."),
      )
    )
      throw Error("proposal_path_protected");
    if (path.startsWith("sections.")) {
      const key = path.slice(9);
      if (key.includes(".")) throw Error("proposal_selection_invalid");
      const value = source.proposal.wineOwnership?.sections.find(
        (s) => s.key === key,
      );
      const old = next.wineOwnership?.sections.find((s) => s.key === key);
      if (!value || source.ownership.prior.kind === "legacy")
        throw Error("proposal_selection_invalid");
      if (old?.locked || old?.owner === "operator")
        throw Error("proposal_path_protected");
      next.wineOwnership ??= { schemaVersion: 1, sections: [] };
      const i = next.wineOwnership.sections.findIndex((s) => s.key === key);
      if (i < 0) next.wineOwnership.sections.push(structuredClone(value));
      else next.wineOwnership.sections[i] = structuredClone(value);
    } else {
      if (
        !workingFields.includes(path as WorkingField) ||
        ["sku", "priceHkd", "stockQuantity"].includes(path) ||
        path.startsWith("description.")
      )
        throw Error("proposal_selection_invalid");
      const state = baseline.fieldStates[path as WorkingField];
      if (state?.locked || state?.owner === "operator")
        throw Error("proposal_path_protected");
      const keys = path.split(".");
      let target = next as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1))
        target = target[key] as Record<string, unknown>;
      target[keys.at(-1)!] = structuredClone(
        readWorkingField(source.proposal, path as WorkingField),
      );
    }
  }
  if (paths.some((p) => p.startsWith("sections.")) && next.wineOwnership)
    next.description = {
      en: renderWineDescription(next.wineOwnership, "en"),
      "zh-Hant": renderWineDescription(next.wineOwnership, "zh-Hant"),
    };
  const parsed = reviewableListingSchema.parse(next);
  // Title paraphrases are copy, not factual-coordinate changes. Existing manual-edit reader still protects them.
  if (
    factualIdentityFields.some(
      (k) =>
        listingInputDigest(parsed[k]) !==
        listingInputDigest(baseline.workingContent[k]),
    )
  ) {
    // Unstructured legacy description is not represented by wineTextPaths; never retain it across identity changes.
    if (
      source.ownership.prior.kind === "legacy" &&
      Object.values(baseline.workingContent.description).some((text) =>
        text.trim(),
      )
    )
      throw Error("proposal_identity_retained_content");
    const old = wineSectionContent(
      reviewableListingSchema.parse(baseline.workingContent),
    );
    if (
      [...wineTextPaths(old)].some(
        ([path, text]) => text.trim() && !selectedWinePath(paths, path),
      )
    )
      throw Error("proposal_identity_retained_content");
  }
  return parsed;
}
