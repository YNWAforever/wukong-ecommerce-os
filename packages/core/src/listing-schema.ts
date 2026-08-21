import { z } from "zod";

export const localizedTextSchema = z.object({
  en: z.string().trim().min(1),
  "zh-Hant": z.string().trim().min(1)
});

export const fieldEvidenceSchema = z.object({
  field: z.string().min(1),
  sourceAssetId: z.string().min(1),
  page: z.number().int().positive().nullable(),
  excerpt: z.string().min(1),
  confidence: z.number().min(0).max(1)
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
  criticScores: z.array(z.object({ source: z.string(), score: z.string(), evidenceId: z.string() })),
  awards: z.array(z.object({ name: z.string(), evidenceId: z.string() }))
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
  seo: z.object({ title: localizedTextSchema, description: localizedTextSchema }),
  tags: z.array(z.string().trim().min(1)),
  imageAssetIds: z.array(z.string().min(1))
});

export const workspaceProfileSchema = z.object({
  name: z.string().min(1),
  currency: z.literal("HKD"),
  locales: z.tuple([z.literal("en"), z.literal("zh-Hant")]),
  tone: z.string().min(1),
  claimPolicy: z.array(z.string().min(1)),
  requiredFields: z.array(z.string().min(1)),
  brandBackgroundColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable()
});

export type CanonicalListing = z.infer<typeof canonicalListingSchema>;
export type ListingFacts = z.infer<typeof listingFactsSchema>;
export type FieldEvidence = z.infer<typeof fieldEvidenceSchema>;
export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;
