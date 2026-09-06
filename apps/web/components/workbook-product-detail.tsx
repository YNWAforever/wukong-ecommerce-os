"use client";
import { useCallback } from "react";
import type { WorkbookCatalogProduct } from "@wukong/db";
import { useLatestRequest } from "../lib/use-latest-request";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
export function WorkbookProductDetail({ id }: { id: string }) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch(
        `/api/workbook-products/${encodeURIComponent(id)}`,
        { cache: "no-store", signal },
      );
      if (!response.ok) throw new Error("Unable to load workbook product");
      return (await response.json()) as WorkbookCatalogProduct;
    },
    [id],
  );
  const { data, error, reload } = useLatestRequest(
    load,
    "Unable to load workbook product",
  );
  return (
    <section
      style={{ overflowWrap: "anywhere" }}
      aria-label={t("試算表商品資料", "Workbook product details")}
    >
      {error && (
        <div role="alert">
          {t("無法載入試算表商品。", "Unable to load workbook product.")}
          <button type="button" onClick={reload}>
            {t("重試", "Retry")}
          </button>
        </div>
      )}
      {data ? (
        <article>
          <h3>
            {data.product.title[locale] ??
              data.product.title.en ??
              data.product.title["zh-Hant"] ??
              data.product.sku}
          </h3>
          <p>
            {t(
              "試算表來源・僅供參考，不能匯出或發佈",
              "Workbook source · read only; unavailable for export or publication",
            )}
          </p>
          <dl>
            <dt>{t("商品名稱（中文）", "Title (Chinese)")}</dt>
            <dd>{data.product.title["zh-Hant"] ?? "—"}</dd>
            <dt>{t("商品名稱（英文）", "Title (English)")}</dt>
            <dd>{data.product.title.en ?? "—"}</dd>
            <dt>{t("價格（港元）", "Price (HKD)")}</dt>
            <dd>{data.product.priceHkd ?? "—"}</dd>
            <dt>Product ID</dt>
            <dd>{data.product.productId}</dd>
            <dt>SKU</dt>
            <dd>{data.product.sku}</dd>
            <dt>{t("來源檔案", "Source file")}</dt>
            <dd>{data.source.filename}</dd>
            <dt>{t("工作表", "Sheet")}</dt>
            <dd>{data.source.sheetName}</dd>
          </dl>
          <details>
            <summary>{t("原始來源欄位", "Raw source fields")}</summary>
            <dl>
              {Object.entries(data.product.raw).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd
                    style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
                  >
                    {value ?? "—"}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </article>
      ) : !error ? (
        <p role="status">{t("載入中…", "Loading…")}</p>
      ) : null}
    </section>
  );
}
