import { wineIdentitySelectionSchema } from "./wine-identity-selection.js";
import {
  wineOwnershipSchema,
  hasWineSectionMapping,
  mergeWineSections,
  renderWineDescription,
} from "./wine-content.js";
import { z } from "zod";
import {
  listingFactsSchema,
  type ReviewableListing,
} from "./listing-schema.js";

const copy = z.object({
  en: z.string().trim().max(20000).default(""),
  "zh-Hant": z.string().trim().max(20000).default(""),
});
export const workingListingSchema = listingFactsSchema.extend({
  wineOwnership: wineOwnershipSchema.optional(),
  wineIdentitySelection: wineIdentitySelectionSchema.optional(),
  packQuantity: z.number().int().positive().nullable(),
  title: copy,
  description: copy,
  seo: z.object({ title: copy, description: copy }),
  tags: z.array(z.string().trim().min(1)),
  imageAssetIds: z.array(z.string().uuid()),
});
export type WorkingListing = z.infer<typeof workingListingSchema>;
export const workingFieldSchemas = {
  ...listingFactsSchema.shape,
  packQuantity: workingListingSchema.shape.packQuantity,
  "title.en": z.string().trim().max(20000),
  "title.zh-Hant": z.string().trim().max(20000),
  "description.en": z.string().trim().max(20000),
  "description.zh-Hant": z.string().trim().max(20000),
  "seo.title.en": z.string().trim().max(20000),
  "seo.title.zh-Hant": z.string().trim().max(20000),
  "seo.description.en": z.string().trim().max(20000),
  "seo.description.zh-Hant": z.string().trim().max(20000),
  tags: workingListingSchema.shape.tags,
};
export type WorkingField = keyof typeof workingFieldSchemas;
export const workingFields = Object.keys(workingFieldSchemas) as WorkingField[];
export const workingChangeSchema = z
  .object({
    field: z.enum(workingFields as [WorkingField, ...WorkingField[]]),
    value: z.unknown(),
    locked: z.boolean().optional(),
    state: z.enum(["unknown", "manual", "not_applicable"]).optional(),
  })
  .strict()
  .superRefine((change, ctx) => {
    if (!workingFieldSchemas[change.field].safeParse(change.value).success)
      ctx.addIssue({
        code: "custom",
        message: "Invalid field value",
        path: ["value"],
      });
    if (
      change.state === "not_applicable" &&
      (change.field !== "vintage" || change.value !== null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Not applicable is only supported for unknown vintage",
      });
    if (
      change.state === "unknown" &&
      change.value !== null &&
      change.value !== "" &&
      !(Array.isArray(change.value) && change.value.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Unknown fields cannot contain a value",
      });
  });
export type WorkingChange = z.infer<typeof workingChangeSchema>;
export const workingFieldStateSchema = z.object({
  state: z.enum(["unknown", "not_applicable", "proposed", "manual"]),
  owner: z.enum(["ai", "operator"]),
  locked: z.boolean().default(false),
  evidenceRefs: z.array(z.string()).default([]),
  provenanceUncertain: z.boolean().optional(),
  candidateRunId: z.string().uuid().optional(),
  candidateInputRevision: z.number().int().positive().optional(),
});
export type WorkingFieldStates = Partial<
  Record<WorkingField, z.infer<typeof workingFieldStateSchema>>
>;
export const sourceSelectionSchema = z
  .object({
    assetId: z.string().uuid(),
    role: z.enum([
      "front_label",
      "back_label",
      "other_image",
      "supplier_document",
    ]),
    use: z.enum(["analyse", "reference_only"]),
    hero: z.boolean().default(false),
  })
  .strict();
