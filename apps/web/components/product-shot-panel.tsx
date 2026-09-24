"use client";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";

import { useState } from "react";

export type BackgroundChoice = "white" | "brand";

export function backgroundStyleFor(
  choice: BackgroundChoice,
  brandBackgroundColor: string | null,
): { backgroundColor: string } {
  if (choice === "brand" && brandBackgroundColor) {
    return { backgroundColor: brandBackgroundColor };
  }
  return { backgroundColor: "#ffffff" };
}

export type ProductShotPanelProps = {
  previewUrl: string;
  brandBackgroundColor: string | null;
  onChoiceChange?: (choice: BackgroundChoice) => void;
};

export function ProductShotPanel({
  previewUrl,
  brandBackgroundColor,
  onChoiceChange,
}: ProductShotPanelProps) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [choice, setChoice] = useState<BackgroundChoice>("white");

  const select = (next: BackgroundChoice) => {
    setChoice(next);
    onChoiceChange?.(next);
  };

  return (
    <section
      className="product-shot-panel"
      aria-labelledby="product-shot-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t("商品照", "Product shot")}</p>
          <h2 id="product-shot-heading">
            {t("背景預覽", "Background preview")}
          </h2>
        </div>
      </div>
      <div
        className="product-shot-preview"
        style={backgroundStyleFor(choice, brandBackgroundColor)}
      >
        <img src={previewUrl} alt={t("商品照預覽", "Product shot preview")} />
      </div>
      <div
        className="product-shot-toggle"
        role="group"
        aria-label={t("背景選擇", "Background choice")}
      >
        <button
          type="button"
          className={
            choice === "white" ? "secondary-button active" : "secondary-button"
          }
          aria-pressed={choice === "white"}
          onClick={() => select("white")}
        >
          {t("白底", "White")}
        </button>
        <button
          type="button"
          className={
            choice === "brand" ? "secondary-button active" : "secondary-button"
          }
          aria-pressed={choice === "brand"}
          disabled={!brandBackgroundColor}
          aria-label={
            brandBackgroundColor
              ? undefined
              : t(
                  "品牌背景 — 尚未設定品牌背景色",
                  "Brand background — brand color is not configured",
                )
          }
          title={
            brandBackgroundColor
              ? undefined
              : t("尚未設定品牌背景色", "Brand color is not configured")
          }
          onClick={() => select("brand")}
        >
          {t("品牌背景", "Brand")}
        </button>
      </div>
    </section>
  );
}
