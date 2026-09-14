"use client";

import { useState } from "react";

import { useLocale } from "../lib/locale-context";
import {
  localized,
  sharedMessages,
  type BilingualMessage,
} from "../lib/ui-copy";

export type AdvanceBatchSuccess = {
  kind: "success";
  batchId: string;
  status: "running" | "completed" | "budget_exhausted";
  enqueued: number;
  spentUsd: number;
  budgetUsd: number;
};

export type AdvanceBatchFailure =
  | { kind: "api_error"; code: string; message: BilingualMessage }
  | { kind: "network_error"; message: BilingualMessage };

export type AdvanceBatchOutcome = AdvanceBatchSuccess | AdvanceBatchFailure;

export type AdvanceBatchDeps = { fetcher: typeof fetch };

// Only the ApiError codes that advanceBatch's own route and service throw
// directly (apps/web/app/api/enrichment-batches/[id]/advance/route.ts,
// apps/web/lib/enrichment-batch-service.ts#advanceBatch). Generic
// route-support.ts fallbacks (unauthorized, invalid_request,
// authentication_unavailable, internal_error, ...) are not mapped here, same
// as bulk-import-panel.tsx and create-batch-form.tsx: they fall back to the
// server-provided message.
const API_ERROR_MESSAGES: Record<string, BilingualMessage> = {
  insufficient_role: sharedMessages.operatorRequired,
  batch_not_found: sharedMessages.batchNotFound,
};

const ADVANCE_FAILED: BilingualMessage = [
  "此批次未能推進。",
  "The batch could not be advanced.",
];

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
        : ADVANCE_FAILED);
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
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<BilingualMessage | null>(null);

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
        {busy
          ? localized(locale, "推進中…", "Advancing…")
          : localized(locale, "推進下一波", "Advance")}
      </button>
      {message ? (
        <p className="intake-message" role="status" aria-live="polite">
          {localized(locale, ...message)}
        </p>
      ) : null}
    </div>
  );
}
