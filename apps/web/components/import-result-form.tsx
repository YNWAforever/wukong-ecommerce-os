"use client";
import { useLocale } from "../lib/locale-context";
import {
  localized,
  formatHkDate,
  formatNumber,
  stateLabel,
  safeUiError,
} from "../lib/ui-copy";

import { useId, useRef, useState } from "react";

export type ImportResultReceipt = {
  id: string;
  outcome: "accepted" | "rejected";
  rejectReason: string | null;
  correctionReason: string | null;
  revision: number;
  createdAt: string;
};

export function ImportResultHistory({
  label,
  results,
}: {
  label: string;
  results: readonly ImportResultReceipt[];
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  if (results.length === 0) return null;
  return (
    <details>
      <summary>{label}</summary>
      <ol>
        {results.map((result) => (
          <li key={result.id}>
            {t("修訂", "Revision")} {formatNumber(result.revision, locale)}:{" "}
            {stateLabel(result.outcome, locale)} ·{" "}
            <time dateTime={result.createdAt}>
              {formatHkDate(result.createdAt, locale)}
            </time>
            {result.rejectReason
              ? ` — ${t("拒絕原因：", "Rejection reason:")} ${result.rejectReason}`
              : ""}
            {result.correctionReason
              ? ` — ${t("更正原因：", "Correction reason:")} ${result.correctionReason}`
              : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}
type ImportResultFormProps = {
  listingId: string;
  unavailable?: boolean;
  latestResult?: ImportResultReceipt | null;
  onRecorded?: () => void | Promise<void>;
} & (
  | { mode: "export"; versionId: string; exportAttemptId: string }
  | { mode: "historical_manual"; versionId?: never; exportAttemptId?: never }
);

export function ImportResultForm({
  listingId,
  unavailable = false,
  versionId,
  exportAttemptId,
  latestResult = null,
  mode,
  onRecorded,
}: ImportResultFormProps) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const messageId = useId();
  const [outcome, setOutcome] = useState<"accepted" | "rejected">("accepted");
  const [rejectReason, setRejectReason] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const payloadRef = useRef<string | null>(null);
  const inFlight = useRef(false);

  const retryContext = useRef<{
    intent: string;
    predecessor: ImportResultReceipt | null;
  } | null>(null);
  const intent = JSON.stringify({
    listingId,
    mode,
    exportAttemptId,
    versionId,
    outcome,
    rejectReason: rejectReason.trim(),
    correctionReason: correctionReason.trim(),
  });
  // A receipt refresh must not turn an ambiguous retry into a new correction.
  // Changed operator input starts a new intent against the latest evidence.
  const predecessor =
    retryContext.current?.intent === intent
      ? retryContext.current.predecessor
      : latestResult;

  async function submit() {
    if (inFlight.current || unavailable) return;
    const payload = {
      mode,
      outcome,
      ...(outcome === "rejected" ? { rejectReason: rejectReason.trim() } : {}),
      ...(mode === "export" ? { exportAttemptId, versionId } : {}),
      ...(predecessor
        ? {
            supersedesResultId: predecessor.id,
            correctionReason: correctionReason.trim(),
          }
        : {}),
    };
    const identity = JSON.stringify(payload);
    if (payloadRef.current !== identity) {
      payloadRef.current = identity;
      keyRef.current = crypto.randomUUID();
    }
    retryContext.current = { intent, predecessor };
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await fetch(
        `/api/listings/${listingId}/shopline-import-result`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, idempotencyKey: keyRef.current }),
        },
      );
      if (!response.ok) {
        throw new Error(`Unable to record result (${response.status})`);
      }
      setMessage("recorded");
      await onRecorded?.();
      keyRef.current = null;
      payloadRef.current = null;
      retryContext.current = null;
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "action_failed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const invalid =
    (outcome === "rejected" && !rejectReason.trim()) ||
    (!!predecessor && !correctionReason.trim());
  return (
    <form
      className="result-form"
      hidden={unavailable}
      style={unavailable ? { display: "none" } : undefined}
      aria-busy={busy}
      aria-describedby={message ? messageId : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        {t("結果", "Outcome")}
        <select
          value={outcome}
          onChange={(event) =>
            setOutcome(event.target.value as "accepted" | "rejected")
          }
        >
          <option value="accepted">{t("操作員回報接受", "Accepted")}</option>
          <option value="rejected">{t("操作員回報拒絕", "Rejected")}</option>
        </select>
      </label>
      {outcome === "rejected" ? (
        <label>
          {t("拒絕原因", "Rejection reason")}
          <textarea
            aria-label={t("拒絕原因", "Rejection reason")}
            aria-describedby={failed ? messageId : undefined}
            required
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
          />
        </label>
      ) : null}
      {predecessor ? (
        <label>
          {t("更正原因", "Correction reason")}
          <textarea
            aria-label={t("更正原因", "Correction reason")}
            aria-describedby={failed ? messageId : undefined}
            required
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value)}
          />
        </label>
      ) : null}
      <button
        className="secondary-button"
        type="submit"
        disabled={unavailable || busy || invalid}
      >
        {busy
          ? t("正在記錄…", "Recording…")
          : predecessor
            ? t("記錄更正", "Record correction")
            : t("記錄操作員結果", "Record operator result")}
      </button>
      {message ? (
        <p
          id={messageId}
          className={failed ? "inline-warning" : "helper-copy"}
          role={failed ? "alert" : "status"}
        >
          {failed
            ? safeUiError(message, locale, "action")
            : t(
                "操作員結果已記錄，仍未經獨立核實。",
                "Operator result recorded. Independent verification remains unverified.",
              )}
        </p>
      ) : null}
    </form>
  );
}
