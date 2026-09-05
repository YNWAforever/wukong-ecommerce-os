"use client";

import { useState } from "react";

export type AdvanceBatchSuccess = {
  kind: "success";
  batchId: string;
  status: "running" | "completed" | "budget_exhausted";
  enqueued: number;
  spentUsd: number;
  budgetUsd: number;
};

export type AdvanceBatchFailure =
  | { kind: "api_error"; code: string; message: string }
  | { kind: "network_error"; message: string };

export type AdvanceBatchOutcome = AdvanceBatchSuccess | AdvanceBatchFailure;

export type AdvanceBatchDeps = { fetcher: typeof fetch };

// Only the ApiError codes that advanceBatch's own route and service throw
// directly (apps/web/app/api/enrichment-batches/[id]/advance/route.ts,
// apps/web/lib/enrichment-batch-service.ts#advanceBatch). Generic
// route-support.ts fallbacks (unauthorized, invalid_request,
// authentication_unavailable, internal_error, ...) are not mapped here, same
// as bulk-import-panel.tsx and create-batch-form.tsx: they fall back to the
// server-provided message.
const API_ERROR_MESSAGES: Record<string, string> = {
  insufficient_role: "Operator access is required.",
  batch_not_found: "This batch no longer exists.",
};

export async function submitAdvanceBatch(
  batchId: string,
  deps: AdvanceBatchDeps = { fetcher: fetch },
): Promise<AdvanceBatchOutcome> {
  const { fetcher } = deps;
  let response: Response;
  try {
    response = await fetcher(`/api/enrichment-batches/${batchId}/advance`, {
      method: "POST",
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
        : "The batch could not be advanced.");
    return { kind: "api_error", code, message };
  }

  return {
    kind: "success",
    batchId: body.batchId as string,
    status: body.status as AdvanceBatchSuccess["status"],
    enqueued: body.enqueued as number,
    spentUsd: body.spentUsd as number,
    budgetUsd: body.budgetUsd as number,
  };
}

export function AdvanceBatchButton({
  batchId,
  onAdvanced,
}: {
  batchId: string;
  onAdvanced?: (outcome: AdvanceBatchOutcome) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setMessage(null);
    const result = await submitAdvanceBatch(batchId);
    if (result.kind !== "success") {
      setMessage(result.message);
    }
    setBusy(false);
    onAdvanced?.(result);
  }

  return (
    <div>
      <button
        type="button"
        className="primary-button"
        disabled={busy}
        onClick={handleClick}
      >
        {busy ? "推進中…" : "推進下一波"} <span>Advance</span>
      </button>
      {message ? (
        <p className="intake-message" role="status" aria-live="polite">
          {message}
        </p>
      ) : null}
    </div>
  );
}
