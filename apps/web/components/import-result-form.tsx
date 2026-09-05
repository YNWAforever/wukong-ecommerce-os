"use client";

import { useRef, useState } from "react";

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
  if (results.length === 0) return null;
  return (
    <details>
      <summary>{label}</summary>
      <ol>
        {results.map((result) => (
          <li key={result.id}>
            Revision {result.revision}: {result.outcome}
            {result.rejectReason
              ? ` — Rejection reason: ${result.rejectReason}`
              : ""}
            {result.correctionReason
              ? ` — Correction reason: ${result.correctionReason}`
              : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}
type ImportResultFormProps = {
  listingId: string;
  latestResult?: ImportResultReceipt | null;
  onRecorded?: () => void | Promise<void>;
} & (
  | { mode: "export"; versionId: string; exportAttemptId: string }
  | { mode: "historical_manual"; versionId?: never; exportAttemptId?: never }
);

export function ImportResultForm({
  listingId,
  versionId,
  exportAttemptId,
  latestResult = null,
  mode,
  onRecorded,
}: ImportResultFormProps) {
  const [outcome, setOutcome] = useState<"accepted" | "rejected">("accepted");
  const [rejectReason, setRejectReason] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);
  const payloadRef = useRef<string | null>(null);
  const inFlight = useRef(false);

  async function submit() {
    if (inFlight.current) return;
    const payload = {
      mode,
      outcome,
      ...(outcome === "rejected" ? { rejectReason: rejectReason.trim() } : {}),
      ...(mode === "export" ? { exportAttemptId, versionId } : {}),
      ...(latestResult
        ? {
            supersedesResultId: latestResult.id,
            correctionReason: correctionReason.trim(),
          }
        : {}),
    };
    const identity = JSON.stringify(payload);
    if (payloadRef.current !== identity) {
      payloadRef.current = identity;
      keyRef.current = crypto.randomUUID();
    }
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
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(
          body?.message ?? `Unable to record result (${response.status})`,
        );
      }
      setMessage(
        "Operator result recorded. Independent verification remains unverified.",
      );
      await onRecorded?.();
      keyRef.current = null;
      payloadRef.current = null;
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof Error ? error.message : "Unable to record result",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const invalid =
    (outcome === "rejected" && !rejectReason.trim()) ||
    (!!latestResult && !correctionReason.trim());
  return (
    <form
      className="result-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        Outcome
        <select
          value={outcome}
          onChange={(event) =>
            setOutcome(event.target.value as "accepted" | "rejected")
          }
        >
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
        </select>
      </label>
      {outcome === "rejected" ? (
        <label>
          Rejection reason
          <textarea
            aria-label="Rejection reason"
            required
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
          />
        </label>
      ) : null}
      {latestResult ? (
        <label>
          Correction reason
          <textarea
            aria-label="Correction reason"
            required
            value={correctionReason}
            onChange={(event) => setCorrectionReason(event.target.value)}
          />
        </label>
      ) : null}
      <button
        className="secondary-button"
        type="submit"
        disabled={busy || invalid}
      >
        {latestResult ? "Record correction" : "Record operator result"}
      </button>
      {message ? (
        <p
          className={failed ? "inline-warning" : "helper-copy"}
          role={failed ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}
