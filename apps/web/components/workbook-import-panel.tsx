"use client";
import { useEffect, useRef, useState } from "react";
import type { WorkbookSaveResult } from "@wukong/db";
import type { workbookPreview } from "../lib/workbook-import";
import type { BulkFormIssueCode } from "@wukong/shopline";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import styles from "./workbook-import-panel.module.css";
type Preview = ReturnType<typeof workbookPreview>;
type Stage = "preview" | "save";
const issueLabels: Record<BulkFormIssueCode, [string, string]> = {
  header_row_missing: ["找不到標題列", "Header row missing"],
  column_contract_mismatch: ["欄位不符合支援格式", "Unsupported column layout"],
  row_too_short: ["資料列缺少欄位", "Row has missing columns"],
  product_id_missing: ["缺少商品 ID", "Product ID missing"],
  product_id_duplicated: ["重複的商品 ID", "Duplicate Product ID"],
  sku_missing: ["缺少 SKU", "SKU missing"],
  quantity_unlimited_sentinel: [
    "數量已標記為無限",
    "Quantity marked unlimited",
  ],
  quantity_negative: ["數量不能為負數", "Negative quantity"],
  price_negative: ["價格不能為負數", "Negative price"],
  number_not_numeric: ["數值格式無效", "Invalid number"],
  flag_not_recognized: ["未識別的標記", "Unrecognized flag"],
  categories_missing: ["未有分類", "Categories missing"],
  variant_row_blocked: [
    "暫不支援變體資料列；已保留來源證據",
    "Variant rows unsupported; source evidence retained",
  ],
  quantity_delta_not_neutral: [
    "來源包含數量調整",
    "Source contains a quantity adjustment",
  ],
};
export function WorkbookImportPanel({
  canImport = false,
}: {
  canImport?: boolean;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [result, setResult] = useState<WorkbookSaveResult | null>(null),
    [stage, setStage] = useState<Stage | null>(null),
    [failed, setFailed] = useState<Stage | null>(null),
    [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    busy = useRef(false);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!canImport) {
      generation.current++;
      controller.current?.abort();
      busy.current = false;
      setStage(null);
    }
  }, [canImport]);
  async function run(next: Stage, selected: File, snapshot: Preview | null) {
    if (
      !canImport ||
      busy.current ||
      (next === "save" && (!snapshot || snapshot.eligibleProducts === 0))
    )
      return;
    const own = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    busy.current = true;
    setStage(next);
    setError(null);
    setFailed(null);
    try {
      const response = await fetch(
        `/api/workbook-imports${next === "preview" ? "/preview" : ""}?${new URLSearchParams({ filename: selected.name })}`,
        {
          method: "POST",
          body: selected,
          cache: "no-store",
          signal: abort.signal,
          headers: {
            "content-type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ...(next === "save" && snapshot
              ? {
                  "x-workbook-sha256": snapshot.workbookSha256,
                  "x-workbook-header-sha256": snapshot.headerContractSha256,
                }
              : {}),
          },
        },
      );
      const body = await response.json();
      if (own !== generation.current || abort.signal.aborted) return;
      if (!response.ok) {
        const code = body?.code;
        if (response.status === 409) {
          setFailed("preview");
          setError(
            t(
              "檔案或欄位格式已變更，請重新預覽。",
              "The file or column contract changed. Preview again.",
            ),
          );
          return;
        }
        const message =
          response.status === 401
            ? t("請重新登入，然後重試。", "Sign in again, then retry.")
            : response.status === 403
              ? t(
                  "需要操作員或更高權限。",
                  "Operator access or higher is required.",
                )
              : response.status === 413
                ? t(
                    "檔案或來源資料太大，請選擇較小的 XLSX（上限 4 MiB、5,000 列）。",
                    "Workbook or evidence is too large. Choose a smaller XLSX (4 MiB and 5,000 rows maximum).",
                  )
                : code === "workbook_unrecognized"
                  ? t(
                      "欄位不符合支援格式，請選擇 SHOPLINE Bulk Update XLSX。",
                      "Unsupported columns. Choose a SHOPLINE Bulk Update XLSX.",
                    )
                  : response.status === 400 || response.status === 422
                    ? t(
                        "無法讀取商品，請檢查 XLSX 格式及資料列。",
                        "Unable to read products. Check the XLSX format and product rows.",
                      )
                    : t(
                        "暫時無法完成，請重試。",
                        "Unable to complete this request. Please retry.",
                      );
        setFailed(next);
        setError(message);
        return;
      }
      if (next === "preview") setPreview(body as Preview);
      else setResult(body as WorkbookSaveResult);
    } catch {
      if (own === generation.current && !abort.signal.aborted) {
        setFailed(next);
        setError(
          t(
            "暫時無法完成，請重試。",
            "Unable to complete this request. Please retry.",
          ),
        );
      }
    } finally {
      if (own === generation.current) {
        busy.current = false;
        setStage(null);
      }
    }
  }
  function choose(selected: File | null) {
    if (!canImport) return;
    generation.current++;
    controller.current?.abort();
    busy.current = false;
    setFile(selected);
    setPreview(null);
    setResult(null);
    setError(null);
    setFailed(null);
    setStage(null);
    if (selected) void run("preview", selected, null);
  }
  return (
    <section
      aria-label={t("試算表商品匯入", "Workbook product import")}
      className={styles.panel}
    >
      <h2>{t("從 XLSX 匯入商品", "Import products from XLSX")}</h2>
      <p>
        {t(
          "選擇 SHOPLINE Bulk Update XLSX，即可預覽所有可匯入商品。無需連接商店。上限 4 MiB、5,000 列。",
          "Choose a SHOPLINE Bulk Update XLSX to preview eligible products. No store connection needed. Maximum 4 MiB and 5,000 rows.",
        )}
      </p>
      {!canImport && (
        <p role="status">
          {t(
            "需要操作員或更高權限。",
            "Operator access or higher is required.",
          )}
        </p>
      )}
      <div
        className={styles.dropZone}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          choose(e.dataTransfer.files[0] ?? null);
        }}
      >
        <label htmlFor="workbook-import-file">
          {t("拖放 XLSX 或選擇檔案", "Drop XLSX here or choose file")}
        </label>
        <input
          id="workbook-import-file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={!canImport}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
        {file && <p>{file.name}</p>}
      </div>
      {stage && (
        <p role="status">
          {stage === "preview"
            ? t("正在讀取試算表…", "Reading workbook…")
            : t("正在匯入商品…", "Importing products…")}
        </p>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            disabled={!canImport || stage !== null}
            onClick={() => {
              if (file && failed) void run(failed, file, preview);
            }}
          >
            {failed === "preview"
              ? t("重試預覽", "Retry preview")
              : t("重試匯入", "Retry import")}
          </button>
        </div>
      )}
      {preview && (
        <>
          <p>
            {t(
              `${preview.totalRows} 列，共 ${preview.eligibleProducts} 個可匯入商品，${preview.excludedRows} 列已排除，${preview.totalIssues} 項注意事項。`,
              `${preview.totalRows} rows · ${preview.eligibleProducts} eligible · ${preview.excludedRows} excluded · ${preview.totalIssues} issues`,
            )}
          </p>
          {result && (
            <div role="status">
              <p>
                {t(
                  `${result.importedProducts} 個已匯入，${result.alreadyImportedProducts} 個先前已匯入，${result.excludedRows} 列已排除。`,
                  `${result.importedProducts} imported · ${result.alreadyImportedProducts} already imported · ${result.excludedRows} excluded`,
                )}
              </p>
              <a href="/catalog">{t("查看商品目錄", "View catalog")}</a>
            </div>
          )}
          {!result && (
            <button
              type="button"
              className="primary-button"
              disabled={
                !canImport ||
                stage !== null ||
                failed !== null ||
                preview.eligibleProducts === 0
              }
              onClick={() => {
                if (file) void run("save", file, preview);
              }}
            >
              {t(
                `匯入 ${preview.eligibleProducts} 個商品`,
                `Import ${preview.eligibleProducts} products`,
              )}
            </button>
          )}
          <div
            className={styles.tableWrap}
            role="region"
            aria-label={t(
              "商品預覽，可水平捲動",
              "Product preview, horizontally scrollable",
            )}
            tabIndex={0}
          >
            <table>
              <caption>
                {t(
                  `預覽樣本：顯示 ${preview.products.length} / ${preview.eligibleProducts} 個商品（最多 20 個）；匯入將包括全部可匯入商品。`,
                  `Preview sample: showing ${preview.products.length} of ${preview.eligibleProducts} products (maximum 20); import includes every eligible product.`,
                )}
              </caption>
              <thead>
                <tr>
                  {[
                    t("來源列", "Source row"),
                    "Product ID",
                    "SKU",
                    t("商品名稱（中文）", "Title (Chinese)"),
                    t("商品名稱（英文）", "Title (English)"),
                    t("價格（港元）", "Price (HKD)"),
                  ].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.products.map((p) => (
                  <tr key={p.rowNumber}>
                    <td>{p.rowNumber}</td>
                    <td>{p.productId}</td>
                    <td>{p.sku}</td>
                    <td>{p.title["zh-Hant"] ?? "—"}</td>
                    <td>{p.title.en ?? "—"}</td>
                    <td>{p.priceHkd ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.issues.length > 0 && (
            <details
              key={preview.workbookSha256}
              open={preview.eligibleProducts === 0}
            >
              <summary>
                {t(
                  `資料列注意事項：${preview.totalIssues} 項 · ${preview.excludedRows} 列已排除`,
                  `Row issues: ${preview.totalIssues} · ${preview.excludedRows} excluded`,
                )}
              </summary>
              <p>
                {t(
                  `顯示 ${preview.issues.length} / ${preview.totalIssues} 項；請在原始檔案修正已排除的資料列。`,
                  `Showing ${preview.issues.length} of ${preview.totalIssues} issues. Correct excluded rows in the source file.`,
                )}
              </p>
              <ul>
                {preview.issues.map((issue, i) => (
                  <li key={i}>
                    {t("列", "Row")} {issue.row ?? "—"} ·{" "}
                    {issue.severity === "error"
                      ? t("已排除", "Excluded")
                      : t("注意", "Warning")}{" "}
                    ·{" "}
                    {issueLabels[issue.code]
                      ? localized(locale, ...issueLabels[issue.code])
                      : issue.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <details>
            <summary>{t("來源資料", "Source details")}</summary>
            <dl>
              <dt>{t("工作表", "Sheet")}</dt>
              <dd>{preview.sheetName}</dd>
              <dt>{t("推測匯出日期", "Inferred export date")}</dt>
              <dd>
                {preview.inferredExportTime
                  ? t(
                      `${preview.inferredExportTime.value}（從檔名推測；時區未知，未經確認）`,
                      `${preview.inferredExportTime.value} (inferred from filename; timezone unknown, unverified)`,
                    )
                  : t("未知", "Unknown")}
              </dd>
            </dl>
          </details>
        </>
      )}
    </section>
  );
}
