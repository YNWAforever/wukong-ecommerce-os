"use client";

import { useEffect, useRef, useState } from "react";
import { contentFields, type ContentField } from "@wukong/core";
import type { BatchPreviewResult } from "../lib/batch-selection";

import { useLocale } from "../lib/locale-context";
import { contentFieldLabel } from "../lib/content-field-labels";
import {
  formatHkDate,
  localized,
  sharedMessages,
  type BilingualMessage,
} from "../lib/ui-copy";

export type EnrichmentGap =
  | "untranslatedName"
  | "untranslatedSeoTitle"
  | "seoTitleMirrorsName"
  | "seoDescriptionMirrorsSeoTitle"
  | "keywordsMirrorName"
  | "summaryMissing";

/**
 * What each gap means, in both languages.
 *
 * These were Chinese only, so an English reader choosing which cohort to
 * enrich picked from a list they could not read.
 */
const GAP_LABELS: Record<EnrichmentGap, BilingualMessage> = {
  untranslatedName: [
    "商品名稱缺少中文翻譯",
    "Product name has no Chinese translation",
  ],
  untranslatedSeoTitle: [
    "SEO 標題缺少中文翻譯",
    "SEO title has no Chinese translation",
  ],
  seoTitleMirrorsName: [
    "SEO 標題與商品名稱相同",
    "SEO title repeats the product name",
  ],
  seoDescriptionMirrorsSeoTitle: [
    "SEO 描述與 SEO 標題相同",
    "SEO description repeats the SEO title",
  ],
  keywordsMirrorName: [
    "關鍵字與商品名稱相同",
    "Keywords repeat the product name",
  ],
  summaryMissing: ["缺少商品摘要", "Product summary is missing"],
};

export type CreateBatchFormInput = {
  previewId: string;
  digest: string;
  idempotencyKey: string;
};

export type CreateBatchSuccess = {
  kind: "success";
  batchId: string;
  selected: number;
  budgetUsd: number;
  waveSize: number;
};

export type CreateBatchFailure =
  | { kind: "api_error"; code: string; message: BilingualMessage }
  | { kind: "network_error"; message: BilingualMessage };

export type CreateBatchOutcome = CreateBatchSuccess | CreateBatchFailure;

export type CreateBatchDeps = { fetcher: typeof fetch };

// Only the ApiError codes that createEnrichmentBatch's own route and service
// throw directly (apps/web/app/api/enrichment-batches/route.ts,
// apps/web/lib/enrichment-batch-service.ts#createBatch). Generic
// route-support.ts fallbacks (unauthorized, invalid_request,
// authentication_unavailable, internal_error, ...) are not mapped here, same
// as bulk-import-panel.tsx: they fall back to the server-provided message.
const API_ERROR_MESSAGES: Record<string, BilingualMessage> = {
  invalid_budget: [
    "批次預算必須大於零。",
    "A batch needs a budget greater than zero.",
  ],
  invalid_wave_size: [
    "每波數量必須是 1 至 5 的整數。",
    "Wave size must be a whole number from 1 to 5.",
  ],
  empty_cohort: [
    "沒有商品符合該缺口，因此沒有可補充的內容。",
    "No products match that gap, so there is nothing to enrich.",
  ],
  insufficient_role: sharedMessages.operatorRequired,
};

const CREATE_FAILED: BilingualMessage = [
  "此批次未能建立。",
  "The batch could not be created.",
];

export async function submitCreateBatch(
  input: CreateBatchFormInput,
  deps: CreateBatchDeps = { fetcher: fetch },
): Promise<CreateBatchOutcome> {
  const { fetcher } = deps;
  let response: Response;
  try {
    response = await fetcher("/api/enrichment-batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return { kind: "network_error", message: sharedMessages.unreachable };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body reaches here from a platform-level failure (e.g. a
    // 502/504/524 gateway page) rather than the application itself, but the
    // caller cannot tell the difference and does not need to: either way we
    // could not get something usable back from the server.
    return { kind: "network_error", message: sharedMessages.unreachable };
  }

  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code : "unknown_error";
    // A message the server wrote is shown as it stands: translating it here
    // would mean inventing a Chinese version of text we did not write.
    const message: BilingualMessage =
      API_ERROR_MESSAGES[code] ??
      (typeof body.message === "string"
        ? [body.message, body.message]
        : CREATE_FAILED);
    return { kind: "api_error", code, message };
  }

  return {
    kind: "success",
    batchId: body.batchId as string,
    selected: body.selected as number,
    budgetUsd: body.budgetUsd as number,
    waveSize: body.waveSize as number,
  };
}

