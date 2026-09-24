"use client";
import { useCallback } from "react";
import { normalizeWebsiteUrl, type WebsiteProduct } from "@wukong/core";
import { useLatestRequest } from "../lib/use-latest-request";
import { useLocale } from "../lib/locale-context";
import { localized, formatHkDate, safeUiError } from "../lib/ui-copy";
export function WebsiteProductDetail({ id }: { id: string }) {
  const locale = useLocale();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const response = await fetch(
        `/api/website-products/${encodeURIComponent(id)}`,
        { cache: "no-store", signal },
      );
      if (!response.ok) throw new Error("Unable to load website product");
      return (await response.json()) as { observation: WebsiteProduct };
    },
    [id],
  );
  const { data, error, reload } = useLatestRequest(
    load,
    "Unable to load website product",
  );
  return (
    <section
      aria-label={localized(locale, "網站商品資料", "Website product details")}
    >
      {error ? (
        <div role="alert">
          {safeUiError(error, locale)}
          <button type="button" onClick={reload}>
            {localized(locale, "重試", "Retry")}
          </button>
        </div>
      ) : null}
      {data ? (
        <WebsiteProductObservation observation={data.observation} />
      ) : !error ? (
        <p role="status">{localized(locale, "載入中…", "Loading…")}</p>
      ) : null}
    </section>
  );
}
export function WebsiteProductObservation({
  observation: p,
}: {
  observation: WebsiteProduct;
}) {
  const locale = useLocale();
  const source = normalizeWebsiteUrl(p.sourceUrl);
  const labels: Record<string, [string, string]> = {
    title: ["商品名稱", "Product title"],
    description: ["描述", "Description"],
    price: ["價格", "Price"],
    availability: ["供應狀況", "Availability"],
    imageUrls: ["圖片", "Images"],
    attributes: ["屬性", "Attributes"],
    brand: ["品牌", "Brand"],
    sku: ["商品編號", "SKU"],
    sourceUrl: ["來源網址", "Source URL"],
    capturedAt: ["擷取時間", "Captured"],
  };
  const label = (key: string) =>
    labels[key] ? localized(locale, ...labels[key]) : key;
  const availability = {
    in_stock: localized(locale, "有現貨", "In stock"),
    out_of_stock: localized(locale, "缺貨", "Out of stock"),
    preorder: localized(locale, "預購", "Preorder"),
    unknown: localized(locale, "未確認", "Unknown"),
  };

  return (
    <article>
      <h3>{p.title}</h3>
      <p>
        {localized(
          locale,
          "網站觀察記錄・僅供參考，不能匯出或發佈",
          "Website observation · read only; unavailable for export or publication",
        )}
      </p>
      {source ? (
        <a href={source} target="_blank" rel="noreferrer noopener">
          {source}
        </a>
      ) : null}
      <dl>
        <dt>{localized(locale, "擷取時間", "Captured")}</dt>
        <dd>
          <time dateTime={p.capturedAt}>
            {formatHkDate(p.capturedAt, locale)}
          </time>
        </dd>
        <dt>{localized(locale, "描述", "Description")}</dt>
        <dd>{p.description ?? "—"}</dd>
        <dt>{localized(locale, "價格", "Price")}</dt>
        <dd>{p.price ? `${p.price.amount} ${p.price.currency}` : "—"}</dd>
        <dt>{localized(locale, "供應狀況", "Availability")}</dt>
        <dd>{availability[p.availability]}</dd>
      </dl>
      <details className="website-evidence">
        <summary>{localized(locale, "來源證據", "Source evidence")}</summary>
        <h4>{localized(locale, "圖片來源", "Image sources")}</h4>
        <ul>
          {p.imageUrls
            .map((url) => normalizeWebsiteUrl(url))
            .filter((url): url is string => url !== null)
            .map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noreferrer noopener">
                  {url}
                </a>
              </li>
            ))}
        </ul>
        <h4>{localized(locale, "屬性", "Attributes")}</h4>
        <dl>
          {Object.entries(p.attributes).map(([key, value]) => (
            <div key={key}>
              <dt>{label(key)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <h4>{localized(locale, "欄位來源", "Field sources")}</h4>
        <dl>
          {Object.entries(p.fieldSources).map(([key, value]) => (
            <div key={key}>
              <dt>{label(key)}</dt>
              <dd>
                {value === "json_ld"
                  ? localized(
                      locale,
                      "JSON-LD 結構化資料",
                      "JSON-LD structured data",
                    )
                  : localized(locale, "網頁 HTML", "Page HTML")}
              </dd>
            </div>
          ))}
        </dl>
      </details>
      {p.warnings.length > 0 && (
        <>
          <h4>{localized(locale, "注意事項", "Warnings")}</h4>
          <ul>
            {p.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}
