"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import type { Locale } from "../lib/locale";
import { renderStudioLine } from "../lib/studio-render";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import type { DraftDispatch } from "../lib/studio/types";
import styles from "./studio.module.css";

/**
 * The explicit-confirmation dispatch card (plan Task 10).
 *
 * A deterministic turn only *prepares* a listing draft from the operator's
 * source assets (`reply.dispatch`). This card is the single place that can turn
 * that preparation into canonical data, and it does so only after the operator
 * opens a confirmation panel and confirms — showing the asset count and note
 * first. There is no auto-dispatch path, and a viewer sees the action disabled
 * with the role reason.
 *
 * After a confirmed request the card reports exactly what the server returned:
 * the created listing, whether the existing pipeline was actually enqueued, and
 * the polled run state. A listing that exists without a running job is shown as
 * "processing has not started", never as "processing".
 */

const dispatchResultSchema = z.object({
  listingId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200).nullable(),
  queueState: z.enum(["enqueued", "queue_unavailable"]),
  replayed: z.boolean().optional().default(false),
});
type DispatchResult = z.infer<typeof dispatchResultSchema>;

const runStateSchema = z.object({
  state: z.string().min(1).max(40),
});

const RUN_STATE_KEYS: Readonly<Record<string, StudioCopyKey>> = {
  queued: "studio.dispatch.runState.queued",
  running: "studio.dispatch.runState.running",
  succeeded: "studio.dispatch.runState.succeeded",
  failed: "studio.dispatch.runState.failed",
  cancelled: "studio.dispatch.runState.cancelled",
  outcome_unknown: "studio.dispatch.runState.outcome_unknown",
  unavailable: "studio.dispatch.runState.unavailable",
};

const TERMINAL_RUN_STATES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "outcome_unknown",
  "unavailable",
]);

export type StudioDispatchCardProps = {
  readonly locale: Locale;
  readonly threadId: string;
  /** The assistant turn that prepared this dispatch (for the trace event). */
  readonly runId: string | null;
  readonly dispatch: DraftDispatch;
  /** Operator-or-higher, resolved server-side; never inferred in the client. */
  readonly canDispatch: boolean;
};

