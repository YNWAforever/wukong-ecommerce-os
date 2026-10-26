import type { Locale } from "./locale";

/** Keep older responses and single-source names usable during a rollout. */
export function productTitle(
  item: {
    title: string | null;
    titles?: Partial<Record<Locale, string | null>> | null;
  },
  locale: Locale,
): string | null {
  const preferred = item.titles?.[locale];
  const alternate = item.titles?.[locale === "en" ? "zh-Hant" : "en"];
  for (const title of [preferred, alternate, item.title]) {
    if (typeof title === "string" && title.trim()) return title;
  }
  return null;
}
