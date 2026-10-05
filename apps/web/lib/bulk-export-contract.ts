import { z } from "zod";
import { MAX_BULK_EXPORT_ITEMS } from "./bulk-approve-limit";
export const EXPORT_CONTENT_FIELDS = [
  "nameZh",
  "summaryEn",
  "summaryZh",
  "seoTitleEn",
  "seoTitleZh",
  "seoDescriptionEn",
  "seoDescriptionZh",
  "seoKeywords",
] as const;
export type ExportContentField = (typeof EXPORT_CONTENT_FIELDS)[number];
export const exportFieldsSchema = z
  .array(z.enum(EXPORT_CONTENT_FIELDS))
  .min(1)
  .max(8)
  .refine(
    (fields) => new Set(fields).size === fields.length,
    "Select each field only once.",
  )
  .transform((fields) =>
    EXPORT_CONTENT_FIELDS.filter((field) => fields.includes(field)),
  );
export const exportRepairSchema = z
  .object({
    exportAttemptId: z.string().min(1),
    members: z
      .array(
        z
          .object({
            listingId: z.string().min(1),
            resultId: z.string().min(1),
            revision: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_BULK_EXPORT_ITEMS)
      .refine(
        (members) =>
          new Set(members.map((member) => member.listingId)).size ===
          members.length,
      ),
  })
  .strict();
export type ExportRepair = z.infer<typeof exportRepairSchema>;
export const exportSelectionSchema = z
  .object({
    listingIds: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BULK_EXPORT_ITEMS)
      .refine((ids) => new Set(ids).size === ids.length),
    fields: exportFieldsSchema,
    attestation: z
      .object({
        listings: z
          .array(
            z
              .object({
                listingId: z.string().min(1),
                contentDigest: z.string().min(1),
              })
              .strict(),
          )
          .min(1)
          .max(MAX_BULK_EXPORT_ITEMS)
          .refine(
            (listings) =>
              new Set(listings.map((listing) => listing.listingId)).size ===
              listings.length,
          ),
      })
      .strict(),
    repair: exportRepairSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.repair ||
      (value.repair.members.length === value.listingIds.length &&
        value.listingIds.every((id) =>
          value.repair!.members.some((member) => member.listingId === id),
        )),
    "Repair exactly the selected rejected members.",
  );
export type ExportSelection = z.infer<typeof exportSelectionSchema>;
export const exportGenerationSchema = exportSelectionSchema.safeExtend({
  previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ExportPreview = {
  previewSha256: string;
  fields: ExportContentField[];
  rowCount: number;
  manifest: Array<{
    listingId: string;
    versionId: string | null;
    outcome: string;
    reason?: string;
  }>;
  changes: Array<{
    listingId: string;
    column: ExportContentField;
    from: string | null;
    to: string;
    versionId: string;
    sourceSnapshotId: string;
  }>;
  neutralizedQuantityDeltas: string[];
};

/** Current observed source identity for repair UI; qualification remains a fresh server preview. */
export type RepairSourceObservation = {
  listingId: string;
  contentDigest: string;
  sourceImportId: string;
  remoteProductId: string;
};
