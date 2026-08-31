"use client";

import { useState } from "react";

export type EnrichmentGap =
  | "untranslatedName"
  | "untranslatedSeoTitle"
  | "seoTitleMirrorsName"
  | "seoDescriptionMirrorsSeoTitle"
  | "keywordsMirrorName"
  | "summaryMissing";

const GAP_LABELS: Record<EnrichmentGap, string> = {
  untranslatedName: "商品名稱缺少中文翻譯",
  untranslatedSeoTitle: "SEO 標題缺少中文翻譯",
  seoTitleMirrorsName: "SEO 標題與商品名稱相同",
  seoDescriptionMirrorsSeoTitle: "SEO 描述與 SEO 標題相同",
  keywordsMirrorName: "關鍵字與商品名稱相同",
  summaryMissing: "缺少商品摘要",
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
  | { kind: "api_error"; code: string; message: string }
  | { kind: "network_error"; message: string };

export type CreateBatchOutcome = CreateBatchSuccess | CreateBatchFailure;

export type CreateBatchDeps = { fetcher: typeof fetch };

// Only the ApiError codes that createEnrichmentBatch's own route and service
// throw directly (apps/web/app/api/enrichment-batches/route.ts,
// apps/web/lib/enrichment-batch-service.ts#createBatch). Generic
// route-support.ts fallbacks (unauthorized, invalid_request,
// authentication_unavailable, internal_error, ...) are not mapped here, same
// as bulk-import-panel.tsx: they fall back to the server-provided message.
const API_ERROR_MESSAGES: Record<string, string> = {
  invalid_budget: "A batch needs a budget greater than zero.",
  invalid_wave_size: "Wave size must be a whole number from 1 to 5.",
  empty_cohort: "No products match that gap, so there is nothing to enrich.",
  insufficient_role: "Operator access is required.",
};

export async function submitCreateBatch(
  input: CreateBatchFormInput,
  deps: CreateBatchDeps = { fetcher: fetch },
): Promise<CreateBatchOutcome> {
  let response: Response;
  try {
    response = await deps.fetcher("/api/enrichment-batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body reaches here from a platform-level failure (e.g. a
    // 502/504/524 gateway page) rather than the application itself, but the
    // caller cannot tell the difference and does not need to: either way we
    // could not get something usable back from the server.
    return {
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    };
  }

  if (!response.ok) {
    const code = typeof body.code === "string" ? body.code : "unknown_error";
    const message =
      API_ERROR_MESSAGES[code] ??
      (typeof body.message === "string"
        ? body.message
        : "The batch could not be created.");
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
        名稱 <span>Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
        />
      </label>
      <label>
        缺口類型 <span>Gap</span>
        <select
          value={gap}
          onChange={(e) => setGap(e.target.value as EnrichmentGap)}
        >
          {Object.entries(GAP_LABELS).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label>
        預算 (USD) <span>Budget</span>
        <input
          type="number"
          step="0.01"
          value={budgetUsd}
          onChange={(e) => setBudgetUsd(e.target.value)}
          required
        />
      </label>
      <label>
        每波數量 (1-5) <span>Wave size</span>
        <input
          type="number"
          min={1}
          max={5}
          value={waveSize}
          onChange={(e) => setWaveSize(e.target.value)}
          required
        />
      </label>
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? "建立中…" : "建立批次"} <span>Create batch</span>
      </button>
      {outcome && outcome.kind !== "success" ? (
        <p className="intake-message" role="status" aria-live="polite">
          {outcome.message}
        </p>
      ) : null}
    </form>
  );
}
