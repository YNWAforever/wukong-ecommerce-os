/** Invalid mechanical artifact input; parsing alone does not authorize its use. */
export class WineArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WineArtifactValidationError";
  }
}
export function requireWineValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new WineArtifactValidationError(message);
}
export function uniqueWineIds(ids: string[], label: string) {
  requireWineValue(new Set(ids).size === ids.length, `Duplicate ${label}`);
}
export function requireWineReferences(ids: string[], allowed: Set<string>) {
  uniqueWineIds(ids, "references");
  requireWineValue(
    ids.every((id) => allowed.has(id)),
    "Unknown wine reference",
  );
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
export function wineNumericValueSupported(
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
