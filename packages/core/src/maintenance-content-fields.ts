import { z } from "zod";
import { hasWineSectionMapping } from "./wine-content.js";
import {
  readWorkingField,
  workingListingSchema,
  type WorkingField,
  type WorkingFieldStates,
  type WorkingListing,
} from "./working-listing.js";

export const contentFields = [
  "nameZh",
  "summaryEn",
  "summaryZh",
  "seoTitleEn",
  "seoTitleZh",
  "seoDescriptionEn",
  "seoDescriptionZh",
  "seoKeywords",
] as const;
export const contentFieldSchema = z.enum(contentFields);
export type ContentField = z.infer<typeof contentFieldSchema>;
export const contentFieldSelectionSchema = z
  .array(contentFieldSchema)
  .min(1)
  .max(8)
  .refine(
    (fields) => new Set(fields).size === fields.length,
    "Duplicate content field",
  );
export const contentWorkingFields: Record<ContentField, WorkingField> = {
  nameZh: "title.zh-Hant",
  summaryEn: "description.en",
  summaryZh: "description.zh-Hant",
  seoTitleEn: "seo.title.en",
  seoTitleZh: "seo.title.zh-Hant",
  seoDescriptionEn: "seo.description.en",
  seoDescriptionZh: "seo.description.zh-Hant",
  seoKeywords: "tags",
};

/** Apply only the accepted copy mask; everything else comes from saved input. */
export function mergeMaintenanceCopy(
  saved: WorkingListing,
  states: WorkingFieldStates,
  candidate: WorkingListing,
  fields: readonly ContentField[],
): WorkingListing {
  const selected = contentFieldSelectionSchema.parse(fields);
  const result = structuredClone(saved);
  for (const key of selected) {
    const field = contentWorkingFields[key];
    if (
      states[field]?.owner === "operator" ||
      states[field]?.locked ||
      (field.startsWith("description.") && hasWineSectionMapping(saved))
    )
      continue;
    const path = field.split(".");
    let target = result as unknown as Record<string, unknown>;
    for (const part of path.slice(0, -1))
      target = target[part] as Record<string, unknown>;
    target[path.at(-1)!] = structuredClone(readWorkingField(candidate, field));
  }
  return workingListingSchema.parse(result);
}
