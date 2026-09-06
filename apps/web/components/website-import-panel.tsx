"use client";
import { useEffect, useRef, useState } from "react";
import { normalizeWebsiteUrl, type WebsiteProduct } from "@wukong/core";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { WebsiteProductObservation } from "./website-product-detail";
type Scan = {
  id: string;
  state: "queued" | "running" | "ready" | "partial" | "failed";
  sourceUrl: string;
  products: WebsiteProduct[];
  warnings: string[];
  progress: { scanned: number; selectedCandidates: number };
};
export function WebsiteImportPanel({ canScan = true }: { canScan?: boolean }) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const warningCopy: Record<string, [string, string]> = {
    document_unavailable: [
      "部分頁面無法讀取，預覽可能不完整。",
      "Some pages could not be read. The preview may be incomplete.",
    ],
    website_scan_unavailable: [
      "掃描服務暫時無法使用，請稍後重試。",
      "The scan service is temporarily unavailable. Please retry later.",
    ],
    product_limit: [
      "已達 20 件商品的預覽上限。",
      "The 20-product preview limit was reached.",
    ],
    robots_disallowed: [
      "網站不允許讀取部分頁面。",
      "The website does not allow some pages to be read.",
    ],
    canonical_disallowed: [
      "網站不允許讀取商品的正式來源頁面。",
      "The website does not allow the product's canonical page to be read.",
    ],
    deadline_exceeded: [
      "已達掃描時間上限，部分資料可能缺漏。",
      "The scan time limit was reached; some information may be missing.",
    ],
    no_products: [
      "找不到可確認的商品資料。",
      "No verifiable product information was found.",
    ],
  };
  const warningMessage = (code: string) =>
    warningCopy[code]
      ? t(...warningCopy[code])
      : t(
          "部分網站資料未能確認，請檢查預覽。",
          "Some website information could not be confirmed. Please review the preview.",
        );
  const [url, setUrl] = useState("");
  const [scan, setScan] = useState<Scan | null>(null);
  const [preview, setPreview] = useState<Scan | null>(null);
  const [keys, setKeys] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<number | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const requestKey = useRef<string | null>(null);
  function persist(id: string | null) {
    const next = new URL(window.location.href);
    if (id) next.searchParams.set("scan", id);
    else next.searchParams.delete("scan");
    window.history.replaceState(
      null,
      "",
      next.pathname + next.search + next.hash,
    );
  }
  function invalidate() {
    ++generation.current;
    request.current?.abort();
    pending.current = false;
    setBusy(false);
  }
  function accept(next: Scan) {
    setScan(next);
    if (next.state === "ready" || next.state === "partial") {
      setPreview(next);
      setKeys([]);
    }
  }
  async function load(id: string) {
    const version = generation.current;
    const controller = new AbortController();
    request.current = controller;
    try {
      const response = await fetch(
        `/api/website-scans/${encodeURIComponent(id)}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) throw response.status;
      const next = (await response.json()) as Scan;
      if (version !== generation.current || controller.signal.aborted) return;
      setUrl(next.sourceUrl);
      accept(next);
      setError(null);
    } catch (cause) {
      if (version === generation.current && !controller.signal.aborted)
        setError(typeof cause === "number" ? cause : 500);
    }
  }
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get("scan");
    if (id && /^[a-zA-Z0-9-]{1,80}$/.test(id)) void load(id);
    return () => {
      ++generation.current;
      request.current?.abort();
    };
    // A persisted scan is restored only on mount; editing the URL starts a new generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!scan || !["queued", "running"].includes(scan.state) || error) return;
    const timer = setTimeout(() => void load(scan.id), 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan, error]);
  async function start() {
    if (!canScan || pending.current) return;
    const normalized = normalizeWebsiteUrl(url);
    if (!normalized) {
      setError(400);
      return;
    }
    invalidate();
    const version = generation.current;
    const controller = new AbortController();
    request.current = controller;
    pending.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    setKeys([]);
    setScan(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/website-scans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: normalized,
          requestKey: requestKey.current,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw response.status;
      const next = (await response.json()) as Scan;
      if (version !== generation.current || controller.signal.aborted) return;
      requestKey.current = null;
      accept(next);
      persist(next.id);
    } catch (cause) {
      if (version === generation.current && !controller.signal.aborted)
        setError(typeof cause === "number" ? cause : 500);
    } finally {
      if (version === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function save() {
    if (
      !canScan ||
      pending.current ||
      !keys.length ||
      !preview ||
      preview.id !== scan?.id
    )
      return;
    const version = generation.current;
    const controller = new AbortController();
    request.current = controller;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/website-scans/${encodeURIComponent(preview.id)}/save`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw response.status;
      const result = (await response.json()) as {
        savedIds: string[];
        alreadySavedIds: string[];
      };
      if (version !== generation.current || controller.signal.aborted) return;
      setSaved(result.savedIds.length + result.alreadySavedIds.length);
      setKeys([]);
    } catch (cause) {
      if (version === generation.current && !controller.signal.aborted)
        setError(typeof cause === "number" ? cause : 500);
    } finally {
      if (version === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  const active = scan?.state === "queued" || scan?.state === "running";
  const previous = preview !== null && preview.id !== scan?.id;
  const status =
    scan?.state === "queued"
      ? t("已排程", "Queued")
      : scan?.state === "running"
        ? t("掃描中", "Scanning")
        : scan?.state === "partial"
          ? t(
              "部分預覽：網站資料可能不完整。",
              "Partial preview: website information may be incomplete.",
            )
          : scan?.state === "failed"
            ? t("掃描失敗，請重試。", "Scan failed. Please retry.")
            : scan?.state === "ready"
              ? t("預覽就緒", "Preview ready")
              : busy
                ? t("正在開始掃描…", "Starting scan…")
                : "";
  return (
    <section
      className="website-import"
      aria-label={t("網站匯入", "Website import")}
    >
      <h2>{t("從網站預覽商品", "Preview products from a website")}</h2>
      <p>
        {t(
          "貼上公開網站網址，最多預覽 20 件商品。無需 SHOPLINE 連線。",
          "Paste a public website URL to preview up to 20 products. No SHOPLINE connection required.",
        )}
      </p>
      <p>
        {t(
          "儲存的資料僅供參考，不能匯出或發佈。",
          "Saved observations are read only and unavailable for export or publication.",
        )}
      </p>
      {!canScan && (
        <p role="status">
          {t(
            "需要操作員或以上權限以掃描和儲存。",
            "Operator access or higher is required to scan and save.",
          )}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
        noValidate
      >
        <label htmlFor="website-url">{t("網站網址", "Website URL")}</label>
        <input
          id="website-url"
          type="url"
          value={url}
          maxLength={4096}
          autoComplete="url"
          placeholder="https://store.example/"
          onChange={(event) => {
            invalidate();
            requestKey.current = null;
            setUrl(event.target.value);
            setScan(null);
            setPreview(null);
            setKeys([]);
            setError(null);
            setSaved(null);
            persist(null);
          }}
        />
        <button
          type="submit"
          className="primary-button"
          disabled={!canScan || busy || active}
        >
          {t("預覽商品", "Preview products")}
        </button>
      </form>
      <p role="status" aria-live="polite">
        {status}
        {scan && (
          <span>
            {" "}
            · {scan.progress.scanned}/20{" "}
            {t("商品頁已檢查", "product pages checked")}
          </span>
        )}
      </p>
      {error !== null && (
        <div role="alert">
          {error === 401
            ? t("登入已逾時，請重新登入。", "Session expired. Sign in again.")
            : error === 403
              ? t(
                  "需要操作員或以上權限。",
                  "Operator access or higher is required.",
                )
              : error === 400
                ? t(
                    "請輸入公開 HTTPS 網址。",
                    "Enter a valid public HTTPS website URL.",
                  )
                : t(
                    "無法完成要求，請重試。",
                    "Unable to complete the request. Please retry.",
                  )}
        </div>
      )}
      {scan?.warnings.length ? (
        <ul aria-label={t("注意事項", "Warnings")}>
          {scan.warnings.map((warning, i) => (
            <li key={i}>{warningMessage(warning)}</li>
          ))}
        </ul>
      ) : null}
      {(error !== null ||
        scan?.state === "failed" ||
        scan?.state === "partial") && (
        <button
          type="button"
          disabled={busy || !canScan}
          onClick={() => {
            if (active && error) {
              setError(null);
              void load(scan!.id);
            } else void start();
          }}
        >
          {t("重試掃描", "Retry scan")}
        </button>
      )}
      {previous && (
        <p role="status">
          {t(
            "上次預覽：新掃描完成後才能選取。",
            "Previous preview: selection is available after the new scan finishes.",
          )}
        </p>
      )}
      {preview && (
        <div className="website-preview">
          {preview.products.map((product) => (
            <div className="website-preview-card" key={product.key}>
              <label className="website-product-select">
                <input
                  type="checkbox"
                  aria-label={product.title}
                  checked={keys.includes(product.key)}
                  disabled={busy || previous || !canScan}
                  onChange={(event) =>
                    setKeys((old) =>
                      event.target.checked
                        ? [...old, product.key]
                        : old.filter((key) => key !== product.key),
                    )
                  }
                />
                {t("選取", "Select")} {product.title}
              </label>
              <WebsiteProductObservation observation={product} />
            </div>
          ))}
          <button
            type="button"
            className="primary-button"
            disabled={busy || previous || !canScan || keys.length === 0}
            onClick={() => void save()}
          >
            {t("儲存已選商品", "Save selected products")}
          </button>
        </div>
      )}
      {saved !== null && (
        <p role="status">
          {locale === "en"
            ? `${saved} product${saved === 1 ? "" : "s"} saved`
            : `已儲存 ${saved} 件商品`}{" "}
          · <a href="/catalog">{t("查看商品目錄", "View catalog")}</a>
        </p>
      )}
    </section>
  );
}
