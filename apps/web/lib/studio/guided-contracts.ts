import { z } from "zod";

export const GUIDED_REVIEW_VERSION = "wukong-listing-improvement/v1" as const;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const guidedSourceSchema = z.strictObject({
  sourceOutputId: uuid,
  sourceRevision: revision,
  sourceDigest: digest,
});
export const guidedActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("audit"),
    listingId: uuid,
    expectedActiveVersionId: uuid.nullable(),
  }),
  guidedSourceSchema.extend({ kind: z.literal("gap_review") }),
  guidedSourceSchema.extend({ kind: z.literal("copy_proposal") }),
]);
export type GuidedAction = z.infer<typeof guidedActionSchema>;
export const GUIDED_SKILLS = {
  audit: "merchant.audit",
  gap_review: "catalog.gap_review",
  copy_proposal: "listing.copy_proposal",
} as const;
export const guidedListingSchema = z
  .strictObject({
    listingId: uuid,
    activeVersionId: uuid.nullable(),
    activeVersionSequence: revision.nullable(),
  })
  .refine(
    (value) =>
      (value.activeVersionId === null) ===
      (value.activeVersionSequence === null),
  );
export const guidedQualitySchema = z.strictObject({
  assessmentVersion: z.string().min(1).max(120),
  gapsDigest: digest,
});
export const guidedScopeSchema = z
  .strictObject({
    schemaVersion: z.literal(GUIDED_REVIEW_VERSION),
    rootRunId: uuid,
    stage: z.enum(["audit", "gap_review", "copy_proposal"]),
    listing: guidedListingSchema,
    parent: guidedSourceSchema.nullable(),
    quality: guidedQualitySchema.nullable(),
  })
  .refine((value) =>
    value.stage === "audit"
      ? value.parent === null && value.quality === null
      : value.parent !== null,
  )
  .refine(
    (value) =>
      value.stage !== "copy_proposal" ||
      (value.quality !== null && value.listing.activeVersionId !== null),
  );
export type GuidedScope = z.infer<typeof guidedScopeSchema>;
export type GuidedListing = z.infer<typeof guidedListingSchema>;
export type GuidedQuality = z.infer<typeof guidedQualitySchema>;
