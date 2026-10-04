import type { ReviewableListing, WorkingListing } from "@wukong/core";
import { bulkFormGaps, type BulkFormContentGaps } from "@wukong/shopline";

export type ContentAssessmentState = "assessed" | "missing" | "invalid";

/** Receives parsed current content; source rows never enter this boundary. */
export function computeCurrentContentGaps(input: {
  content: WorkingListing | ReviewableListing | null;
  assessmentState: ContentAssessmentState;
}): {
  gaps: BulkFormContentGaps | null;
  assessmentState: ContentAssessmentState;
} {
  if (input.assessmentState !== "assessed" || !input.content)
    return {
      gaps: null,
      assessmentState:
        input.assessmentState === "assessed"
          ? "missing"
          : input.assessmentState,
    };
  const content = input.content;
  const present = (value: string) => value.trim() || null;
  return {
    assessmentState: "assessed",
    gaps: bulkFormGaps({
      nameEn: present(content.title.en),
      nameZh: present(content.title["zh-Hant"]),
      seoTitleEn: present(content.seo.title.en),
      seoTitleZh: present(content.seo.title["zh-Hant"]),
      seoDescriptionEn: present(content.seo.description.en),
      summaryEn: present(content.description.en),
      summaryZh: present(content.description["zh-Hant"]),
      seoKeywords: present(content.tags.join(", ")),
    }),
  };
}
