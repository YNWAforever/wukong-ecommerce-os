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
  if (preferred?.trim()) return preferred;
  const alternate = item.titles?.[locale === "en" ? "zh-Hant" : "en"];
  if (alternate?.trim()) return alternate;
  return item.title;
}
