import { z } from "zod";
import {
  enrichmentIdentitySchema,
  type MatchedWebsiteSuggestion,
} from "./matched-enrichment.js";
import { normalizeWebsiteUrl, type WebsiteProduct } from "./website-catalog.js";
const bounded = z.string().trim().min(1).max(200);
const ratingNumber = z.string().regex(/^\d{1,3}(?:\.\d{1,2})?$/);
export const externalClaimSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rating"),
      critic: bounded,
      value: ratingNumber,
      scale: ratingNumber,
      year: z.number().int().min(1800).max(2100),
      product: enrichmentIdentitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("award"),
      name: bounded,
      edition: bounded,
      product: enrichmentIdentitySchema,
    })
    .strict(),
]);
export type ExternalClaim = z.infer<typeof externalClaimSchema>;
export const externalClaimSourceSchema = z
  .object({
    kind: z.literal("website"),
    url: z.string().url(),
    documentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    retrievedAt: z.iso.datetime(),
    excerpt: z.string().min(1).max(4000),
    location: z.string().min(1).max(200),
  })
  .strict();
export type ExternalClaimSource = z.infer<typeof externalClaimSourceSchema>;
export type ExternalClaimSupport = {
  status: "supported" | "conflict" | "unresolved";
  reasons: string[];
  source: ExternalClaimSource | null;
};
const norm = (value: unknown) =>
  typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
    : value;
/** This verifies one structured claim. It never verifies arbitrary prose or invents a citation for legacy facts. */
export function evaluateExternalClaimSupport(
  claim: unknown,
  observation: { claim: unknown; source: unknown; match: string },
): ExternalClaimSupport {
  const requested = externalClaimSchema.safeParse(claim),
    observed = externalClaimSchema.safeParse(observation.claim),
    source = externalClaimSourceSchema.safeParse(observation.source);
  if (
    !requested.success ||
    !observed.success ||
    !source.success ||
    observation.match !== "matched"
  )
    return {
      status: "unresolved",
      reasons: ["explicit_claim_context_required"],
      source: source.success ? source.data : null,
    };
  try {
    normalizeWebsiteUrl(source.data.url);
  } catch {
    return {
      status: "unresolved",
      reasons: ["invalid_source_url"],
      source: null,
    };
  }
  const a = requested.data,
    b = observed.data;
  if (
    (a.kind === "rating" &&
      (Number(a.scale) <= 0 || Number(a.value) > Number(a.scale))) ||
    (b.kind === "rating" &&
      (Number(b.scale) <= 0 || Number(b.value) > Number(b.scale)))
  )
    return {
      status: "unresolved",
      reasons: ["invalid_rating_scale"],
      source: source.data,
    };
  const reasons: string[] = [];
  if (a.kind !== b.kind) reasons.push("claim_kind_conflict");
  for (const key of Object.keys(a.product) as Array<keyof typeof a.product>)
    if (norm(a.product[key]) !== norm(b.product[key]))
      reasons.push("product_conflict:" + key);
  if (a.kind === "rating" && b.kind === "rating")
    for (const key of ["critic", "value", "scale", "year"] as const)
      if (norm(a[key]) !== norm(b[key])) reasons.push("claim_conflict:" + key);
  if (a.kind === "award" && b.kind === "award")
    for (const key of ["name", "edition"] as const)
      if (norm(a[key]) !== norm(b[key])) reasons.push("claim_conflict:" + key);
  if (reasons.length)
    return { status: "conflict", reasons, source: source.data };
  const terms =
    b.kind === "rating"
      ? [b.critic, b.value, b.scale, String(b.year)]
      : [b.name, b.edition];
  const excerpt = String(norm(source.data.excerpt));
  const containsTerm = (term: string) => {
    const needle = String(norm(term));
    let from = 0;
    while (from <= excerpt.length) {
      const index = excerpt.indexOf(needle, from);
      if (index < 0) return false;
      const before = excerpt[index - 1] ?? "",
        after = excerpt[index + needle.length] ?? "";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after))
        return true;
      from = index + 1;
    }
    return false;
  };
  if (terms.some((term) => !containsTerm(term)))
    return {
      status: "unresolved",
      reasons: ["claim_excerpt_incomplete"],
      source: source.data,
    };
  return { status: "supported", reasons: [], source: source.data };
}
export type WebsiteClaimObservation = {
  claim: unknown;
  support: ExternalClaimSupport;
};
/** Only dedicated structured attributes are candidates. Description/instructions are never interpreted as claim evidence. */
export function extractWebsiteClaims(
  product: WebsiteProduct,
  match: MatchedWebsiteSuggestion,
  documentDigest: string,
): WebsiteClaimObservation[] {
  const attrs = new Map<string, string>();
  let ambiguous = false;
  for (const [key, value] of Object.entries(product.attributes)) {
    const normalized = key.toLowerCase().replace(/[ _-]/g, "");
    if (attrs.has(normalized) && attrs.get(normalized) !== value)
      ambiguous = true;
    attrs.set(normalized, value);
  }
  const read = (key: string) => attrs.get(key)?.trim() || undefined;
  const candidates: unknown[] = [];
  if (read("critic") || read("rating"))
    candidates.push({
      kind: "rating",
      critic: read("critic"),
      value: read("rating"),
      scale: read("ratingscale"),
      year: read("ratingyear") ? Number(read("ratingyear")) : undefined,
      product: match.candidateIdentity,
    });
  if (read("awardname"))
    candidates.push({
      kind: "award",
      name: read("awardname"),
      edition: read("awardedition"),
      product: match.candidateIdentity,
    });
  const source = {
    kind: "website",
    url: product.sourceUrl,
    retrievedAt: product.capturedAt,
    documentDigest,
    excerpt: JSON.stringify(
      Object.fromEntries(
        [...attrs].filter(([key]) =>
          [
            "critic",
            "rating",
            "ratingscale",
            "ratingyear",
            "awardname",
            "awardedition",
          ].includes(key),
        ),
      ),
    ).slice(0, 4000),
    location: "Product structured claim attributes",
  };
  return candidates.map((claim) => ({
    claim,
    support: evaluateExternalClaimSupport(claim, {
      claim,
      source,
      match: ambiguous ? "unresolved" : match.match,
    }),
  }));
}
