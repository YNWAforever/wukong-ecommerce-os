import {
  fieldEvidenceSchema,
  listingFactsSchema,
  reviewableListingSchema,
  workspaceProfileSchema,
  type FieldEvidence,
  type ListingFacts,
} from "@wukong/core";
import { z } from "zod";

import { NOTE_SOURCE_ID, type GenerationInput } from "./contracts.js";
import {
  FACT_GROUNDING_MODES,
  factsSufficientForGeneration,
  normalizationSupportsValue,
} from "./fact-grounding-rules.js";
import { ProviderOutputError } from "./listing-provider-errors.js";

const FACT_KEY_NAMES = Object.keys(listingFactsSchema.shape) as [
  string,
  ...string[],
];

/**
 * Evidence as the MODEL must produce it.
 *
 * `fieldEvidenceSchema.field` is a free string, because stored rows are read
 * back with it and a historical row may name anything. But `assertFactsGrounded`
 * rejects any evidence naming something outside the fact keys, and nothing ever
 * told the model what those keys were -- so a model that wrote the natural word
 * `abv` or `volume` instead of `abvPercent` or `volumeMl` failed validation, and
 * the correctly-named fact was then left with no evidence and failed too.
 *
 * Constraining the field here puts the allowed names into the structured-output
 * schema the provider sends, so the model cannot guess wrong in the first place.
 * Reads keep the permissive schema.
 */
const modelFieldEvidenceSchema = fieldEvidenceSchema.extend({
  field: z.enum(FACT_KEY_NAMES),
});

export const extractionOutputSchema = z.object({
  facts: listingFactsSchema,
  evidence: z.array(modelFieldEvidenceSchema),
  missingFields: z.array(z.string()),
});

/**
 * Generation output is REVIEWABLE, not canonical.
 *
 * A photo-only draft legitimately has no SKU, price or stock -- those are
 * merchant data the model may not read off a label -- so requiring canonical
 * here rejected exactly the output the pipeline was asked to produce.
 * Completeness is enforced at `requireForPublish`, on the way out.
 */
export const generationOutputSchema = z.object({
  listing: reviewableListingSchema,
});

export const generationInputRuntimeSchema = z.object({
  facts: listingFactsSchema,
  evidence: z.array(fieldEvidenceSchema),
  profile: workspaceProfileSchema,
  imageAssetIds: z.array(z.string().min(1)),
});

export const FACT_KEYS = Object.keys(listingFactsSchema.shape) as Array<
  keyof ListingFacts
>;
const MAX_EVIDENCE_EXCERPT_LENGTH = 500;
function normalizedTokens(value: string): string[] {
  return (
    value
      // NFKD then strip combining marks, so an accent is not the difference
      // between grounded and rejected. NFKC alone COMPOSES accents, so a model
      // transcribing "CHÂTEAU MARGAUX" as "Chateau Margaux" -- which is how the
      // name is usually typed -- failed the token compare even though case
      // folding was already handled. Two genuinely different words still differ
      // after folding, so this widens nothing else.
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function excerptContainsExactTerm(excerpt: string, expected: string): boolean {
  const expectedTokens = normalizedTokens(expected);
  if (expectedTokens.length === 0) return false;
  const excerptTokens = normalizedTokens(excerpt);
  return excerptTokens.some((_, start) =>
    expectedTokens.every(
      (token, offset) => excerptTokens[start + offset] === token,
    ),
  );
}

function excerptContainsNumber(excerpt: string, expected: number): boolean {
  const values = excerpt.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return values.some((value) => Number.isFinite(value) && value === expected);
}

function excerptSupportsValue(excerpt: string, value: unknown): boolean {
  if (typeof value === "string")
    return excerptContainsExactTerm(excerpt, value);
  if (typeof value === "number") return excerptContainsNumber(excerpt, value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.every((item) => excerptContainsExactTerm(excerpt, item));
  }
  return false;
}

/**
 * Whether the evidence for one field supports its value, either by quoting it
 * or by stating it in a form a declared normalization rule converts.
 *
 * The rule is consulted only after a verbatim match fails, so normalization can
 * widen what grounds but never narrow it.
 */
function evidenceSupportsValue(
  key: keyof ListingFacts,
  evidence: FieldEvidence[],
  value: unknown,
): boolean {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.every((item) =>
      evidence.some((entry) => excerptSupportsValue(entry.excerpt, item)),
    );
  }
  return evidence.some(
    (entry) =>
      excerptSupportsValue(entry.excerpt, value) ||
      normalizationSupportsValue(key, entry.excerpt, value),
  );
}

function isMeaningfulFact(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    (!Array.isArray(value) || value.length > 0)
  );
}

