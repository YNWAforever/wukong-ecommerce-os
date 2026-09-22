import { z } from "zod";
import {
  contentSectionSchema,
  sectionKeySchema,
  type WineContent,
} from "./wine-enrichment-contracts.js";
export const wineOwnershipSchema = z
  .object({
    schemaVersion: z.literal(1),
    sections: z.array(contentSectionSchema),
  })
  .strict()
  .refine(
    (v) => new Set(v.sections.map((s) => s.key)).size === v.sections.length,
    "Duplicate section keys",
  );
export function renderWineDescription(
  content: Pick<WineContent, "sections">,
  locale: "en" | "zh-Hant",
): string {
  return content.sections
    .map((s) => s[locale].trim())
    .filter(Boolean)
    .join("\n\n");
}
export function mergeWineSections(
  current: WineContent,
  candidate: WineContent,
): WineContent {
  const protectedSections = new Map(
    current.sections
      .filter((s) => s.locked || s.owner === "operator")
      .map((s) => [s.key, s]),
  );
  const sections = candidate.sections.map(
    (s) => protectedSections.get(s.key) ?? s,
  );
  for (const s of protectedSections.values())
    if (!sections.some((n) => n.key === s.key)) sections.push(s);
  return structuredClone({ ...candidate, sections });
}
export function hasWineSectionMapping(content: {
  description: { en: string; "zh-Hant": string };
  wineOwnership?: z.infer<typeof wineOwnershipSchema>;
}): boolean {
  return (
    !!content.wineOwnership &&
    (["en", "zh-Hant"] as const).every(
      (lang) =>
        renderWineDescription(content.wineOwnership!, lang) ===
        content.description[lang],
    )
  );
}
export const wineSectionChangeSchema = z
  .object({
    key: sectionKeySchema,
    en: z.string().max(20000),
    "zh-Hant": z.string().max(20000),
    locked: z.boolean().optional(),
  })
  .strict();
export type WineSectionChange = z.infer<typeof wineSectionChangeSchema>;
/** Only edits existing server-established sections. No claim references or owner accepted. */
export function editWineSections<
  T extends {
    description: { en: string; "zh-Hant": string };
    wineOwnership?: z.infer<typeof wineOwnershipSchema>;
  },
>(content: T, changes: WineSectionChange[]): T {
  const next = structuredClone(content);
  if (!hasWineSectionMapping(next))
    throw Error("wine_section_mapping_unavailable");
  for (const raw of changes) {
    const change = wineSectionChangeSchema.parse(raw),
      s = next.wineOwnership!.sections.find((s) => s.key === change.key);
    if (!s) throw Error("wine_section_not_found");
    Object.assign(s, {
      en: change.en,
      "zh-Hant": change["zh-Hant"],
      owner: "operator",
      locked: change.locked ?? s.locked,
      claimIds: [],
    });
  }
  next.description = {
    en: renderWineDescription(next.wineOwnership!, "en"),
    "zh-Hant": renderWineDescription(next.wineOwnership!, "zh-Hant"),
  };
  return next;
}
/** Manual submissions can echo or omit established ownership, never create or alter it. */
export function inheritWineOwnership<
  T extends {
    description: { en: string; "zh-Hant": string };
    wineOwnership?: z.infer<typeof wineOwnershipSchema>;
  },
>(current: Pick<T, "description" | "wineOwnership"> | null, submitted: T): T {
  const next = structuredClone(submitted);
  if (
    next.wineOwnership &&
    (!current?.wineOwnership ||
      JSON.stringify(wineOwnershipSchema.parse(next.wineOwnership)) !==
        JSON.stringify(wineOwnershipSchema.parse(current.wineOwnership)))
  )
    throw Error("wine_ownership_server_only");
  delete next.wineOwnership;
  if (
    current?.wineOwnership &&
    hasWineSectionMapping(current) &&
    next.description.en === current.description.en &&
    next.description["zh-Hant"] === current.description["zh-Hant"]
  )
    next.wineOwnership = structuredClone(current.wineOwnership);
  return next;
}
