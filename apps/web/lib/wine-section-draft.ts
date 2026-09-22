import { z } from "zod";
import { wineSectionChangeSchema } from "@wukong/core";
const paragraphs = z
  .array(wineSectionChangeSchema)
  .min(1)
  .max(6)
  .refine(
    (value) =>
      new Set(value.map((section) => section.key)).size === value.length,
  );
const draftSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedInputRevision: z.number().int().positive(),
    baseVersionId: z.uuid().nullable(),
    baseline: paragraphs,
    sections: paragraphs,
  })
  .strict()
  .refine(
    (value) =>
      value.baseline.length === value.sections.length &&
      value.baseline.every((section) =>
        value.sections.some((draft) => draft.key === section.key),
      ),
  );
export type WineSectionDraft = z.infer<typeof draftSchema>;
const maximumStoredCharacters = 3_000_000;
/** Tab-local text recovery only. This record cannot carry owners, claims or authority. */
export function readWineSectionDraft(
  key: string,
):
  | { state: "empty" | "unavailable" }
  | { state: "recovered"; draft: WineSectionDraft } {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return { state: "empty" };
    if (raw.length > maximumStoredCharacters) throw Error("oversized_draft");
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw Error("invalid_draft");
    return { state: "recovered", draft: parsed.data };
  } catch {
    return { state: "unavailable" };
  }
}
export function writeWineSectionDraft(
  key: string,
  draft: WineSectionDraft | null,
): boolean {
  try {
    if (draft === null) sessionStorage.removeItem(key);
    else {
      const raw = JSON.stringify(draftSchema.parse(draft));
      if (raw.length > maximumStoredCharacters) return false;
      sessionStorage.setItem(key, raw);
    }
    return true;
  } catch {
    return false;
  }
}