function assertComplexFactEvidence(
  key: "criticScores" | "awards",
  value: ListingFacts[typeof key],
  evidenceForField: FieldEvidence[],
  allowedSources?: Set<string>,
): void {
  for (const item of value) {
    const evidenceId = item.evidenceId;
    if (allowedSources && !allowedSources.has(evidenceId)) {
      throw new ProviderOutputError("AI claim referenced an unknown source");
    }
    const supporting = evidenceForField.filter(
      (entry) => entry.sourceAssetId === evidenceId,
    );
    const terms =
      key === "criticScores"
        ? (() => {
            const score = item as ListingFacts["criticScores"][number];
            return [score.source, score.score];
          })()
        : [(item as ListingFacts["awards"][number]).name];
    if (
      !supporting.some((entry) =>
        terms.every((term) => excerptSupportsValue(entry.excerpt, term)),
      )
    ) {
      throw new ProviderOutputError(
        "AI claim evidence did not support its value",
      );
    }
  }
}

export function assertFactsGrounded(
  facts: ListingFacts,
  evidence: FieldEvidence[],
  options: { allowedSources?: Set<string>; note?: string | null } = {},
): void {
  for (const item of evidence) {
    if (item.excerpt.length > MAX_EVIDENCE_EXCERPT_LENGTH) {
      throw new ProviderOutputError(
        "AI evidence excerpt exceeded the allowed bound",
      );
    }
    if (
      options.allowedSources &&
      !options.allowedSources.has(item.sourceAssetId)
    ) {
      throw new ProviderOutputError("AI evidence referenced an unknown source");
    }
    if (
      item.sourceAssetId === NOTE_SOURCE_ID &&
      options.note !== undefined &&
      !(options.note ?? "").includes(item.excerpt)
    ) {
      throw new ProviderOutputError(
        "AI evidence was not present in the supplied note",
      );
    }
    if (!FACT_KEYS.includes(item.field as keyof ListingFacts)) {
      throw new ProviderOutputError("AI evidence referenced an unknown field");
    }
    const value = facts[item.field as keyof ListingFacts];
    if (!isMeaningfulFact(value)) {
      throw new ProviderOutputError("AI evidence referenced an absent fact");
    }
  }

  for (const key of FACT_KEYS) {
    const value = facts[key];
    if (!isMeaningfulFact(value)) continue;
    const evidenceForField = evidence.filter((item) => item.field === key);
    const isSystemDefault =
      key === "packQuantity" && value === 1 && evidenceForField.length === 0;
    if (evidenceForField.length === 0 && !isSystemDefault) {
      throw new ProviderOutputError("AI fact had no supporting evidence");
    }
    if (isSystemDefault) continue;
    if (key === "criticScores" || key === "awards") {
      assertComplexFactEvidence(
        key,
        value as ListingFacts[typeof key],
        evidenceForField,
        options.allowedSources,
      );
      continue;
    }

    const mode = FACT_GROUNDING_MODES[key];

    // A judgement over the source rather than a quote from it. Evidence still
    // has to exist -- that is checked above -- but a four-value enum has no
    // verbatim form on a label that never spells it out.
    if (mode === "classified") continue;

    // SKU, price and stock describe the merchant's business, not the bottle.
    // Reading them off a photograph is a guess, so only the operator-supplied
    // note can carry them.
    const supporting =
      mode === "merchant"
        ? evidenceForField.filter(
            (item) => item.sourceAssetId === NOTE_SOURCE_ID,
          )
        : evidenceForField;
    if (supporting.length === 0) {
      throw new ProviderOutputError(
        "AI read merchant data from a source that cannot state it",
      );
    }

    if (!evidenceSupportsValue(key, supporting, value)) {
      throw new ProviderOutputError(
        "AI evidence did not support its fact value",
      );
    }
  }
}

