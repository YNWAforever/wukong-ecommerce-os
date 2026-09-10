"use client";
import {
  splitMissingFields,
  type ListingProcessingSummary,
} from "../lib/listing-processing-summary";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";

import type { ListingFacts } from "@wukong/core";

/**
 * What the pipeline read off the sources, shown while the listing still needs
 * information.
 *
 * A `needs_info` run writes no version, so this screen used to say only "more
 * information needed" -- an operator could not tell whether the AI had read
 * their label correctly, or which fields it was waiting on. Those facts were
 * already stored on the extraction step; this renders them.
 */

const FACT_LABELS: Partial<Record<keyof ListingFacts, [string, string]>> = {
  sku: ["商戶貨號", "SKU"],
  producer: ["生產商", "Producer"],
  productType: ["產品類型", "Product type"],
  country: ["國家", "Country"],
  region: ["產區", "Region"],
  vintage: ["年份", "Vintage"],
  grapeVarieties: ["葡萄品種", "Grape varieties"],
  volumeMl: ["容量", "Volume"],
  abvPercent: ["酒精濃度", "ABV"],
  packQuantity: ["每箱數量", "Pack quantity"],
  priceHkd: ["售價", "Price"],
  stockQuantity: ["庫存", "Stock"],
};

function labelFor(
  locale: Parameters<typeof localized>[0],
  key: string,
): string {
  const pair = FACT_LABELS[key as keyof ListingFacts];
  // An unrecognized key is still worth naming rather than hiding: a fact the
  // pipeline reports as missing must never silently vanish from this list.
  return pair ? localized(locale, pair[0], pair[1]) : key;
}

/** Present a fact for reading. Units are spelled out; nothing is invented. */
function displayValue(key: keyof ListingFacts, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : null;
  }
  if (key === "volumeMl") return `${String(value)} ml`;
  if (key === "abvPercent") return `${String(value)}%`;
  if (key === "priceHkd") return `HK$${String(value)}`;
  return String(value);
}

export function ListingExtractedFacts({
  processing,
}: {
  processing?: ListingProcessingSummary | null;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);

  const facts = processing?.extractedFacts;
  const missing = processing?.missingFields ?? [];
  if (!facts && missing.length === 0) return null;

  const known = facts
    ? (Object.keys(FACT_LABELS) as Array<keyof ListingFacts>)
        .map((key) => [key, displayValue(key, facts[key])] as const)
        .filter((entry): entry is [keyof ListingFacts, string] =>
          Boolean(entry[1]),
        )
    : [];
  const { merchant, extractable } = splitMissingFields(missing);

  return (
    <section className="panel extracted-facts">
      {known.length > 0 ? (
        <>
          <p className="eyebrow">
            {t("已從來源讀出", "Read from your sources")}
          </p>
          <dl className="fact-list">
            {known.map(([key, value]) => (
              <div key={key} className="fact-row">
                <dt>{labelFor(locale, key)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p className="helper-copy">
          {t(
            "尚未從來源讀出可用的商品資料。",
            "No usable product details were read from your sources yet.",
          )}
        </p>
      )}

      {merchant.length > 0 ? (
        <>
          <p className="eyebrow">
            {t("需要你提供", "Only you can supply these")}
          </p>
          <p className="helper-copy">
            {t(
              "這些是商戶資料，AI 不會從相片推測。再處理一次也不會找到。",
              "These are your own commercial details. The AI never reads them from a photo, so running processing again will not find them.",
            )}
          </p>
          <ul className="missing-fields merchant">
            {merchant.map((key) => (
              <li key={key}>{labelFor(locale, key)}</li>
            ))}
          </ul>
        </>
      ) : null}

      {extractable.length > 0 ? (
        <>
          <p className="eyebrow">
            {t("來源未有記載", "Not stated on your sources")}
          </p>
          <ul className="missing-fields">
            {extractable.map((key) => (
              <li key={key}>{labelFor(locale, key)}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
