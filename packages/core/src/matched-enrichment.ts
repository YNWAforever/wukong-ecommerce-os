import { z } from "zod";
import {
  normalizeWebsiteUrl,
  websiteProductSchema,
  type WebsiteProduct,
} from "./website-catalog.js";
import { workingFieldSchemas, type WorkingField } from "./working-listing.js";
export const enrichmentIdentitySchema = z
  .object({
    producer: z.string().trim().min(1).max(200),
    productName: z.string().trim().min(1).max(500),
    vintage: z.union([
      z.number().int().min(1800).max(2100),
      z.literal("non_vintage"),
    ]),
    volumeMl: z.number().int().positive(),
    packQuantity: z.number().int().positive(),
    marketVariant: z.string().trim().min(1).max(100),
  })
  .strict();
export type EnrichmentIdentity = z.infer<typeof enrichmentIdentitySchema>;
export const enrichmentFields = [
  "producer",
  "productType",
  "country",
  "region",
  "vintage",
  "grapeVarieties",
  "volumeMl",
  "abvPercent",
  "packQuantity",
] as const;
export type EnrichmentField = (typeof enrichmentFields)[number];
export type WebsiteFieldEvidence = {
  kind: "website";
  url: string;
  retrievedAt: string;
  documentDigest: string;
  sourceClass: "public_product_page";
  field: EnrichmentField;
  excerpt: string;
  location: string;
  extraction: "structured_product_attributes_v1";
};
export type MatchedWebsiteSuggestion = {
  claims?: import("./external-claim-support.js").WebsiteClaimObservation[];
  proseSource?: import("./external-claim-support.js").ExternalClaimSource;
  match: "matched" | "unresolved" | "conflict";
  reasons: string[];
  candidateIdentity: Partial<EnrichmentIdentity>;
  fields: Array<{
    field: EnrichmentField;
    value: unknown;
    evidence: WebsiteFieldEvidence;
  }>;
};
const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
/** Deterministic structured data only. Page prose is never an instruction or an adopted claim. */
export function matchWebsiteProduct(input: {
  identity: EnrichmentIdentity;
  product: WebsiteProduct;
  documentDigest: string;
}): MatchedWebsiteSuggestion {
  z.string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(input.documentDigest);
  const identity = enrichmentIdentitySchema.parse(input.identity),
    product = websiteProductSchema.parse(input.product);
  const attrs = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const [name, value] of Object.entries(product.attributes)) {
    const key = normalized(name).replace(/[ _-]/g, "");
    if (attrs.has(key) && attrs.get(key) !== value) conflicts.add(key);
    else attrs.set(key, value);
  }
  const read = (...names: string[]) => {
    const values = names
      .map((n) => attrs.get(n))
      .filter((v): v is string => v !== undefined);
    return new Set(values.map(normalized)).size === 1 ? values[0] : undefined;
  };
  const number = (value: string | undefined, suffix: string) => {
    if (!value) return undefined;
    const clean = value.trim().replace(new RegExp(`\\s*${suffix}$`, "i"), "");
    return /^\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : undefined;
  };
  const year = read("vintage", "year");
  const vintage =
    year && ["nv", "non-vintage", "non vintage"].includes(normalized(year))
      ? "non_vintage"
      : number(year, "");
  const candidateIdentity: Partial<EnrichmentIdentity> = {
    producer: read("producer", "brand", "manufacturer"),
    productName: read("productname", "cuvee") ?? product.title,
    vintage: vintage as EnrichmentIdentity["vintage"],
    volumeMl: number(read("volumeml", "volume", "size"), "ml"),
    packQuantity: number(read("packquantity", "packcount"), ""),
    marketVariant: read("marketvariant", "market"),
  };
  const reasons: string[] = [];
  let conflicting = false;
  for (const key of Object.keys(identity) as Array<keyof EnrichmentIdentity>) {
    const a = identity[key],
      b = candidateIdentity[key];
    if (b === undefined) {
      reasons.push(`identity_missing:${key}`);
      continue;
    }
    if (
      typeof a === "string" && typeof b === "string"
        ? normalized(a) !== normalized(b)
        : a !== b
    ) {
      reasons.push(`identity_conflict:${key}`);
      conflicting = true;
    }
  }
  if (
    conflicts.size ||
    product.warnings.some((w) => /conflict|multiple|truncated/.test(w))
  )
    reasons.push("ambiguous_document");
  const match = conflicting
    ? "conflict"
    : reasons.length
      ? "unresolved"
      : "matched";
  const values: Partial<Record<EnrichmentField, unknown>> = {
    producer: candidateIdentity.producer,
    vintage:
      candidateIdentity.vintage === "non_vintage"
        ? null
        : candidateIdentity.vintage,
    volumeMl: candidateIdentity.volumeMl,
    packQuantity: candidateIdentity.packQuantity,
    country: read("country", "countryoforigin"),
    region: read("region"),
    abvPercent: number(read("abv", "abvpercent", "alcohol"), "%"),
    productType: read("producttype")?.toLowerCase(),
    grapeVarieties: read("grapevarieties", "grapes")
      ?.split(",")
      .map((s) => s.trim()),
  };
  const fields: MatchedWebsiteSuggestion["fields"] = [];
  for (const field of enrichmentFields) {
    const value = values[field];
    if (
      value === undefined ||
      !workingFieldSchemas[field as WorkingField].safeParse(value).success
    )
      continue;
    const rawValues: Partial<Record<EnrichmentField, string | undefined>> = {
      producer: read("producer", "brand", "manufacturer"),
      vintage: read("vintage", "year"),
      volumeMl: read("volumeml", "volume", "size"),
      packQuantity: read("packquantity", "packcount"),
      country: read("country", "countryoforigin"),
      region: read("region"),
      abvPercent: read("abv", "abvpercent", "alcohol"),
      productType: read("producttype"),
      grapeVarieties: read("grapevarieties", "grapes"),
    };
    const raw = rawValues[field];
    if (!raw) continue;
    fields.push({
      field,
      value,
      evidence: {
        kind: "website",
        url: product.sourceUrl,
        retrievedAt: product.capturedAt,
        documentDigest: input.documentDigest,
        sourceClass: "public_product_page",
        field,
        excerpt: raw.slice(0, 2000),
        location: "Product structured attributes",
        extraction: "structured_product_attributes_v1",
      },
    });
  }
  return { match, reasons, candidateIdentity, fields };
}
export const enrichmentUrlSchema = z
  .string()
  .max(4096)
  .refine(
    (v) => normalizeWebsiteUrl(v) === v,
    "Choose a normalized public HTTPS URL",
  );

/** Market variant is operator-declared in the immutable note until a dedicated identity field exists. */
export function savedMarketVariant(
  note: string | null | undefined,
): string | null {
  const values = [
    ...(note ?? "").matchAll(
      /^(?:Market variant|市場版本|市场版本)\s*[:：]\s*(.+)$/gim,
    ),
  ].map((match) => match[1]!.trim());
  if (
    !values.length ||
    values.some((value) => value.length > 100) ||
    new Set(values.map(normalized)).size !== 1
  )
    return null;
  return values[0]!;
}
export function sameProductIdentity(a: string, b: string): boolean {
  return normalized(a) === normalized(b);
}
