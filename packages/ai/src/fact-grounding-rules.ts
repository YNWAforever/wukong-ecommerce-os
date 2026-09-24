/**
 * How each fact may be tied back to its source.
 *
 * Grounding exists to stop the model inventing facts. Requiring every value to
 * appear verbatim inside its own evidence excerpt is a poor proxy for that: it
 * passes for a synthetic note that restates each value, and fails for a
 * photographed label, where the correct value is routinely a conversion
 * (`75 cl` -> 750), a translation (`法國` -> France) or a classification
 * (a Bordeaux label -> productType "wine"). Those rejections are what
 * `listing-output-validation.grounding.test.ts` reproduces.
 *
 * So each fact declares HOW it may be grounded instead:
 *
 * - `verbatim`   the value must appear in an excerpt (proper nouns off a label)
 * - `normalized` verbatim, OR derivable from an excerpt by a rule in this file
 * - `classified` a judgement over the source; evidence must exist, but it is
 *                not required to restate the value
 * - `merchant`   commercial data the AI must never read off a photo; evidence
 *                must come from the operator-supplied note
 *
 * `normalized` and `classified` are strictly more permissive than verbatim, so
 * nothing that grounded before stops grounding now. `merchant` is deliberately
 * stricter: a price, stock level or SKU inferred from a bottle is a guess about
 * the merchant's own business, and is rejected rather than saved.
 *
 * Every rule here is deterministic and total -- no model call, no network -- so
 * a wrong value is still rejected. The original text is never rewritten; these
 * functions only decide whether an excerpt SUPPORTS a value.
 */
import type { ListingFacts } from "@wukong/core";

export type GroundingMode =
  "verbatim" | "normalized" | "classified" | "merchant";

export const FACT_GROUNDING_MODES: Record<keyof ListingFacts, GroundingMode> = {
  // Commercial data. Only the merchant knows these; a label cannot state them.
  sku: "merchant",
  priceHkd: "merchant",
  stockQuantity: "merchant",

  // Printed on the label as-is.
  producer: "verbatim",
  region: "verbatim",
  grapeVarieties: "verbatim",

  // Printed, but in units, languages or formats the schema does not use.
  country: "normalized",
  vintage: "normalized",
  volumeMl: "normalized",
  abvPercent: "normalized",
  packQuantity: "normalized",

  // A four-value enum. No label prints "wine"; it prints an appellation.
  productType: "classified",

  // Structured claims, checked item-by-item by assertComplexFactEvidence.
  criticScores: "verbatim",
  awards: "verbatim",
};

/**
 * The facts without which no honest copy can be written.
 *
 * Deliberately just the product's identity. Everything else -- region, vintage,
 * volume, ABV, grapes -- makes the copy better when present and is simply left
 * out when absent, which is what a person writing the same listing would do.
 *
 * SKU, price and stock are NOT here, and that is the point. They are merchant
 * data (see FACT_GROUNDING_MODES), so waiting on them used to strand the whole
 * draft even though none of them appears in a title or a description.
 */
export const GENERATION_REQUIRED_FACTS = ["producer"] as const;

/**
 * Whether these facts identify a product well enough to write about it.
 *
 * Separate from `missingFields`, which stays a full list of everything absent so
 * the screen can tell an operator what is still outstanding. Being missing and
 * being blocking are different questions, and conflating them is what sent a
 * perfectly usable extraction to `needs_info` for want of a region.
 */
export function factsSufficientForGeneration(
  facts: Pick<ListingFacts, (typeof GENERATION_REQUIRED_FACTS)[number]>,
): boolean {
  return GENERATION_REQUIRED_FACTS.every((key) => {
    const value = facts[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

export {
  decimalCandidates,
  volumeMlCandidates,
  numberCandidates,
  countryCandidates,
  normalizationSupportsValue,
} from "@wukong/core";
