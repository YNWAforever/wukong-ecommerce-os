import { normalizationSupportsValue } from "./fact-normalization.js";
import type { ListingFacts } from "./listing-schema.js";
import { sameProductIdentity } from "./matched-enrichment.js";
import {
  supportedClaimSchema,
  type EvidenceSource,
  type FieldObservation,
  type ProductIdentity,
  type SupportedClaim,
  type Vintage,
} from "./wine-enrichment-contracts.js";
import {
  matchWineIdentity,
  sameWineValue,
  type WineIdentityMatchContext,
} from "./wine-identity-match.js";
import {
  resolveWineSourceAuthority,
  type WineSourceAuthority,
} from "./wine-source-authority.js";

/** Verified field/span bindings from the verification boundary, not arbitrary evidence IDs supplied by generation. */
export type WineClaimSupport = {
  sourceId: string;
  field: SupportedClaim["field"];
  value: SupportedClaim["value"];
  span: string;
  originalAuthority?: string;
  applicableVintage?: Vintage;
};
/** All trust sets are produced by server policy/review, never copied from model output.
 * acceptedPremises must be adjudicated for this same identity/input version.
 * Missing context fails closed. Persist the snapshot with the operation for replay.
 */
export type WineClaimContext = WineIdentityMatchContext & {
  now?: string;
  authorities?: readonly WineSourceAuthority[];
  supports?: readonly WineClaimSupport[];
  reliableSourceIds?: ReadonlySet<string>;
  trustedObservationSourceIds?: ReadonlySet<string>;
  acceptedPremises?: readonly SupportedClaim[];
};
const merchantFields = new Set([
  "sku",
  "priceHkd",
  "stockQuantity",
  "price",
  "stock",
  "internalSku",
]);
const originalAuthorityFields = new Set([
  "criticScores",
  "awards",
  "drinkingWindow",
]);
const brandFields = new Set(["producer", "brand_background"]);
const recommendationFields = new Set(["pairing", "serving"]);
function supportsValue(
  support: WineClaimSupport,
  source: EvidenceSource,
): boolean {
  if (!support.span.trim() || !source.excerpt.includes(support.span))
    return false;
  if (typeof support.value === "number")
    return (
      normalizationSupportsValue(
        support.field as keyof ListingFacts,
        support.span,
        support.value,
      ) ||
      (new Set(["ageYears", "polishingPercent", "brewingYear"]).has(
        support.field,
      ) &&
        new RegExp(`(^|[^\\d.])${support.value}(?![\\d.])`).test(support.span))
    );
  const fold = (value: string) =>
    value
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase("en-US");
  const span = fold(support.span);
  return (Array.isArray(support.value) ? support.value : [support.value]).every(
    (value) => value.trim().length > 0 && span.includes(fold(value)),
  );
}
function observedValue(
  identity: ProductIdentity,
  field: string,
): FieldObservation | undefined {
  return (
    (identity.observations as Record<string, FieldObservation>)[field] ??
    (identity.category as Record<string, FieldObservation>)[field]
  );
}
/** A specification being checked may disagree; do not erase product discriminators to manufacture a match. */
function identityForClaim(
  identity: ProductIdentity,
  field: string,
): ProductIdentity {
  if (field !== "abvPercent") return identity;
  const observations = { ...identity.observations };
  delete observations.abvPercent;
  return { ...identity, abvPercent: null, observations };
}
function independent(a: EvidenceSource, b: EvidenceSource): boolean {
  // Comparing exact normalized excerpts is stronger than comparing caller-provided hashes.
  const excerpt = (source: EvidenceSource) =>
    source.excerpt.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return (
    a.id !== b.id &&
    a.domain !== b.domain &&
    a.independenceKey !== b.independenceKey &&
    a.documentDigest !== b.documentDigest &&
    excerpt(a) !== excerpt(b)
  );
}
export type WineClaimInput = {
  identity: ProductIdentity;
  claim: SupportedClaim;
  sources: EvidenceSource[];
  lockedFields: ReadonlySet<string>;
  context?: WineClaimContext;
};
export function decideWineClaim(input: WineClaimInput): SupportedClaim {
  return adjudicate(input, true);
}
function adjudicate(
  input: WineClaimInput,
  checkContradictions: boolean,
): SupportedClaim {
  const { identity, claim, sources, lockedFields } = input,
    context = input.context;
  const result = (
    state: SupportedClaim["state"],
    reason: string,
  ): SupportedClaim => ({ ...claim, state, reason });
  if (lockedFields.has(claim.field))
    return result("rejected", "operator_locked");
  if (merchantFields.has(claim.field))
    return result("rejected", "merchant_only");
  if (!supportedClaimSchema.safeParse({ ...claim, state: "unknown" }).success)
    return result("rejected", "invalid_claim");
  if (!context) return result("unknown", "missing_adjudication_context");
  if (claim.kind === "recommendation") {
    if (claim.scope !== "product")
      return result("rejected", "invalid_recommendation_scope");
    if (!recommendationFields.has(claim.field))
      return result("rejected", "invalid_recommendation_field");
    const premises = claim.premiseClaimIds.map(
      (id) => context.acceptedPremises?.filter((item) => item.id === id) ?? [],
    );
    if (
      !premises.length ||
      premises.some(
        (items) =>
          items.length !== 1 ||
          items[0]!.id === claim.id ||
          items[0]!.scope !== "product" ||
          items[0]!.kind !== "fact" ||
          items[0]!.state !== "accepted" ||
          !items[0]!.evidenceIds.length,
      )
    )
      return result("unknown", "unresolved_factual_premises");
    const evidenceIds: string[] = [];
    for (const [premise] of premises) {
      // Premises are already adjudicated in this operation. Resolve their actual
      // source records again before deriving citations; generation's citations
      // are deliberately discarded.
      for (const id of premise!.evidenceIds) {
        const records = sources.filter((source) => source.id === id);
        const sourceIdentity = records[0]?.identity;
        if (
          records.length !== 1 ||
          !sourceIdentity ||
          matchWineIdentity(
            identityForClaim(identity, premise!.field),
            identityForClaim(sourceIdentity, premise!.field),
            context,
          ).state !== "matched"
        )
          return result("unknown", "unresolved_premise_evidence");
        evidenceIds.push(id);
      }
    }
    return {
      ...result("accepted", "grounded_recommendation"),
      evidenceIds: [...new Set(evidenceIds)],
    };
  }
  if (claim.scope === "brand" && !brandFields.has(claim.field))
    return result("rejected", "invalid_brand_scope");
  if (!claim.evidenceIds.length) return result("unknown", "missing_evidence");
  const selected = claim.evidenceIds.map((id) =>
    sources.filter((source) => source.id === id),
  );
  if (
    new Set(claim.evidenceIds).size !== claim.evidenceIds.length ||
    selected.some((items) => items.length !== 1)
  )
    return result("unknown", "missing_or_duplicate_source");
  let incomplete = false,
    trustedButInsufficient = false;
  const reliable: EvidenceSource[] = [],
    authoritative: EvidenceSource[] = [];
  for (const [source] of selected) {
    if (!source) continue;
    if (source.kind === "web") {
      try {
        const url = new URL(source.url ?? "");
        if (url.protocol !== "https:" || url.hostname !== source.domain)
          continue;
      } catch {
        continue;
      }
    }
    if (
      !source.identity ||
      !identity.producer ||
      !source.identity.producer ||
      !sameProductIdentity(identity.producer, source.identity.producer)
    )
      continue;
    if (claim.scope === "product") {
      const match = matchWineIdentity(
        identityForClaim(identity, claim.field),
        identityForClaim(source.identity, claim.field),
        context,
      );
      if (match.state === "mismatch") continue;
      if (match.state === "ambiguous") {
        incomplete = true;
        continue;
      }
      if (
        source.kind === "web" &&
        (!identity.marketVariant ||
          !source.identity.marketVariant ||
          (identity.vintage.state === "unknown" &&
            source.identity.vintage.state !== "unknown"))
      ) {
        incomplete = true;
        continue;
      }
    }
    const support = context.supports?.find(
      (item) =>
        item.sourceId === source.id &&
        item.field === claim.field &&
        sameWineValue(item.value, claim.value),
    );
    if (
      !support ||
      source.contentScope === "snippet" ||
      source.truncated ||
      !supportsValue(support, source)
    ) {
      incomplete = true;
      continue;
    }
    if (originalAuthorityFields.has(claim.field)) {
      const vintage = support.applicableVintage;
      if (
        !support.originalAuthority ||
        identity.vintage.state !== "known" ||
        vintage?.state !== "known" ||
        identity.vintage.year !== vintage.year ||
        source.identity.vintage.state !== "known" ||
        source.identity.vintage.year !== vintage.year ||
        !context.now ||
        !resolveWineSourceAuthority(
          source,
          { kind: "authority", name: support.originalAuthority },
          context.authorities ?? [],
          context.now,
        )
      ) {
        incomplete = true;
        continue;
      }
      authoritative.push(source);
      continue;
    }
    const official =
      context.now &&
      resolveWineSourceAuthority(
        source,
        { kind: "producer", name: identity.producer },
        context.authorities ?? [],
        context.now,
      );
    if (
      official ||
      (source.kind !== "web" &&
        context.trustedObservationSourceIds?.has(source.id))
    )
      authoritative.push(source);
    else if (
      source.kind === "web" &&
      source.trust === "reliable" &&
      context.reliableSourceIds?.has(source.id)
    ) {
      reliable.push(source);
      trustedButInsufficient = true;
    }
  }
  const supported =
    authoritative.length > 0 ||
    reliable.some((a, index) =>
      reliable.slice(index + 1).some((b) => independent(a, b)),
    );
  if (!supported)
    return result(
      incomplete || trustedButInsufficient ? "unknown" : "rejected",
      incomplete
        ? "insufficient_applicable_support"
        : trustedButInsufficient
          ? "insufficient_independent_sources"
          : "untrusted_or_wrong_product",
    );
  if (checkContradictions) {
    const alternatives = (context.supports ?? []).filter(
      (item) =>
        item.field === claim.field && !sameWineValue(item.value, claim.value),
    );
    for (const alternative of alternatives) {
      const evidenceIds = [
        ...new Set(
          alternatives
            .filter((item) => sameWineValue(item.value, alternative.value))
            .map((item) => item.sourceId),
        ),
      ];
      const competing = adjudicate(
        {
          ...input,
          claim: { ...claim, value: alternative.value, evidenceIds },
        },
        false,
      );
      if (competing.state === "accepted" || competing.state === "conflict")
        return result("conflict", "trusted_source_conflict");
    }
  }
  const observed = observedValue(identity, claim.field);
  if (
    observed &&
    observed.value !== null &&
    !sameWineValue(observed.value, claim.value)
  ) {
    const trusted = observed.evidenceIds.some(
      (id) =>
        context.trustedObservationSourceIds?.has(id) &&
        sources.filter((source) => source.id === id).length === 1,
    );
    if (trusted) return result("conflict", "trusted_observation_conflict");
    // Never overwrite an existing unverified observation automatically either.
    return result("unknown", "existing_observation_unverified");
  }
  return {
    ...result(
      "accepted",
      authoritative.length
        ? "authoritative_support"
        : "independent_reliable_support",
    ),
    evidenceIds: [
      ...new Set([...authoritative, ...reliable].map((source) => source.id)),
    ],
  };
}