export type SourceSelection = z.infer<typeof sourceSelectionSchema>;
export type ResolvedSourceSelection = SourceSelection & { digest: string };
export function emptyWorkingListing(): WorkingListing {
  return {
    sku: null,
    producer: null,
    productType: null,
    country: null,
    region: null,
    vintage: null,
    grapeVarieties: [],
    volumeMl: null,
    abvPercent: null,
    packQuantity: null,
    priceHkd: null,
    stockQuantity: null,
    criticScores: [],
    awards: [],
    title: { en: "", "zh-Hant": "" },
    description: { en: "", "zh-Hant": "" },
    seo: {
      title: { en: "", "zh-Hant": "" },
      description: { en: "", "zh-Hant": "" },
    },
    tags: [],
    imageAssetIds: [],
  };
}
export function readWorkingField(
  content: WorkingListing,
  field: WorkingField,
): unknown {
  return field
    .split(".")
    .reduce<unknown>(
      (value, key) => (value as Record<string, unknown>)[key],
      content,
    );
}
function setField(
  content: WorkingListing,
  field: WorkingField,
  value: unknown,
) {
  const path = field.split(".");
  let target = content as unknown as Record<string, unknown>;
  for (const key of path.slice(0, -1))
    target = target[key] as Record<string, unknown>;
  target[path[path.length - 1]!] = value;
}
export function applyWorkingChanges(
  content: WorkingListing,
  states: WorkingFieldStates,
  changes: WorkingChange[],
) {
  const next = structuredClone(content);
  const fieldStates = structuredClone(states);
  for (const raw of changes) {
    const change = workingChangeSchema.parse(raw);
    if (change.field.startsWith("description.")) delete next.wineOwnership;
    setField(
      next,
      change.field,
      workingFieldSchemas[change.field].parse(change.value),
    );
    const unknown =
      change.value === null ||
      change.value === "" ||
      (Array.isArray(change.value) && change.value.length === 0);
    fieldStates[change.field] = {
      state: change.state ?? (unknown ? "unknown" : "manual"),
      owner: "operator",
      locked: change.locked ?? states[change.field]?.locked ?? false,
      evidenceRefs: [],
    };
  }
  return { content: workingListingSchema.parse(next), fieldStates };
}
export function mergeWorkingCandidate(
  content: WorkingListing,
  states: WorkingFieldStates,
  candidate: WorkingListing | ReviewableListing,
): WorkingListing {
  const next = structuredClone(content);
  const wholeProtected = (
    ["description.en", "description.zh-Hant"] as const
  ).some(
    (field) => states[field]?.owner === "operator" || states[field]?.locked,
  );
  // A recognized mapping is bilingual. Retaining either whole locale must retain
  // the complete mapping before the generic field merge can replace its other half.
  const preserveMappedDescription =
    hasWineSectionMapping(content) && wholeProtected;
  for (const field of workingFields)
    if (
      !(preserveMappedDescription && field.startsWith("description.")) &&
      !["sku", "priceHkd", "stockQuantity"].includes(field) &&
      states[field]?.owner !== "operator" &&
      !states[field]?.locked
    )
      setField(next, field, readWorkingField(candidate, field));
  if (
    "wineOwnership" in candidate &&
    candidate.wineOwnership &&
    hasWineSectionMapping(candidate)
  ) {
    if (!wholeProtected) {
      const proposed = {
        ...candidate,
        sections: candidate.wineOwnership.sections,
      };
      const merged = hasWineSectionMapping(content)
        ? mergeWineSections(
            { ...content, sections: content.wineOwnership!.sections },
            proposed,
          )
        : proposed;
      next.wineOwnership = { schemaVersion: 1, sections: merged.sections };
      next.description = {
        en: renderWineDescription(merged, "en"),
        "zh-Hant": renderWineDescription(merged, "zh-Hant"),
      };
    }
  }
  if (
    hasWineSectionMapping(content) &&
    content.wineOwnership!.sections.some(
      (s) => s.locked || s.owner === "operator",
    ) &&
    !(
      "wineOwnership" in candidate &&
      candidate.wineOwnership &&
      hasWineSectionMapping(candidate)
    )
  ) {
    next.description = structuredClone(content.description);
    next.wineOwnership = structuredClone(content.wineOwnership);
  }
  if (next.wineOwnership && !hasWineSectionMapping(next))
    delete next.wineOwnership;
  return workingListingSchema.parse(next);
}

/** Evidence must describe the value adopted, not the model value it replaced. */
export function evidenceForAutomaticFields<T extends { field: string }>(
  states: WorkingFieldStates,
  evidence: T[],
): T[] {
  return evidence.filter((entry) => {
    const field = entry.field.replace(/^facts\./, "") as WorkingField;
    return (
      !["sku", "priceHkd", "stockQuantity"].includes(field) &&
      states[field]?.owner !== "operator" &&
      !states[field]?.locked
    );
  });
}

/** Derive the editable baseline from the exact active review, retaining human ownership. */
export function workingBaselineForReview(
  content: WorkingListing,
  states: WorkingFieldStates,
  activeContent: unknown,
): { workingContent: WorkingListing; fieldStates: WorkingFieldStates } {
  const active = workingListingSchema.safeParse(activeContent);
  if (!active.success) return { workingContent: content, fieldStates: states };
  const workingContent = mergeWorkingCandidate(content, states, active.data);
  const fieldStates = structuredClone(states);
  for (const field of workingFields) {
    if (
      ["sku", "priceHkd", "stockQuantity"].includes(field) ||
      states[field]?.owner === "operator" ||
      states[field]?.locked
    )
      continue;
    const value = readWorkingField(workingContent, field);
    const unknown =
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);
    fieldStates[field] = {
      owner: "ai",
      state: unknown ? "unknown" : "proposed",
      locked: false,
      evidenceRefs: [],
    };
  }
  return { workingContent, fieldStates };
}
