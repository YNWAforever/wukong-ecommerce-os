import { sameProductIdentity } from "./matched-enrichment.js";
import type {
  FieldObservation,
  ProductIdentity,
} from "./wine-enrichment-contracts.js";

export type IdentityMatch = {
  state: "matched" | "ambiguous" | "mismatch";
  reasons: string[];
};
/** Only supply aliases verified outside model output, scoped to a producer and canonical product. */
export type WineIdentityMatchContext = {
  verifiedAliases?: readonly {
    producer: string;
    canonicalName: string;
    alias: string;
  }[];
};
export function sameWineValue(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string")
    return sameProductIdentity(a, b);
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      a.every((value, index) => sameWineValue(value, b[index]))
    );
  return a === b;
}
export function matchWineIdentity(
  observed: ProductIdentity,
  candidate: ProductIdentity,
  context: WineIdentityMatchContext = {},
): IdentityMatch {
  const reasons: string[] = [];
  let mismatch = false;
  const conflict = (key: string) => {
    reasons.push(`${key}_conflict`);
    mismatch = true;
  };
  if (observed.kind !== candidate.kind) conflict("kind");
  for (const field of ["producer", "productName"] as const) {
    const a = observed[field],
      b = candidate[field];
    if (!a?.trim() || !b?.trim()) {
      reasons.push(`${field}_missing`);
      continue;
    }
    const alias =
      field === "productName" &&
      context.verifiedAliases?.some(
        (entry) =>
          observed.producer &&
          candidate.producer &&
          sameProductIdentity(entry.producer, observed.producer) &&
          sameProductIdentity(entry.producer, candidate.producer) &&
          ((sameProductIdentity(entry.canonicalName, a) &&
            sameProductIdentity(entry.alias, b)) ||
            (sameProductIdentity(entry.canonicalName, b) &&
              sameProductIdentity(entry.alias, a))),
      );
    if (!sameProductIdentity(a, b) && !alias) conflict(field);
  }
  if (observed.vintage.state !== "unknown") {
    if (candidate.vintage.state === "unknown") reasons.push("vintage_missing");
    else if (
      observed.vintage.state !== candidate.vintage.state ||
      observed.vintage.year !== candidate.vintage.year
    )
      conflict("vintage");
  }
  for (const field of [
    "cuvee",
    "volumeMl",
    "packQuantity",
    "marketVariant",
    "barcode",
    "abvPercent",
  ] as const) {
    const a = observed[field],
      b = candidate[field];
    if (a === null) continue;
    if (b === null) reasons.push(`${field}_missing`);
    else if (!sameWineValue(a, b)) conflict(field);
  }
  const categoryA = observed.category as Record<string, FieldObservation>,
    categoryB = candidate.category as Record<string, FieldObservation>;
  for (const [key, a] of Object.entries(categoryA)) {
    if (a.state === "unknown") continue;
    const b = categoryB[key];
    if (!b || b.state === "unknown") reasons.push(`${key}_missing`);
    else if (
      a.state === "not_applicable"
        ? b.state !== "not_applicable"
        : !sameWineValue(a.value, b.value)
    )
      conflict(key);
  }
  for (const identity of [observed, candidate]) {
    for (const [key, observation] of Object.entries({
      ...identity.observations,
      ...identity.category,
    })) {
      if (observation?.state === "conflict") reasons.push(`${key}_unresolved`);
    }
  }
  return {
    state: mismatch ? "mismatch" : reasons.length ? "ambiguous" : "matched",
    reasons: [...new Set(reasons)],
  };
}
