"use client";
import { useCallback } from "react";
import { z } from "zod";
import { useLatestRequest } from "../lib/use-latest-request";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import type { MaintenanceReference } from "./listing-intake-choices";

export function MaintenanceReferenceSelection({
  reference,
  productId,
  onProductIdChange,
  confirmed,
  onConfirmedChange,
  disabled,
}: {
  reference: MaintenanceReference;
  productId: string;
  onProductIdChange: (id: string) => void;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  disabled: boolean;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch(
        `/api/${reference.kind === "workbook" ? "workbook" : "website"}-products/${encodeURIComponent(reference.id)}`,
        { signal, cache: "no-store" },
      );
      if (!response.ok) throw new Error("Reference unavailable");
      const value: unknown = await response.json();
      if (reference.kind === "workbook") {
        const record = z
          .object({
            canExport: z.literal(false),
            product: z.object({
              productId: z.string(),
              title: z.object({
                en: z.string().nullable().optional(),
                "zh-Hant": z.string().nullable().optional(),
              }),
            }),
          })
          .parse(value);
        return {
          title:
            record.product.title[locale] ??
            record.product.title.en ??
            record.product.productId,
          productIdHint: record.product.productId,
        };
      }
      const record = z
        .object({
          canExport: z.literal(false),
          observation: z.object({ title: z.string() }),
        })
        .parse(value);
      return { title: record.observation.title, productIdHint: null };
    },
    [reference.id, reference.kind, locale],
  );
  const { data, error, reload } = useLatestRequest(
    load,
    "Reference unavailable",
  );
  return (
    <fieldset disabled={disabled}>
      <legend>{t("核對參考商品", "Check the reference product")}</legend>
      {error ? (
        <p role="alert">
          {t(
            "無法讀取此工作區的參考資料。",
            "This workspace reference is unavailable.",
          )}
          <button type="button" onClick={reload}>
            {t("重試", "Retry")}
          </button>
        </p>
      ) : data ? (
        <>
          <p>{data.title}</p>
          {data.productIdHint ? (
            <p>
              {t(
                "參考 Product ID（仍須核對店舖及新匯出檔）",
                "Reference Product ID (still check store and new export)",
              )}
              : <code>{data.productIdHint}</code>{" "}
              <button
                type="button"
                onClick={() => onProductIdChange(data.productIdHint!)}
              >
                {t("填入並核對", "Use and check")}
              </button>
            </p>
          ) : (
            <p>
              {t(
                "網站 SKU／名稱只能作提示，請從新匯出檔找出實際 Product ID。",
                "Website SKU/name are hints. Find the actual Product ID in the new export.",
              )}
            </p>
          )}
          <label htmlFor="maintenance-product-id">
            {t(
              "新匯出檔內的 SHOPLINE Product ID",
              "SHOPLINE Product ID in the new export",
            )}
          </label>
          <input
            id="maintenance-product-id"
            value={productId}
            maxLength={255}
            onChange={(event) => onProductIdChange(event.target.value)}
          />
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => onConfirmedChange(event.target.checked)}
            />
            {t(
              "我已核對實際商品、年份／NV、容量及包裝；缺失資料經人工核實。已知衝突不能以確認略過。",
              "I checked the actual product, vintage/NV, volume and pack, and manually verified missing facts. Confirmation cannot override a known conflict.",
            )}
          </label>
        </>
      ) : (
        <p role="status">{t("載入參考資料…", "Loading reference…")}</p>
      )}
    </fieldset>
  );
}