export function StudioDispatchCard({
  locale,
  threadId,
  runId,
  dispatch,
  canDispatch,
}: StudioDispatchCardProps) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [errorKey, setErrorKey] = useState<StudioCopyKey | null>(null);
  const [result, setResult] = useState<DispatchResult | null>(null);
  const [runState, setRunState] = useState<string | null>(null);
  const [readingStatus, setReadingStatus] = useState(false);
  const inFlight = useRef(false);
  const runStateRef = useRef<string | null>(null);

  useEffect(() => {
    runStateRef.current = runState;
  }, [runState]);

  const readRunStatus = useCallback(
    async (listingId: string, activeRunId: string) => {
      setReadingStatus(true);
      try {
        const response = await fetch(
          `/api/listings/${encodeURIComponent(listingId)}/runs/${encodeURIComponent(activeRunId)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (response.status !== 200) {
          setRunState("unavailable");
          return;
        }
        const parsed = runStateSchema.safeParse(await response.json());
        setRunState(parsed.success ? parsed.data.state : "unavailable");
      } catch {
        setRunState("unavailable");
      } finally {
        setReadingStatus(false);
      }
    },
    [],
  );

  // Poll only while a run is known to exist, and stop on unmount or as soon as
  // the run reaches a terminal state. No polling before a dispatch.
  useEffect(() => {
    if (!result?.runId) return;
    const listingId = result.listingId;
    const activeRunId = result.runId;
    void readRunStatus(listingId, activeRunId);
    const interval = setInterval(() => {
      const current = runStateRef.current;
      if (current !== null && TERMINAL_RUN_STATES.has(current)) {
        clearInterval(interval);
        return;
      }
      void readRunStatus(listingId, activeRunId);
    }, 4000);
    return () => clearInterval(interval);
  }, [readRunStatus, result?.listingId, result?.runId]);

  const confirm = useCallback(async () => {
    if (inFlight.current || !canDispatch || !dispatch.ready) return;
    inFlight.current = true;
    setSending(true);
    setErrorKey(null);
    try {
      const response = await fetch("/api/studio/dispatch/listing-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          ...(runId ? { runId } : {}),
          assetIds: dispatch.assetIds,
          ...(dispatch.note ? { note: dispatch.note } : {}),
          skillKey: "listing.draft_from_sources",
          confirmed: true,
        }),
        cache: "no-store",
        credentials: "same-origin",
      });
      if (response.status === 403) {
        setErrorKey("studio.dispatch.forbidden");
        return;
      }
      if (response.status === 404) {
        setErrorKey("studio.error.notFound");
        return;
      }
      if (!response.ok) {
        setErrorKey("studio.dispatch.failed");
        return;
      }
      const parsed = dispatchResultSchema.safeParse(await response.json());
      if (!parsed.success) {
        setErrorKey("studio.dispatch.failed");
        return;
      }
      setResult(parsed.data);
      setConfirming(false);
    } catch {
      setErrorKey("studio.dispatch.failed");
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }, [
    canDispatch,
    dispatch.assetIds,
    dispatch.note,
    dispatch.ready,
    readRunStatus,
    runId,
    threadId,
  ]);

  const disabledReason = !canDispatch
    ? "studio.dispatch.viewerNote"
    : !dispatch.ready
      ? "studio.dispatch.notReady"
      : null;

  return (
    <section
      className={styles["studio-dispatch"]}
      aria-label={studioCopy(locale, "studio.dispatch.title")}
    >
      <header className={styles["studio-dispatch-header"]}>
        <h4 className={styles["studio-dispatch-title"]}>
          {studioCopy(locale, "studio.dispatch.title")}
        </h4>
        <span className={styles["studio-dispatch-badge"]}>
          {studioCopy(locale, "studio.dispatch.review")}
        </span>
      </header>
      <p className={styles["studio-dispatch-note"]}>
        {studioCopy(locale, "studio.dispatch.intro")}
      </p>
      <p className={styles["studio-dispatch-meta"]}>
        {renderStudioLine(locale, {
          key: "studio.dispatch.assetCount",
          values: { count: dispatch.assetIds.length },
        })}
        {" · "}
        {dispatch.note
          ? renderStudioLine(locale, {
              key: "studio.dispatch.note",
              values: { note: dispatch.note },
            })
          : studioCopy(locale, "studio.dispatch.noNote")}
      </p>

      {result !== null ? (
        <div className={styles["studio-dispatch-result"]}>
          <p className={styles["studio-output-notice"]} role="status">
            {studioCopy(locale, "studio.dispatch.created")}
          </p>
          {result.replayed ? (
            <p className={styles["studio-dispatch-note"]}>
              {studioCopy(locale, "studio.dispatch.replayed")}
            </p>
          ) : null}
          <p className={styles["studio-dispatch-note"]}>
            {studioCopy(
              locale,
              result.queueState === "enqueued"
                ? "studio.dispatch.queueEnqueued"
                : "studio.dispatch.queueUnavailable",
            )}
          </p>
          <Link
            className={styles["studio-evidence-link"]}
            href={`/listings/${encodeURIComponent(result.listingId)}`}
          >
            {studioCopy(locale, "studio.dispatch.openListing")}
          </Link>
          <div className={styles["studio-dispatch-run"]}>
            <span className={styles["studio-dispatch-run-label"]}>
              {studioCopy(locale, "studio.dispatch.processing")}
            </span>
            {readingStatus && runState === null ? (
              <span role="status">
                {studioCopy(locale, "studio.dispatch.readingStatus")}
              </span>
            ) : runState !== null ? (
              <span
                className={styles["studio-output-status"]}
                data-status="draft"
                role="status"
              >
                {RUN_STATE_KEYS[runState]
                  ? studioCopy(locale, RUN_STATE_KEYS[runState]!)
                  : studioCopy(locale, "studio.dispatch.runState.unavailable")}
              </span>
            ) : (
              <span>{studioCopy(locale, "studio.dispatch.noRun")}</span>
            )}
            {result.runId ? (
              <button
                type="button"
                className={styles["studio-dispatch-secondary"]}
                onClick={() =>
                  void readRunStatus(result.listingId, result.runId as string)
                }
                disabled={readingStatus}
              >
                {studioCopy(locale, "studio.dispatch.checkStatus")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {errorKey !== null ? (
        <div className={styles["studio-composer-error"]} role="alert">
          <p>{studioCopy(locale, errorKey)}</p>
          <button
            type="button"
            className={styles["studio-composer-retry"]}
            onClick={() => void confirm()}
            disabled={sending || disabledReason !== null}
          >
            {studioCopy(locale, "studio.error.retry")}
          </button>
        </div>
      ) : null}

      {disabledReason !== null ? (
        <p className={styles["studio-dispatch-note"]} role="note">
          {studioCopy(locale, disabledReason)}
        </p>
      ) : null}

      {confirming ? (
        <div
          className={styles["studio-dispatch-confirm"]}
          role="group"
          aria-label={studioCopy(locale, "studio.dispatch.confirm")}
        >
          <p className={styles["studio-dispatch-warning"]}>
            {studioCopy(locale, "studio.dispatch.warning")}
          </p>
          <p className={styles["studio-dispatch-meta"]}>
            {renderStudioLine(locale, {
              key: "studio.dispatch.assetCount",
              values: { count: dispatch.assetIds.length },
            })}
            {" · "}
            {dispatch.note
              ? renderStudioLine(locale, {
                  key: "studio.dispatch.note",
                  values: { note: dispatch.note },
                })
              : studioCopy(locale, "studio.dispatch.noNote")}
          </p>
          <div className={styles["studio-output-actions"]}>
            <button
              type="button"
              className={styles["studio-output-action"]}
              onClick={() => void confirm()}
              disabled={sending || disabledReason !== null}
            >
              {sending
                ? studioCopy(locale, "studio.dispatch.sending")
                : studioCopy(locale, "studio.dispatch.confirm")}
            </button>
            <button
              type="button"
              className={styles["studio-dispatch-secondary"]}
              onClick={() => setConfirming(false)}
              disabled={sending}
            >
              {studioCopy(locale, "studio.dispatch.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className={styles["studio-output-actions"]}>
          <button
            type="button"
            className={styles["studio-output-action"]}
            onClick={() => setConfirming(true)}
            disabled={disabledReason !== null || sending || result !== null}
            title={
              disabledReason ? studioCopy(locale, disabledReason) : undefined
            }
          >
            {studioCopy(locale, "studio.dispatch.review")}
          </button>
        </div>
      )}
    </section>
  );
}
