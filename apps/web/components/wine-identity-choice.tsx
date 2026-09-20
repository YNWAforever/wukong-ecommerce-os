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
        {candidates.map((candidate) => (
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
            {candidate.identity.vintage.year ??
              t("未知／不適用年份", "Unknown / not applicable vintage")}{" "}
            · {candidate.identity.volumeMl ?? t("未知容量", "Unknown volume")}{" "}
            ml ·{" "}
            {candidate.identity.marketVariant ??
              t("未知市場", "Unknown market")}
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
