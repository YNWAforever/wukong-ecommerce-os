import { z } from "zod";

export const localizedTextSchema = z.object({
  en: z.string().trim().min(1),
  "zh-Hant": z.string().trim().min(1),
});

export const fieldEvidenceSchema = z.object({
  field: z.string().min(1),
  sourceAssetId: z.string().min(1),
  page: z.number().int().positive().nullable(),
  excerpt: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const listingFactsSchema = z.object({
  sku: z.string().trim().min(1).nullable(),
  producer: z.string().trim().min(1).nullable(),
  productType: z.enum(["wine", "spirits", "sake", "other"]).nullable(),
  country: z.string().trim().min(1).nullable(),
  region: z.string().trim().min(1).nullable(),
  vintage: z.number().int().min(1800).max(2100).nullable(),
  grapeVarieties: z.array(z.string().trim().min(1)),
  volumeMl: z.number().int().positive().nullable(),
  abvPercent: z.number().min(0).max(100).nullable(),
  packQuantity: z.number().int().positive().default(1),
  priceHkd: z.number().nonnegative().nullable(),
  stockQuantity: z.number().int().nonnegative().nullable(),
  criticScores: z.array(
    z.object({ source: z.string(), score: z.string(), evidenceId: z.string() }),
  ),
  awards: z.array(z.object({ name: z.string(), evidenceId: z.string() })),
});

export const canonicalListingSchema = listingFactsSchema.extend({
  sku: z.string().trim().min(1),
  producer: z.string().trim().min(1),
  productType: z.enum(["wine", "spirits", "sake", "other"]),
  country: z.string().trim().min(1),
  volumeMl: z.number().int().positive(),
  abvPercent: z.number().min(0).max(100),
  priceHkd: z.number().nonnegative(),
  title: localizedTextSchema,
  description: localizedTextSchema,
  seo: z.object({
    title: localizedTextSchema,
    description: localizedTextSchema,
  }),
  tags: z.array(z.string().trim().min(1)),
  imageAssetIds: z.array(z.string().min(1)),
});

export const workspaceProfileSchema = z.object({
  name: z.string().min(1),
  currency: z.literal("HKD"),
  locales: z.tuple([z.literal("en"), z.literal("zh-Hant")]),
  tone: z.string().min(1),
  claimPolicy: z.array(z.string().min(1)),
  requiredFields: z.array(z.string().min(1)),
  // .nullish() (not .nullable()) so a legacy profile row written before this
  // field existed -- where the key is simply absent, not present-as-null --
  // still parses. The transform folds "absent" and "null" into the same
  // `null` value so every consumer keeps the simpler `string | null` type.
  brandBackgroundColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullish()
    .transform((value) => value ?? null),
});

// Same structural shape as canonicalListingSchema (title/description/seo/
// tags/imageAssetIds required), but without re-tightening the commercial
// facts back to non-null. A listing under active review normally still has
// some facts null -- pending AI enrichment or manual entry -- and that's a
// completely different situation from "ready to publish", which is what
// canonicalListingSchema actually gates. Reusing the strict schema for a
// read-only "view this listing" path turned routine, in-progress review
// data into a hard error.
export const reviewableListingSchema = listingFactsSchema.extend({
  title: localizedTextSchema,
  description: localizedTextSchema,
  seo: z.object({
    title: localizedTextSchema,
    description: localizedTextSchema,
  }),
  tags: z.array(z.string().trim().min(1)),
  imageAssetIds: z.array(z.string().min(1)),
});

export type CanonicalListing = z.infer<typeof canonicalListingSchema>;
export type ReviewableListing = z.infer<typeof reviewableListingSchema>;
export type ListingFacts = z.infer<typeof listingFactsSchema>;
export type FieldEvidence = z.infer<typeof fieldEvidenceSchema>;
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;
