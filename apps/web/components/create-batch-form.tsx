"use client";

import { useState } from "react";

import { useLocale } from "../lib/locale-context";
import {
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
  label: string;
  gap: EnrichmentGap;
  budgetUsd: number;
  waveSize: number;
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

export function CreateBatchForm({ onCreated }: { onCreated?: () => void }) {
  const locale = useLocale();
  const [label, setLabel] = useState("");
  const [gap, setGap] = useState<EnrichmentGap>("untranslatedName");
  const [budgetUsd, setBudgetUsd] = useState("");
  const [waveSize, setWaveSize] = useState("3");
  const [outcome, setOutcome] = useState<CreateBatchOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);
    const result = await submitCreateBatch({
      label,
      gap,
      budgetUsd: Number(budgetUsd),
      waveSize: Number(waveSize),
    });
    setOutcome(result);
    setBusy(false);
    if (result.kind === "success") {
      onCreated?.();
    }
  }

  return (
    <form className="intake-form" onSubmit={handleSubmit}>
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
      <button type="submit" className="primary-button" disabled={busy}>
        {busy
          ? localized(locale, "建立中…", "Creating…")
          : localized(locale, "建立批次", "Create batch")}
      </button>
      {outcome && outcome.kind !== "success" ? (
        <p className="intake-message" role="status" aria-live="polite">
          {localized(locale, ...outcome.message)}
        </p>
      ) : null}
    </form>
  );
}
