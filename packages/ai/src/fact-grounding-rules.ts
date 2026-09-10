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
  | "verbatim"
  | "normalized"
  | "classified"
  | "merchant";

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
 * Case folding, width folding, and accent stripping.
 *
 * NFKD normalizes full-width digits and decomposes accents; removing combining
 * marks then makes `Österreich` and `Osterreich` the same alias lookup. Matches
 * the folding `normalizedTokens` applies on the verbatim path.
 */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase();
}

/**
 * Every number an excerpt could be stating, including both readings when a
 * comma is ambiguous.
 *
 * `13,5` is thirteen-point-five in most of Europe. `1,500` is one thousand five
 * hundred in English. Rather than guess a locale off a bottle, both readings
 * become candidates: grounding accepts a value matching either, and a value
 * matching neither is still rejected.
 */
export function decimalCandidates(raw: string): number[] {
  const candidates = new Set<number>();
  const asDecimal = Number(raw.replace(",", "."));
  if (Number.isFinite(asDecimal)) candidates.add(asDecimal);
  const grouped = raw.split(",");
  if (grouped.length === 2 && grouped[1]?.length === 3) {
    const asThousands = Number(raw.replace(",", ""));
    if (Number.isFinite(asThousands)) candidates.add(asThousands);
  }
  return [...candidates];
}

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const BARE_NUMBER_PATTERN = new RegExp(NUMBER, "g");

/** Longest-first so `ml` is never matched as a bare `l`. */
const VOLUME_PATTERN = new RegExp(
  String.raw`(${NUMBER})\s*(millilitres?|milliliters?|centilitres?|centiliters?|decilitres?|deciliters?|litres?|liters?|ml|cl|dl|l)\b`,
  "gi",
);

const VOLUME_MULTIPLIERS = new Map<string, number>([
  ["ml", 1],
  ["millilitre", 1],
  ["millilitres", 1],
  ["milliliter", 1],
  ["milliliters", 1],
  ["cl", 10],
  ["centilitre", 10],
  ["centilitres", 10],
  ["centiliter", 10],
  ["centiliters", 10],
  ["dl", 100],
  ["decilitre", 100],
  ["decilitres", 100],
  ["deciliter", 100],
  ["deciliters", 100],
  ["l", 1_000],
  ["litre", 1_000],
  ["litres", 1_000],
  ["liter", 1_000],
  ["liters", 1_000],
]);

/** Millilitre readings of an excerpt, from any labelled volume unit. */
export function volumeMlCandidates(excerpt: string): number[] {
  const folded = fold(excerpt);
  const candidates = new Set<number>();
  for (const match of folded.matchAll(VOLUME_PATTERN)) {
    const amount = match[1];
    const unit = match[2];
    if (amount === undefined || unit === undefined) continue;
    const multiplier = VOLUME_MULTIPLIERS.get(unit);
    if (multiplier === undefined) continue;
    for (const value of decimalCandidates(amount)) {
      const millilitres = value * multiplier;
      // A conversion must land on a whole millilitre; volumeMl is an integer.
      if (Number.isInteger(millilitres)) candidates.add(millilitres);
    }
  }
  // An unlabelled number on a volume field is already millilitres.
  for (const match of folded.matchAll(BARE_NUMBER_PATTERN)) {
    for (const value of decimalCandidates(match[0])) {
      if (Number.isInteger(value)) candidates.add(value);
    }
  }
  return [...candidates];
}

/** Every numeric reading of an excerpt, for plain numeric facts. */
export function numberCandidates(excerpt: string): number[] {
  const candidates = new Set<number>();
  for (const match of fold(excerpt).matchAll(BARE_NUMBER_PATTERN)) {
    for (const value of decimalCandidates(match[0])) candidates.add(value);
  }
  return [...candidates];
}

/**
 * Country names as they are actually printed, mapped to the English name the
 * schema stores. Deliberately a closed table: an alias that is not listed falls
 * back to verbatim matching, so an unknown language behaves exactly as it did
 * before rather than being guessed at.
 */
const COUNTRY_ALIASES = new Map<string, string>(
  Object.entries({
    // Traditional and Simplified Chinese, as printed for the HK market.
    法國: "France",
    法国: "France",
    義大利: "Italy",
    意大利: "Italy",
    西班牙: "Spain",
    德國: "Germany",
    德国: "Germany",
    葡萄牙: "Portugal",
    美國: "United States",
    美国: "United States",
    澳洲: "Australia",
    澳大利亞: "Australia",
    澳大利亚: "Australia",
    紐西蘭: "New Zealand",
    新西蘭: "New Zealand",
    智利: "Chile",
    阿根廷: "Argentina",
    南非: "South Africa",
    日本: "Japan",
    蘇格蘭: "Scotland",
    英國: "United Kingdom",
    奧地利: "Austria",
    匈牙利: "Hungary",
    希臘: "Greece",
    // Endonyms and neighbouring-language forms found on European labels.
    france: "France",
    frankreich: "France",
    francia: "France",
    italia: "Italy",
    italie: "Italy",
    italien: "Italy",
    españa: "Spain",
    espana: "Spain",
    espagne: "Spain",
    deutschland: "Germany",
    allemagne: "Germany",
    alemania: "Germany",
    portugal: "Portugal",
    österreich: "Austria",
    osterreich: "Austria",
    nippon: "Japan",
    chile: "Chile",
    argentina: "Argentina",
  }),
);

/** English country names an excerpt could be stating in another language. */
export function countryCandidates(excerpt: string): string[] {
  const folded = fold(excerpt);
  const candidates = new Set<string>();
  for (const [alias, canonical] of COUNTRY_ALIASES) {
    if (folded.includes(fold(alias))) candidates.add(canonical);
  }
  return [...candidates];
}

/**
 * Whether a declared normalization rule derives `value` from `excerpt`.
 *
 * Returns false for keys with no rule, so the caller falls back to verbatim
 * matching and nothing is silently waved through.
 */
export function normalizationSupportsValue(
  key: keyof ListingFacts,
  excerpt: string,
  value: unknown,
): boolean {
  switch (key) {
    case "volumeMl":
      return (
        typeof value === "number" && volumeMlCandidates(excerpt).includes(value)
      );
    case "abvPercent":
    case "vintage":
    case "packQuantity":
      return (
        typeof value === "number" && numberCandidates(excerpt).includes(value)
      );
    case "country":
      return (
        typeof value === "string" &&
        countryCandidates(excerpt).some(
          (candidate) => fold(candidate) === fold(value),
        )
      );
    default:
      return false;
  }
}