export function CreateBatchForm({
  onCreated,
  listingIds,
}: {
  onCreated?: () => void;
  listingIds?: string[];
}) {
  const locale = useLocale();
  const [label, setLabel] = useState("");
  const [gap, setGap] = useState<EnrichmentGap>("untranslatedName");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [waveSize, setWaveSize] = useState("3");
  const [outcome, setOutcome] = useState<CreateBatchOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<ContentField[]>(["nameZh"]);
  const [preview, setPreview] = useState<BatchPreviewResult | null>(null);
  const [createKey, setCreateKey] = useState<string | null>(null);
  const [continuation, setContinuation] = useState<string | null>(null);
  const [nextContinuation, setNextContinuation] = useState<string | null>(null);
  const baseInput = {
    label,
    budgetUsd: Number(budgetUsd),
    waveSize: Number(waveSize),
    ...(listingIds
      ? { selection: { mode: "explicit", listingIds, fields } }
      : { gap, fields }),
  };
  const baseInputKey = JSON.stringify(baseInput);
  useEffect(() => {
    setContinuation(null);
    setNextContinuation(null);
  }, [baseInputKey]);
  const requestInput = {
    ...baseInput,
    ...(!listingIds && continuation ? { continuation } : {}),
  };
  const inputKey = JSON.stringify(requestInput);
  const inputKeyRef = useRef(inputKey);
  inputKeyRef.current = inputKey;
  useEffect(() => {
    setPreview(null);
    setCreateKey(null);
    setOutcome(null);
  }, [inputKey]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);
    const key = inputKey;
    if (!preview) {
      try {
        const response = await fetch("/api/enrichment-batches/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: key,
        });
        const body = await response.json();
        if (inputKeyRef.current !== key) return;
        if (!response.ok) {
          const code =
            typeof body.code === "string" ? body.code : "unknown_error";
          setOutcome({
            kind: "api_error",
            code,
            message: API_ERROR_MESSAGES[code] ?? [
              body.message ?? "Preview failed",
              body.message ?? "Preview failed",
            ],
          });
        } else {
          setPreview(body as BatchPreviewResult);
          setCreateKey(crypto.randomUUID());
        }
      } catch {
        if (inputKeyRef.current === key)
          setOutcome({
            kind: "network_error",
            message: sharedMessages.unreachable,
          });
      } finally {
        setBusy(false);
      }
    } else {
      const result = await submitCreateBatch({
        previewId: preview.previewId,
        digest: preview.digest,
        idempotencyKey: createKey!,
      });
      setBusy(false);
      if (inputKeyRef.current !== key) return;
      setOutcome(result);
      if (result.kind === "success") {
        setNextContinuation(preview.scope?.continuation ?? null);
        setPreview(null);
        setCreateKey(null);
        onCreated?.();
      } else if (
        result.kind === "api_error" &&
        result.code !== "internal_error"
      ) {
        setPreview(null);
        setCreateKey(null);
      }
    }
  }

  return (
    <form className="intake-form batch-form" onSubmit={handleSubmit}>
      <label>
        {localized(locale, "名稱", "Label")}
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={200}
          disabled={busy}
          required
        />
      </label>
      {!listingIds ? (
        <label>
          {localized(locale, "缺口類型", "Gap")}
          <select
            value={gap}
            onChange={(e) => setGap(e.target.value as EnrichmentGap)}
            disabled={busy}
          >
            {Object.entries(GAP_LABELS).map(([value, text]) => (
              <option key={value} value={value}>
                {localized(locale, ...text)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>
          {localized(
            locale,
            `這次只處理明確選中的 ${listingIds.length} 件商品。`,
            `Only the ${listingIds.length} explicitly selected products are included.`,
          )}
        </p>
      )}
      <label>
        {localized(locale, "預算 (USD)", "Budget (USD)")}
        <input
          type="number"
          step="0.01"
          min={0.01}
          max={10000}
          value={budgetUsd}
          onChange={(e) => setBudgetUsd(e.target.value)}
          disabled={busy}
          required
        />
      </label>
      <label>
        {localized(locale, "每波數量 (1-5)", "Wave size (1-5)")}
        <input
          type="number"
          min={1}
          max={5}
          value={waveSize}
          onChange={(e) => setWaveSize(e.target.value)}
          disabled={busy}
          required
        />
      </label>
      <fieldset className="batch-field-options" disabled={busy}>
        <legend>
          {localized(locale, "允許修改的內容欄位", "Content fields to change")}
        </legend>
        {contentFields.map((field) => (
          <label key={field}>
            <input
              type="checkbox"
              checked={fields.includes(field)}
              onChange={(event) =>
                setFields((current) =>
                  event.target.checked
                    ? [...current, field]
                    : current.filter((value) => value !== field),
                )
              }
            />
            {contentFieldLabel(field, locale)}
          </label>
        ))}
      </fieldset>
      {preview ? (
        <section
          className="batch-preview"
          aria-label={localized(locale, "批次預覽", "Batch preview")}
        >
          <p>
            {localized(
              locale,
              `選中 ${preview.selectedCount}；合資格 ${preview.eligibleCount}；每波 ${preview.waveSize} 件。`,
              `Selected ${preview.selectedCount}; eligible ${preview.eligibleCount}; ${preview.waveSize} per wave.`,
            )}
          </p>
          <p>
            {localized(locale, "修改欄位", "Fields")}:{" "}
            {preview.fields
              .map((field) => contentFieldLabel(field, locale))
              .join(locale === "en" ? ", " : "、")}
          </p>
          <p>
            {localized(locale, "最高預計成本", "Maximum estimated cost")}:{" "}
            {preview.maxCostUsd === null
              ? localized(
                  locale,
                  "未知：未有核准的定價上限",
                  "Unknown: reviewed pricing bounds are unavailable",
                )
              : `USD ${preview.maxCostUsd.toFixed(6)}`}
            ; {localized(locale, "批次預算", "Batch budget")}: USD{" "}
            {preview.budgetUsd}
          </p>
          {Object.entries(preview.skippedByReason).map(([reason, count]) => (
            <p key={reason}>
              {localized(
                locale,
                ...((
                  {
                    requires_legal_reopen: [
                      "需先重新開啟商品",
                      "Reopen the product before generation",
                    ],
                    missing_current_content: [
                      "缺少目前內容",
                      "Current content is missing",
                    ],
                    invalid_current_content: [
                      "目前內容需要修正",
                      "Current content needs repair",
                    ],
                    save_current_inputs: [
                      "需先儲存商品資料",
                      "Save product inputs first",
                    ],
                    confirm_pack_quantity: [
                      "需先人工確認包裝數量",
                      "Confirm the package quantity first",
                    ],
                  } as Record<string, BilingualMessage>
                )[reason] ?? [
                  "需先修正商品資料",
                  "Repair the product input first",
                ]),
              )}
              : {count}
            </p>
          ))}
          {preview.scope ? (
            <p>
              {localized(
                locale,
                `已掃描 ${preview.scope.scannedCount}；符合 ${preview.scope.totalMatching}；本批 ${preview.selectedCount}。`,
                `Scanned ${preview.scope.scannedCount}; matching ${preview.scope.totalMatching}; this batch ${preview.selectedCount}.`,
              )}
              {preview.scope.truncated
                ? localized(
                    locale,
                    " 尚有商品未納入，需另建預覽。",
                    " More products remain and require another preview.",
                  )
                : ""}
            </p>
          ) : null}
          <p>
            {localized(locale, "預覽到期時間", "Preview expires")}:{" "}
            {formatHkDate(preview.expiresAt, locale)}
          </p>
          <p>
            {localized(
              locale,
              "人工鎖定值優先保留；任何內容或來源變更都需要重新預覽。建立後仍需明確開始波次。",
              "Human values and locks are retained. Changed content or sources require a new preview. Starting a wave is a separate action.",
            )}
          </p>
        </section>
      ) : null}
      <button
        type="submit"
        className="primary-button"
        disabled={
          busy ||
          fields.length === 0 ||
          Boolean(listingIds && !listingIds.length) ||
          Boolean(preview && preview.eligibleCount === 0)
        }
      >
        {busy
          ? localized(locale, "建立中…", "Creating…")
          : preview
            ? localized(locale, "確認建立批次", "Confirm create batch")
            : localized(locale, "預覽批次", "Preview batch")}
      </button>
      {outcome?.kind === "success" && nextContinuation && !listingIds ? (
        <button
          type="button"
          onClick={() => {
            setContinuation(nextContinuation);
            setNextContinuation(null);
          }}
        >
          {localized(
            locale,
            "預覽其餘符合的商品",
            "Preview the remaining matching products",
          )}
        </button>
      ) : null}
      {outcome && outcome.kind !== "success" ? (
        <p className="intake-message" role="status" aria-live="polite">
          {localized(locale, ...outcome.message)}
        </p>
      ) : null}
    </form>
  );
}
