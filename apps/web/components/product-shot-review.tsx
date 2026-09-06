"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ProductShotView } from "../lib/product-shot-service";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
const statusCopy: Record<string, readonly [string, string]> = {
  queued: ["等待處理或每日額度", "Waiting for processing or daily allowance"],
  processing: ["正在移除背景", "Removing background"],
  cutout_ready: ["正在準備白底預覽", "Preparing white-background preview"],
  candidate_ready: [
    "請比較原相片與最終白底商品照",
    "Compare the original photo with the final white-background image",
  ],
  approved: ["已接受商品照", "Image accepted"],
  failed: [
    "商品照處理失敗，可開始新嘗試",
    "Image processing failed. You can start a fresh attempt.",
  ],
  outcome_unknown: [
    "上次處理結果不明，可能已收費",
    "The previous outcome is unknown and may already have been charged.",
  ],
  source_selection_required: ["請選擇一張主相片", "Choose one main photo"],
  no_source: ["請先上載一張商品相片", "Upload a product photo first"],
  not_requested: ["準備開始商品照處理", "Ready to request a product image"],
  setup_required: [
    "商品照服務尚未設定",
    "Product image processing is not configured",
  ],
};
export function ProductShotReview({
  listingId,
  canOperate,
  canApprove,
  legacy,
}: {
  listingId: string;
  canOperate: boolean;
  canApprove: boolean;
  legacy?: ReactNode;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [view, setView] = useState<
    (ProductShotView & { enabled?: boolean }) | null
  >(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [charge, setCharge] = useState(false),
    [selected, setSelected] = useState("");
  const scope = useRef<AbortController | null>(null),
    sequence = useRef(0),
    auto = useRef(new Set<string>());
  const load = useCallback(
    async (signal: AbortSignal) => {
      const revision = ++sequence.current;
      const response = await fetch(`/api/listings/${listingId}/product-shot`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("read_failed");
      const next = await response.json();
      if (!signal.aborted && revision === sequence.current) {
        setView(next);
        setSelected(
          next.sourceAssetId ??
            (next.sources?.length === 1 ? next.sources[0].assetId : ""),
        );
      }
    },
    [listingId],
  );
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    auto.current.clear();
    setView(null);
    setError(false);
    setCharge(false);
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => {
      controller.abort();
      ++sequence.current;
    };
  }, [load]);
  const mutate = useCallback(
    async (
      action: "request" | "prepare" | "approve",
      body: Record<string, unknown>,
    ) => {
      const signal = scope.current?.signal;
      if (!signal || signal.aborted) return;
      ++sequence.current;
      setBusy(true);
      setError(false);
      try {
        const response = await fetch(
          `/api/listings/${listingId}/product-shot${action === "request" ? "" : "/" + action}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          },
        );
        if (!response.ok) throw new Error("action_failed");
        const result = await response.json();
        if (signal.aborted) return;
        if (result.state === "setup_required") {
          setView((v) => (v ? { ...v, state: "setup_required" } : v));
          return;
        }
        await load(signal);
        setCharge(false);
      } catch {
        if (!signal.aborted) setError(true);
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    },
    [listingId, load],
  );
  useEffect(() => {
    if (
      !view?.enabled ||
      !canOperate ||
      busy ||
      error ||
      !view.expectedVersionId
    )
      return;
    const prepare = view.state === "cutout_ready";
    const request = view.state === "not_requested" && view.sources.length === 1;
    if (!prepare && !request) return;
    const key = `${view.attemptId ?? view.sources[0]?.assetId}:${view.expectedVersionId}:${prepare}`;
    if (auto.current.has(key)) return;
    auto.current.add(key);
    void mutate(
      prepare ? "prepare" : "request",
      prepare
        ? {
            attemptId: view.attemptId,
            expectedVersionId: view.expectedVersionId,
          }
        : {
            sourceAssetId: view.sources[0]!.assetId,
            expectedVersionId: view.expectedVersionId,
            explicitFreshAttempt: false,
          },
    );
  }, [view, canOperate, busy, error, mutate]);
  useEffect(() => {
    if (!["queued", "processing"].includes(view?.state ?? "")) return;
    const timer = setInterval(() => {
      const signal = scope.current?.signal;
      if (signal && !signal.aborted && !busy)
        void load(signal).catch(() => {
          if (!signal.aborted) setError(true);
        });
    }, 3000);
    return () => clearInterval(timer);
  }, [view?.state, load, busy]);
  if (view?.enabled === false) return <>{legacy}</>;
  if (!view)
    return error ? (
      <p role="alert">
        {t("無法載入商品照。", "Unable to load product image.")}{" "}
        <button
          type="button"
          onClick={() => {
            const signal = scope.current?.signal;
            if (signal) void load(signal).catch(() => setError(true));
          }}
        >
          {t("重試", "Retry")}
        </button>
      </p>
    ) : null;
  const status = statusCopy[view.state] ?? [
    "請重新整理商品照狀態",
    "Refresh the product image status",
  ];
  return (
    <section
      aria-labelledby={`shot-${listingId}`}
      style={{
        background: "#fff",
        padding: "1rem",
        border: "1px solid var(--border)",
        borderRadius: "12px",
      }}
    >
      <h2 id={`shot-${listingId}`}>
        {t("白底商品照審閱", "White-background image review")}
      </h2>
      <p role="status" aria-live="polite">
        {localized(locale, ...status)}
      </p>
      {error ? (
        <p role="alert">
          {t(
            "操作未能完成。請重試或重新載入。",
            "The action could not be completed. Retry or reload.",
          )}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const signal = scope.current?.signal;
              if (signal)
                void load(signal)
                  .then(() => setError(false))
                  .catch(() => setError(true));
            }}
          >
            {t("重新載入", "Reload")}
          </button>
        </p>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1rem",
        }}
      >
        {view.sourcePreviewUrl ? (
          <figure>
            <img
              src={view.sourcePreviewUrl}
              alt={t("原相片", "Original photo")}
              style={{ width: "100%", maxHeight: 360, objectFit: "contain" }}
            />
            <figcaption>{t("原相片", "Original photo")}</figcaption>
          </figure>
        ) : null}
        {view.candidatePreviewUrl ? (
          <figure style={{ background: "white" }}>
            <img
              src={view.candidatePreviewUrl}
              alt={t("最終白底商品照", "Final white-background image")}
              style={{ width: "100%", maxHeight: 360, objectFit: "contain" }}
            />
            <figcaption>
              {t("將會使用的最終 JPEG", "Exact final JPEG")}
            </figcaption>
          </figure>
        ) : null}
      </div>
      {view.lowResolution ? (
        <p>
          {t(
            "相片解像度較低，商品不會被放大。",
            "Low-resolution photo. The subject has not been enlarged.",
          )}
        </p>
      ) : null}
      {canOperate && view.sources?.length > 1 ? (
        <fieldset disabled={busy}>
          <legend>{t("選擇主相片", "Choose main photo")}</legend>
          {view.sources.map((source, i) => (
            <label
              key={source.assetId}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                margin: 8,
              }}
            >
              <input
                type="radio"
                name={`source-${listingId}`}
                value={source.assetId}
                checked={selected === source.assetId}
                onChange={() => setSelected(source.assetId)}
              />
              <img
                src={source.previewUrl}
                alt={t(`相片 ${i + 1}`, `Photo ${i + 1}`)}
                width={72}
                height={72}
                style={{ objectFit: "contain" }}
              />
              {t(`相片 ${i + 1}`, `Photo ${i + 1}`)}
            </label>
          ))}
          <button
            type="button"
            disabled={!selected || selected === view.sourceAssetId}
            onClick={() =>
              void mutate("request", {
                sourceAssetId: selected,
                expectedVersionId: view.expectedVersionId,
                explicitFreshAttempt: false,
              })
            }
          >
            {t("使用這張相片", "Use this photo")}
          </button>
        </fieldset>
      ) : null}
      {canOperate &&
      view.allowedActions?.includes("request") &&
      view.sources.length === 1 ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void mutate("request", {
              sourceAssetId: view.sources[0]!.assetId,
              expectedVersionId: view.expectedVersionId,
              explicitFreshAttempt: false,
            })
          }
        >
          {t("要求商品照處理", "Request product image")}
        </button>
      ) : null}
      {canOperate && view.allowedActions?.includes("prepare") ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void mutate("prepare", {
              attemptId: view.attemptId,
              expectedVersionId: view.expectedVersionId,
            })
          }
        >
          {t("重試準備預覽", "Retry preparation")}
        </button>
      ) : null}
      {canOperate && view.allowedActions?.includes("retry_queue") ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void mutate("request", {
              sourceAssetId: view.sourceAssetId,
              expectedVersionId: view.expectedVersionId,
              explicitFreshAttempt: false,
            })
          }
        >
          {t("重試排程", "Retry queue")}
        </button>
      ) : null}
      {canApprove &&
      view.allowedActions?.includes("approve") &&
      view.candidatePreviewUrl ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void mutate("approve", {
              attemptId: view.attemptId,
              expectedVersionId: view.expectedVersionId,
              candidateDigest: view.candidateDigest,
            })
          }
        >
          {t("接受此最終商品照", "Accept this exact image")}
        </button>
      ) : null}
      {canOperate && view.allowedActions?.includes("fresh_attempt") ? (
        <div>
          <label>
            <input
              type="checkbox"
              checked={charge}
              disabled={busy}
              onChange={(e) => setCharge(e.target.checked)}
            />
            {t(
              "我明白新嘗試可能再次收費。",
              "I understand a fresh attempt may incur another charge.",
            )}
          </label>
          <button
            type="button"
            disabled={busy || !charge}
            onClick={() =>
              void mutate("request", {
                sourceAssetId: view.sourceAssetId,
                expectedVersionId: view.expectedVersionId,
                explicitFreshAttempt: true,
              })
            }
          >
            {t("開始新嘗試", "Start a fresh attempt")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
