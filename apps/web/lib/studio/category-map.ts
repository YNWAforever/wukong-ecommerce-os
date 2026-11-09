import { z } from "zod";

import type { StudioCategorySuggestion } from "@wukong/ai";

import {
  translatedLine,
  translatedLineSchema,
  type TranslatedLine,
} from "./types";

/**
 * Category-map proposal artifact contract (C1).
 *
 * The payload is stored as a versioned `finding` artifact and is never applied:
 * the existing catalog flow remains the only place a person can change a
 * category. `currentCategory` is `null` when canonical listing content does not
 * carry a category (today it does not), and the limitations say so explicitly
 * instead of inventing a current mapping.
 */

export const categoryMapSuggestionSchema = z.strictObject({
  path: z.string().trim().min(1).max(300),
  /** Model confidence only; the deterministic slice has no suggestions. */
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(500).nullable(),
  /** Refs into the evidence pack; every ref must resolve at sanitisation. */
  evidenceRefs: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
});
export type CategoryMapSuggestion = z.infer<typeof categoryMapSuggestionSchema>;

export const categoryMapProposalPayloadSchema = z.strictObject({
  schemaVersion: z.literal("wukong-category-map/v1"),
  listingId: z.string().min(1).max(200),
  listingTitle: z.string().max(300),
  currentCategory: z.string().max(300).nullable(),
  suggestions: z.array(categoryMapSuggestionSchema).max(8),
  limitations: z.array(translatedLineSchema).max(10),
  asOf: z.string().min(1).max(64),
});
export type CategoryMapProposalPayload = z.infer<
  typeof categoryMapProposalPayloadSchema
>;

/** Deterministic facts the turn service needs to build the artifact. */
export type CategoryMapContext = {
  listingId: string;
  listingTitle: string;
  currentCategory: string | null;
  /** Catalog rows read for similar listings, as display-safe facts. */
  catalogEvidence: Array<{ ref: string; title: string; status: string }>;
  /** Every ref a model suggestion may cite (catalog rows + the listing). */
  allowedEvidenceRefs: string[];
};

export type SanitizedCategoryMap = {
  suggestions: CategoryMapSuggestion[];
  droppedCount: number;
};

/**
 * Grounding filter for model suggestions.
 *
 * Drops, and counts, anything that cannot be shown honestly: a blank path, a
 * confidence outside 0..1, an evidence ref that is not in the reviewed pack, a
 * duplicate path (case-insensitive), or a "suggestion" that equals the current
 * category. The remaining suggestions keep their original evidence refs.
 */
export function sanitizeCategorySuggestions(input: {
  proposed: readonly StudioCategorySuggestion[];
  allowedEvidenceRefs: readonly string[];
  currentCategory: string | null;
}): SanitizedCategoryMap {
  const allowed = new Set(input.allowedEvidenceRefs);
  const seen = new Set<string>();
  const current =
    input.currentCategory === null
      ? null
      : input.currentCategory.trim().toLocaleLowerCase("en");
  const suggestions: CategoryMapSuggestion[] = [];
  let droppedCount = 0;
  for (const suggestion of input.proposed) {
    const path = suggestion.path.trim();
    const key = path.toLocaleLowerCase("en");
    const valid =
      path.length > 0 &&
      path.length <= 300 &&
      Number.isFinite(suggestion.confidence) &&
      suggestion.confidence >= 0 &&
      suggestion.confidence <= 1 &&
      suggestion.evidenceRefs.length > 0 &&
      suggestion.evidenceRefs.every((ref) => allowed.has(ref)) &&
      !seen.has(key) &&
      (current === null || key !== current);
    if (!valid) {
      droppedCount += 1;
      continue;
    }
    seen.add(key);
    suggestions.push({
      path,
      confidence: suggestion.confidence,
      rationale: suggestion.rationale,
      evidenceRefs: [...suggestion.evidenceRefs],
    });
  }
  return { suggestions, droppedCount };
}

/** Why deterministic mode produced no suggestions, as copy lines. */
export function deterministicCategoryLimitations(input: {
  catalogUnavailable: boolean;
  listingUnavailable: boolean;
  currentCategory: string | null;
}): TranslatedLine[] {
  const limitations: TranslatedLine[] = [
    translatedLine("studio.limit.category_not_applied"),
  ];
  if (input.listingUnavailable)
    limitations.push(
      translatedLine("studio.limit.category_listing_unavailable"),
    );
  if (input.catalogUnavailable)
    limitations.push(
      translatedLine("studio.limit.category_catalog_unavailable"),
    );
  if (input.currentCategory === null)
    limitations.push(translatedLine("studio.limit.category_current_unknown"));
  limitations.push(translatedLine("studio.limit.category_model_unavailable"));
  return limitations;
}
