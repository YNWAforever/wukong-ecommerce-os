import type { ProductIdentity } from "@wukong/core";
import { ProviderOutputError } from "./listing-provider-errors.js";
import type {
  WineFrozenContext,
  WineSupportProposal,
} from "./wine-enrichment-schemas.js";
export function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ProviderOutputError(message);
}
export function unique(ids: string[], label: string) {
  requireValue(new Set(ids).size === ids.length, `Duplicate ${label}`);
}
export function references(ids: string[], allowed: Set<string>) {
  unique(ids, "references");
  requireValue(
    ids.every((id) => allowed.has(id)),
    "Unknown wine reference",
  );
}
export function identityReferences(
  identity: ProductIdentity,
  allowed: Set<string>,
) {
  for (const item of [
    ...Object.values(identity.observations),
    ...Object.values(identity.category),
  ])
    if (item) references(item.evidenceIds, allowed);
}
// Parse whole numeric tokens rather than interpolating model values into a regexp.
// Decimal commas are decimals; locale-dependent grouped thousands are not inferred.
const decimalToken = String.raw`[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)`;
const numberToken = new RegExp(
  String.raw`(?<![\p{L}\p{N}.,/⁄+-])(${decimalToken}(?:\s*[/⁄]\s*${decimalToken})?)(?![\p{N}.,/⁄])`,
  "gu",
);
const volumeUnit =
  /^\s*(millilitres?|milliliters?|centilitres?|centiliters?|decilitres?|deciliters?|litres?|liters?|ml|cl|dl|l)\b|^\s*(毫升|厘升|公升|升)/i;
function wineNumericValueSupported(
  field: string,
  span: string,
  value: number,
): boolean {
  if (!Number.isFinite(value)) return false;
  // Mixed fractions need a separate grammar; never read only their fractional part.
  if (/\d\s*[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/u.test(span)) return false;
  const normalized = span.normalize("NFKC");
  if (/\d\s+\d+\s*[/⁄]/u.test(normalized)) return false;
  const readings = [...normalized.matchAll(numberToken)].flatMap((match) => {
    const parts = match[1]!
      .split(/[/⁄]/)
      .map((part) => Number(part.trim().replace(",", ".")));
    const amount = parts.length === 2 ? parts[0]! / parts[1]! : parts[0]!;
    if (!Number.isFinite(amount)) return [];
    const suffix = normalized.slice(match.index! + match[0].length);
    const unitMatch = suffix.match(volumeUnit);
    const unit = (unitMatch?.[1] ?? unitMatch?.[2])?.toLowerCase();
    const multiplier =
      unit === undefined
        ? null
        : /^(ml|millilit|毫升)/.test(unit)
          ? 1
          : /^(cl|centilit|厘升)/.test(unit)
            ? 10
            : /^(dl|decilit)/.test(unit)
              ? 100
              : 1000;
    return [{ amount, multiplier, suffix }];
  });
  const equal = (reading: number) =>
    Math.abs(reading - value) <=
    Number.EPSILON * Math.max(1, Math.abs(reading), Math.abs(value)) * 4;
  if (field === "volumeMl") {
    const explicit = readings.filter((reading) => reading.multiplier !== null);
    if (explicit.length)
      return explicit.some((reading) =>
        equal(reading.amount * reading.multiplier!),
      );
    // Unknown explicit units must not fall back to a bare millilitre interpretation.
    return readings.some(
      (reading) =>
        !/^\s*[\p{L}%]/u.test(reading.suffix) && equal(reading.amount),
    );
  }
  if (
    ![
      "abvPercent",
      "vintage",
      "packQuantity",
      "ageYears",
      "polishingPercent",
      "brewingYear",
    ].includes(field)
  )
    return false;
  return readings.some((reading) => equal(reading.amount));
}
/** Mechanical proposal checks only: containment/value normalization is NOT semantic field association.
 * Task 8 may independently approve a labelled field parser match; unconstrained associations
 * must stay proposals/unknown or require review, never be copied into trusted supports. */
export function validateWineSupportProposal(
  proposal: WineSupportProposal,
  sources: WineFrozenContext["sources"],
): void {
  const matches = sources.filter((s) => s.id === proposal.sourceId);
  requireValue(matches.length === 1, "Unknown support source");
  const source = matches[0]!;
  requireValue(source.excerpt.includes(proposal.span), "Unknown support span");
  const fold = (v: string) =>
    v.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const values = Array.isArray(proposal.value)
    ? proposal.value
    : [proposal.value];
  for (const value of values)
    requireValue(
      typeof value === "number"
        ? wineNumericValueSupported(proposal.field, proposal.span, value)
        : !!fold(value) && fold(proposal.span).includes(fold(value)),
      "Unsupported span value",
    );
}
