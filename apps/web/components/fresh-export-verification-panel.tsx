"use client";
import { useEffect, useRef, useState } from "react";
import type {
  ExportVerificationWire,
  ExportVerificationHistoryWire,
  RecordExportVerificationWire,
} from "../lib/fresh-export-verification";
import { useLocale } from "../lib/locale-context";
import { localized, formatHkDate } from "../lib/ui-copy";
import { merchantExportTimeToIso } from "./bulk-import-panel";

export function comparisonTimeToIso(value: string): string | null {
  const match = /^(.*T\d{2}:\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match || Number(match[2] ?? 0) > 59) return null;
  const minute = merchantExportTimeToIso(match[1]!);
  return minute
    ? new Date(Date.parse(minute) + Number(match[2] ?? 0) * 1000).toISOString()
    : null;
}

export function FreshExportVerificationPanel({
  attemptId,
}: {
  attemptId: string;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [open, setOpen] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [time, setTime] = useState(""),
    [sameStore, setSameStore] = useState(false);
  const [history, setHistory] = useState<ExportVerificationHistoryWire | null>(
      null,
    ),
    [selected, setSelected] = useState<ExportVerificationWire | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const inFlight = useRef(false),
    historyRequest = useRef(0),
    detailRequest = useRef(0),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      historyRequest.current++;
      detailRequest.current++;
    };
  }, []);
  const endpoint = `/api/listings/export/${encodeURIComponent(attemptId)}/verifications`;
  const retryError = () =>
    t(
      "未能完成比較。輸入已保留，請重試。",
      "Comparison could not be completed. Inputs are retained; please retry.",
    );
  const label = (value: string) =>
    ({
      matches_compared_fields: t("已比較欄位相符", "Matches compared fields"),
      differences_found: t("發現差異", "Differences found"),
      inconclusive: t("未能確定", "Inconclusive"),
      matched: t("相符", "Matched"),
      differences: t("有差異", "Differences"),
      missing: t("缺少商品", "Missing product"),
      ambiguous: t("重複商品 ID", "Ambiguous product ID"),
      unsupported_variant: t("不支援的變體", "Unsupported variant"),
    })[value] ?? value;
  async function loadHistory(page = 1) {
    const request = ++historyRequest.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${endpoint}?page=${page}&pageSize=10`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error();
      const next = (await response.json()) as ExportVerificationHistoryWire;
      if (alive.current && request === historyRequest.current) setHistory(next);
    } catch {
      if (alive.current && request === historyRequest.current)
        setError(
          t(
            "未能載入比較記錄，請重新整理。",
            "Comparison history could not be loaded. Please refresh.",
          ),
        );
    } finally {
      if (alive.current && request === historyRequest.current)
        setLoading(false);
    }
  }
  async function loadDetail(id: string) {
    const request = ++detailRequest.current;
    setSelected(null);
    setError("");
    try {
      const response = await fetch(
        `${endpoint}?${new URLSearchParams({ verificationId: id })}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error();
      const body = (await response.json()) as {
        verification: ExportVerificationWire;
      };
      if (alive.current && request === detailRequest.current)
        setSelected(body.verification);
    } catch {
      if (alive.current && request === detailRequest.current)
        setError(retryError());
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    const iso = comparisonTimeToIso(time);
    if (
      !file ||
      !file.name.toLowerCase().endsWith(".xlsx") ||
      file.size === 0 ||
      file.size > 4 * 1024 * 1024 ||
      !iso ||
      !sameStore
    ) {
      setError(
        t(
          "請選擇 4 MiB 內的 XLSX、輸入有效香港匯出時間，並確認同一商店。",
          "Choose an XLSX up to 4 MiB, enter a valid Hong Kong export time, and confirm the same store.",
        ),
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    const request = ++detailRequest.current;
    try {
      const params = new URLSearchParams({
        filename: file.name,
        merchantAttestedExportAt: iso,
        sameStoreAttested: "true",
      });
      const response = await fetch(`${endpoint}?${params}`, {
        method: "POST",
        body: file,
      });
      if (!response.ok) {
        const body = (await response.json()) as { code?: string };
        if (body.code === "comparison_export_time_invalid")
          throw new Error("time");
        throw new Error();
      }
      const body = (await response.json()) as RecordExportVerificationWire;
      if (alive.current) {
        if (request === detailRequest.current) setSelected(body.verification);
        await loadHistory(1);
      }
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error && cause.message === "time"
            ? t(
                "匯出時間必須晚於檔案準備時間，且不可在未來。",
                "Export time must be after artifact readiness and cannot be in the future.",
              )
            : retryError(),
        );
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className="fresh-export-panel"
      aria-label={t("最新匯出比較", "Fresh export comparison")}
    >
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && !history) void loadHistory();
        }}
      >
        {t("比較最新匯出", "Compare fresh export")}
      </button>
      {open && (
        <div>
          <h4>{t("所提供快照比較", "Supplied snapshot comparison")}</h4>
          <p>
            {t(
              "所提供快照；商店及時間由操作員聲明。原始 XLSX 不會保留，亦無法下載。",
              "Supplied snapshot; store and time operator-attested. Original supplied XLSX bytes are not retained or downloadable.",
            )}
          </p>
          <p className="helper-copy">
            {t(
              "比較 8 個預期內容欄位及 61 個受保護欄位的標準化字串。受保護欄位差異只屬觀察，並不證明成因。另列 2 個庫存增減指令，不能證明庫存不變。不核實原始 Excel 類型或格式、商家來源、實際套用或目前 SHOPLINE 即時狀態；操作員回報及未核實狀態不變。",
              "Compares normalized strings in 8 intended content and 61 protected fields. Protected differences are observations, not causation claims. The 2 quantity-delta instructions are separate and cannot establish stock neutrality. This does not verify raw Excel types/styles, authenticated merchant origin, causal application or current live SHOPLINE truth. Operator reports and unverified status remain unchanged.",
            )}
          </p>
          <form onSubmit={submit} noValidate>
            <fieldset disabled={busy}>
              <label>
                {t("最新 SHOPLINE XLSX", "Fresh SHOPLINE XLSX")}
                <input
                  type="file"
                  accept=".xlsx"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <label>
                {t(
                  "SHOPLINE 匯出時間（香港 UTC+08:00）",
                  "SHOPLINE export time (Hong Kong UTC+08:00)",
                )}
                <input
                  type="datetime-local"
                  step="1"
                  value={time}
                  onInput={(e) => setTime(e.currentTarget.value)}
                  onChange={(e) => setTime(e.target.value)}
                />
              </label>
              <p className="helper-copy">
                {t(
                  "明確輸入晚於交付檔案準備時間的匯出時間；不會使用檔案時間。",
                  "Enter the export time explicitly, after delivered artifact readiness; file timestamps are not used.",
                )}
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={sameStore}
                  onChange={(e) => setSameStore(e.target.checked)}
                />
                {t(
                  "我確認此快照來自同一 SHOPLINE 商店。",
                  "I confirm this snapshot is from the same SHOPLINE store.",
                )}
              </label>
              <button type="submit" className="primary-button">
                {busy
                  ? t("比較中…", "Comparing…")
                  : t("記錄快照比較", "Record snapshot comparison")}
              </button>
            </fieldset>
          </form>
          {error && <p role="alert">{error}</p>}
          <h4>{t("比較記錄", "Comparison history")}</h4>
          <button
            type="button"
            className="secondary-button"
            disabled={loading || busy}
            onClick={() => void loadHistory(history?.page ?? 1)}
          >
            {t("重新整理比較記錄", "Refresh comparison history")}
          </button>
          {loading && <p role="status">{t("載入中…", "Loading…")}</p>}
          {history && (
            <>
              <p>
                {t("頁", "Page")} {history.page} · {t("每頁最多", "Up to")}{" "}
                {history.pageSize} {t("筆；總共", "per page; total")}{" "}
                {history.total}
              </p>
              <ul>
                {history.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void loadDetail(item.id)}
                    >
                      {item.filename} · {label(item.comparison.outcome)} ·{" "}
                      {formatHkDate(item.merchantAttestedExportAt, locale)}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={loading || busy || history.page <= 1}
                onClick={() => void loadHistory(history.page - 1)}
              >
                {t("上一頁", "Previous page")}
              </button>{" "}
              <button
                type="button"
                disabled={
                  loading ||
                  busy ||
                  history.page * history.pageSize >= history.total
                }
                onClick={() => void loadHistory(history.page + 1)}
              >
                {t("下一頁", "Next page")}
              </button>
            </>
          )}
          {selected && (
            <div data-verification-id={selected.id}>
              <h4>{label(selected.comparison.outcome)}</h4>
              <p>
                {selected.filename} ·{" "}
                {formatHkDate(selected.merchantAttestedExportAt, locale)}
              </p>
              <dl className="reconciliation-counts">
                {Object.entries(selected.comparison.counts).map(
                  ([key, value]) => (
                    <div key={key}>
                      <dt>
                        {
                          (
                            {
                              expected: t("預期商品", "Expected products"),
                              matched: t("相符商品", "Matched products"),
                              differences: t(
                                "差異商品",
                                "Products with differences",
                              ),
                              missing: t("缺少商品", "Missing products"),
                              ambiguous: t("重複 ID", "Ambiguous IDs"),
                              unsupportedVariant: t(
                                "不支援變體",
                                "Unsupported variants",
                              ),
                              unrelatedRows: t("無關資料列", "Unrelated rows"),
                              suppliedRows: t("提供資料列", "Supplied rows"),
                            } as Record<string, string>
                          )[key]
                        }
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ),
                )}
              </dl>
              <p>
                {t("比較 ID", "Comparison ID")}: <code>{selected.id}</code>
                <br />
                {t("商店連接", "Store connection")}:{" "}
                <code>{selected.connectionId}</code>
                <br />
                {t("檔案 SHA-256", "Artifact SHA-256")}:{" "}
                <code>{selected.artifactSha256}</code>
                <br />
                {t("快照 SHA-256", "Snapshot SHA-256")}:{" "}
                <code>{selected.suppliedSha256}</code>
                <br />
                {t("記錄人", "Recorded by")}: {selected.recordedBy} ·{" "}
                {formatHkDate(selected.createdAt, locale)} ·{" "}
                {selected.policyVersion}
              </p>
              {selected.comparison.products.map((product) => (
                <details key={product.productId}>
                  <summary>
                    {product.productId} · {label(product.outcome)}
                  </summary>
                  <p>
                    {t("交付列", "Delivered row")}{" "}
                    {product.expectedRow.rowNumber} ·{" "}
                    {t("快照列", "Snapshot rows")}:{" "}
                    {product.observedRows
                      .map((row) => row.rowNumber)
                      .join(", ") || t("無", "None")}
                  </p>
                  {product.fields.length > 0 ? (
                    <>
                      <p>
                        {t(
                          "69 個欄位：8 個預期內容、61 個受保護欄位",
                          "69 fields: 8 intended content, 61 protected",
                        )}
                      </p>
                      <ul>
                        {product.fields
                          .filter((field) => field.different)
                          .map((field) => (
                            <li key={field.column}>
                              <strong>{field.column}</strong> ·{" "}
                              {field.category === "intended"
                                ? t("預期內容", "Intended content")
                                : t("受保護", "Protected")}
                              <div>
                                {t("預期", "Expected")}:{" "}
                                <code>
                                  {field.expected === null
                                    ? t("空白", "Blank")
                                    : JSON.stringify(field.expected)}
                                </code>
                              </div>
                              <div>
                                {t("觀察", "Observed")}:{" "}
                                <code>
                                  {field.observed === null
                                    ? t("空白", "Blank")
                                    : JSON.stringify(field.observed)}
                                </code>
                              </div>
                            </li>
                          ))}
                      </ul>
                      <h5>
                        {t(
                          "庫存增減指令觀察（分開列示）",
                          "Quantity-delta observations (separate)",
                        )}
                      </h5>
                      <ul>
                        {product.quantityDeltaObservations.map((field) => (
                          <li key={field.column}>
                            {field.column}: {t("預期", "Expected")}{" "}
                            {JSON.stringify(field.expected)} →{" "}
                            {t("觀察", "Observed")}{" "}
                            {JSON.stringify(field.observed)}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p>
                      {t(
                        "未比較欄位，並不代表相符。",
                        "Fields were not compared; this does not mean matched.",
                      )}
                    </p>
                  )}
                </details>
              ))}
              <details>
                <summary>
                  {t(
                    "完整標準化證據及版本綁定",
                    "Complete normalized evidence and version bindings",
                  )}
                </summary>
                <pre>
                  {JSON.stringify(
                    {
                      provenance: selected.provenance,
                      products: selected.comparison.products,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
