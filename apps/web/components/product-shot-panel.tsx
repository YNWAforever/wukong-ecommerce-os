"use client";

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
          <p className="eyebrow">
            商品照 <span>PRODUCT SHOT</span>
          </p>
          <h2 id="product-shot-heading">背景預覽</h2>
        </div>
      </div>
      <div
        className="product-shot-preview"
        style={backgroundStyleFor(choice, brandBackgroundColor)}
      >
        <img src={previewUrl} alt="商品照預覽" />
      </div>
      <div className="product-shot-toggle" role="group" aria-label="背景選擇">
        <button
          type="button"
          className={
            choice === "white" ? "secondary-button active" : "secondary-button"
          }
          aria-pressed={choice === "white"}
          onClick={() => select("white")}
        >
          白底 White
        </button>
        <button
          type="button"
          className={
            choice === "brand" ? "secondary-button active" : "secondary-button"
          }
          aria-pressed={choice === "brand"}
          disabled={!brandBackgroundColor}
          aria-label={
            brandBackgroundColor ? undefined : "品牌背景 — 尚未設定品牌背景色"
          }
          title={brandBackgroundColor ? undefined : "尚未設定品牌背景色"}
          onClick={() => select("brand")}
        >
          品牌背景 Brand
        </button>
      </div>
    </section>
  );
}