export function assertGenerationGrounding(
  listing: z.infer<typeof reviewableListingSchema>,
  input: GenerationInput,
): void {
  for (const key of FACT_KEYS) {
    if (JSON.stringify(listing[key]) !== JSON.stringify(input.facts[key])) {
      throw new ProviderOutputError("AI generation changed a protected fact");
    }
  }
  if (
    JSON.stringify(listing.imageAssetIds) !==
    JSON.stringify(input.imageAssetIds)
  ) {
    throw new ProviderOutputError(
      "AI generation changed supplied image assets",
    );
  }
}

/**
 * A grounded fallback listing built only from the facts that are present.
 *
 * It used to demand seven non-null facts and throw `Safe generation requires
 * sku` otherwise. Three of those -- sku, priceHkd, stockQuantity -- are merchant
 * data the AI is forbidden to read off a photograph in the first place, so a
 * photo-only draft could never satisfy it, and the four that a label does carry
 * are not all printed on every label either.
 *
 * Now only the product's identity is required (GENERATION_REQUIRED_FACTS), and
 * every optional clause is omitted when its fact is absent rather than being
 * rendered as `Volume: null ml`. That is what a person writing the same listing
 * from the same label would do: say what is known and stop.
 */
export function buildSafeListing(
  input: GenerationInput,
): z.infer<typeof reviewableListingSchema> {
  const facts = input.facts;
  if (!factsSufficientForGeneration(facts)) {
    throw new ProviderOutputError(
      "Safe generation requires an identifiable product",
    );
  }

  const title = `${facts.producer}${facts.vintage === null ? "" : ` ${facts.vintage}`}`;
  const origin = [facts.region, facts.country]
    .filter((value): value is string => value !== null)
    .join(", ");

  const clausesEn = [
    `${facts.producer}.`,
    facts.productType === null ? null : `Product type: ${facts.productType}.`,
    origin === "" ? null : `Origin: ${origin}.`,
    facts.vintage === null ? null : `Vintage: ${facts.vintage}.`,
    facts.grapeVarieties.length === 0
      ? null
      : `Grape: ${facts.grapeVarieties.join(", ")}.`,
    facts.volumeMl === null ? null : `Volume: ${facts.volumeMl} ml.`,
    facts.abvPercent === null ? null : `ABV: ${facts.abvPercent}%.`,
  ].filter((value): value is string => value !== null);

  const typeZh =
    facts.productType === null
      ? null
      : { wine: "葡萄酒", spirits: "烈酒", sake: "清酒", other: "其他" }[
          facts.productType
        ];
  const clausesZh = [
    `${facts.producer}。`,
    typeZh === null ? null : `產品類型：${typeZh}。`,
    origin === "" ? null : `產地：${origin}。`,
    facts.vintage === null ? null : `年份：${facts.vintage}。`,
    facts.grapeVarieties.length === 0
      ? null
      : `葡萄品種：${facts.grapeVarieties.join("、")}。`,
    facts.volumeMl === null ? null : `容量：${facts.volumeMl}毫升。`,
    facts.abvPercent === null ? null : `酒精濃度：${facts.abvPercent}%。`,
  ].filter((value): value is string => value !== null);

  const descriptionEn = clausesEn.join(" ");
  const descriptionZh = clausesZh.join("");
  const tags = [
    facts.productType,
    facts.country,
    facts.region,
    facts.vintage === null ? null : String(facts.vintage),
    ...facts.grapeVarieties,
  ].filter((value): value is string => value !== null);

  return reviewableListingSchema.parse({
    ...facts,
    title: { en: title, "zh-Hant": title },
    description: { en: descriptionEn, "zh-Hant": descriptionZh },
    seo: {
      title: { en: title, "zh-Hant": title },
      description: { en: descriptionEn, "zh-Hant": descriptionZh },
    },
    tags,
    imageAssetIds: input.imageAssetIds,
  });
}
