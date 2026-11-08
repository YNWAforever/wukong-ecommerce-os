import type { ContentField } from "@wukong/core";
import type { Locale } from "./locale";
import { localized, type BilingualMessage } from "./ui-copy";

/** Human names for the content fields an enrichment batch may rewrite. */
export const CONTENT_FIELD_LABELS: Record<ContentField, BilingualMessage> = {
  nameZh: ["中文商品名", "Chinese product name"],
  summaryEn: ["英文摘要", "English summary"],
  summaryZh: ["中文摘要", "Chinese summary"],
  seoTitleEn: ["英文 SEO 標題", "English SEO title"],
  seoTitleZh: ["中文 SEO 標題", "Chinese SEO title"],
  seoDescriptionEn: ["英文 SEO 描述", "English SEO description"],
  seoDescriptionZh: ["中文 SEO 描述", "Chinese SEO description"],
  seoKeywords: ["SEO 關鍵字", "SEO keywords"],
};

export function contentFieldLabel(field: ContentField, locale: Locale): string {
  return localized(locale, ...CONTENT_FIELD_LABELS[field]);
}
