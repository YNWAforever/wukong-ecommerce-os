"use client";
import { useState, useId } from "react";
import type { WineProgress } from "../lib/wine-progress";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
type Candidate = WineProgress["candidates"][number];
export function WineIdentityChoice({
  candidates,
  onConfirm,
  busy,
}: {
  candidates: Candidate[];
  onConfirm: (candidate: Candidate) => void | Promise<void>;
  busy: boolean;
}) {
  const locale = useLocale(),
    t = (zh: string, en: string) => localized(locale, zh, en),
    group = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const key = (c: Candidate) => `${c.runId}:${c.stage}:${c.id}`;
  const groups = new Map<string, { candidate: Candidate; count: number }>();
  for (const candidate of candidates) {
    const identity = candidate.identity;
    const coordinates = [
      identity.kind,
      identity.producer,
      identity.productName,
      identity.cuvee,
      identity.vintage.state,
      identity.vintage.year,
      identity.volumeMl,
      identity.packQuantity,
      identity.marketVariant,
      identity.barcode,
      identity.abvPercent,
      Object.entries(identity.category ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, observation]) => [
          name,
          observation.state,
          observation.value,
        ]),
    ];
    const groupKey = candidate.confirmationAvailable
      ? JSON.stringify([candidate.runId, candidate.stage, coordinates])
      : key(candidate);
    const existing = groups.get(groupKey);
    if (existing) existing.count++;
    else groups.set(groupKey, { candidate, count: 1 });
  }
  const categoryLabels: Record<string, [string, string]> = {
    appellation: ["產區", "Appellation"],
    grapeVarieties: ["葡萄品種", "Grape varieties"],
    fermentation: ["發酵", "Fermentation"],
    maturation: ["熟成", "Maturation"],
    spiritType: ["烈酒類型", "Spirit type"],
    ageYears: ["酒齡", "Age"],
    caskType: ["橡木桶類型", "Cask type"],
    batch: ["批次", "Batch"],
    brewery: ["酒造", "Brewery"],
    grade: ["等級", "Grade"],
    riceVariety: ["米種", "Rice variety"],
    polishingPercent: ["精米步合", "Polishing percentage"],
    brewingYear: ["釀造年份", "Brewing year"],
  };
  const chosen = candidates.find(
    (c) => key(c) === selected && c.confirmationAvailable,
  );
  if (!candidates.length) return null;
  return (
    <section className="panel">
      <fieldset disabled={busy}>
        <legend>{t("核對產品身份", "Confirm product identity")}</legend>
        <p>
          {t(
            "比較名稱、年份、容量及市場版本。確認可能需要網絡搜尋及 Tavily 點數。",
            "Compare name, vintage, volume and market. Confirmation may require network research and Tavily credits.",
          )}
        </p>
        {[...groups.values()].map(({ candidate, count }) => (
          <label
            key={key(candidate)}
            style={{ display: "block", marginBlock: 12 }}
          >
            <input
              type="radio"
              name={group}
              checked={selected === key(candidate)}
              disabled={!candidate.confirmationAvailable}
              onChange={() => setSelected(key(candidate))}
            />
            {candidate.identity.producer ?? t("未知生產商", "Unknown producer")}{" "}
            · {candidate.identity.productName ?? t("未知名稱", "Unknown name")}{" "}
            ·{" "}
            {candidate.identity.vintage.state === "known"
              ? candidate.identity.vintage.year
              : candidate.identity.vintage.state === "not_applicable"
                ? t("無年份／不適用", "Non-vintage / not applicable")
                : t("未知年份", "Unknown vintage")}{" "}
            · {candidate.identity.volumeMl ?? t("未知容量", "Unknown volume")}{" "}
            ml ·{" "}
            {candidate.identity.marketVariant ??
              t("未知市場", "Unknown market")}
            {candidate.identity.abvPercent != null &&
              ` - ${candidate.identity.abvPercent}% ${t("酒精濃度", "ABV")}`}
            {Object.entries(candidate.identity.category ?? {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, observation]) => {
                const labels = categoryLabels[name];
                return (
                  <span key={name}>
                    {" "}
                    - {labels
                      ? t(...labels)
                      : t("產品特徵", "Product detail")}:{" "}
                    {observation.state === "unknown"
                      ? t("未知", "Unknown")
                      : observation.state === "not_applicable"
                        ? t("不適用", "Not applicable")
                        : Array.isArray(observation.value)
                          ? observation.value.join(", ")
                          : String(observation.value)}
                  </span>
                );
              })}
            {candidate.identity.cuvee && ` - ${candidate.identity.cuvee}`}
            {candidate.identity.packQuantity != null &&
              ` - ${candidate.identity.packQuantity} ${t("\u74f6\uff0f\u5305", "bottles per pack")}`}
            {candidate.identity.barcode && ` - ${candidate.identity.barcode}`}
            {count > 1 && (
              <span>
                {" "}
                - {count}{" "}
                {t("\u500b\u4f86\u6e90\u53c3\u8003", "source references")}
              </span>
            )}
            {!candidate.confirmationAvailable && (
              <>
                {" "}
                ·{" "}
                {t(
                  "僅供檢視，暫不可確認",
                  "Inspection only; confirmation unavailable",
                )}
              </>
            )}
          </label>
        ))}
        <button
          className="secondary-button"
          type="button"
          disabled={!chosen}
          onClick={() => chosen && onConfirm(chosen)}
        >
          {t("確認所選身份", "Confirm selected identity")}
        </button>
      </fieldset>
    </section>
  );
}
