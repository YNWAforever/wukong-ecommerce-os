"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useLocale } from "../lib/locale-context";
import { localized, stateLabel } from "../lib/ui-copy";

type BatchSummary = {
  id: string;
  label: string;
  budgetUsd: number;
  waveSize: number;
  status: "open" | "running" | "completed" | "budget_exhausted" | "cancelled";
  createdBy: string;
  createdAt: string;
};

/**
 * Tone only. The wording comes from `stateLabel`, like every other screen.
 *
 * This map used to carry labels as well, and they drifted: `open` read 待開始
 * here against 開放中 in the shared map. Every badge also printed Chinese and
 * English at once, whichever language the reader had chosen.
 */
const STATUS_TONES: Record<BatchSummary["status"], string> = {
  open: "status-neutral",
  running: "status-neutral",
  completed: "status-success",
  budget_exhausted: "status-danger",
  cancelled: "status-danger",
};

/** Chinese first, then English -- the argument order `localized` takes. */
type Message = readonly [zh: string, en: string];

// Only the insufficient_role code the GET route throws directly
// (apps/web/app/api/enrichment-batches/route.ts). Generic route-support.ts
// fallbacks (unauthorized, invalid_request, authentication_unavailable,
// internal_error, ...) are not mapped here, same as create-batch-form.tsx and
// advance-batch-button.tsx: they fall back to the server-provided message.
const API_ERROR_MESSAGES: Record<string, Message> = {
  insufficient_role: ["需要操作員權限。", "Operator access is required."],
};

const UNREACHABLE: Message = [
  "無法連線至伺服器，請重試。",
  "Could not reach the server. Try again.",
];

const LOAD_FAILED: Message = [
  "無法載入批次清單，請重試。",
  "The batch list could not be loaded.",
];

export function BatchList() {
  const locale = useLocale();
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const [error, setError] = useState<Message | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      let response: Response;
      try {
        response = await fetch("/api/enrichment-batches");
      } catch {
        if (!cancelled) setError(UNREACHABLE);
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = (await response.json()) as Record<string, unknown>;
      } catch {
        // A non-JSON body reaches here from a platform-level failure (e.g. a
        // 502/504/524 gateway page) rather than the application itself, same
        // as create-batch-form.tsx/advance-batch-button.tsx.
        if (!cancelled) setError(UNREACHABLE);
        return;
      }

      if (!response.ok) {
        const code =
          typeof body.code === "string" ? body.code : "unknown_error";
        // A message the server wrote is shown as it stands: translating it
        // here would mean inventing a Chinese version of text we did not write.
        const message: Message =
          API_ERROR_MESSAGES[code] ??
          (typeof body.message === "string"
            ? [body.message, body.message]
            : LOAD_FAILED);
        if (!cancelled) setError(message);
        return;
      }

      if (!cancelled) setBatches((body as { batches: BatchSummary[] }).batches);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <p className="inline-warning" role="alert">
        {localized(locale, ...error)}
      </p>
    );
  }
  if (batches === null) {
    return (
      <p className="intake-message">
        {localized(locale, "載入中…", "Loading…")}
      </p>
    );
  }
  if (batches.length === 0) {
    return (
      <p className="intake-message">
        {localized(locale, "尚無批次紀錄。", "No batches yet.")}
      </p>
    );
  }

  return (
    <ul className="file-list">
      {batches.map((batch) => (
        <li key={batch.id}>
          <Link href={`/batches/${batch.id}`}>{batch.label}</Link>{" "}
          <span className={`batch-status ${STATUS_TONES[batch.status]}`}>
            <span aria-hidden="true" />
            {stateLabel(batch.status, locale)}
          </span>{" "}
          · {localized(locale, "每波", "Wave size")} {batch.waveSize} ·{" "}
          {localized(locale, "預算", "Budget")} ${batch.budgetUsd}
        </li>
      ))}
    </ul>
  );
}
