"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Locale } from "../lib/locale";
import { studioCopy, type StudioCopyKey } from "../lib/studio-copy";
import styles from "./studio.module.css";

const money = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/);
const tokenCount = z.number().int().nonnegative().nullable();
const detailsSchema = z.object({
  runId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "outcome_unknown",
  ]),
  provider: z.string().max(200).nullable(),
  model: z.string().max(200).nullable(),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  settledUsd: money.nullable(),
  reservation: z
    .object({
      state: z.enum(["reserved", "settled", "released", "uncertain"]),
      pricingVersion: z.string().max(128),
      reservedUsd: money,
      settledUsd: money.nullable(),
    })
    .nullable()
    .optional(),
});
type Details = z.infer<typeof detailsSchema>;
type LoadState = {
  key: string;
  data: Details | null;
  loading: boolean;
  error: boolean;
};

/** Reads only on explicit expansion/refresh. Costs come from persisted data, never estimates. */
export function StudioRunDetails({
  locale,
  threadId,
  runId,
}: {
  readonly locale: Locale;
  readonly threadId: string;
  readonly runId: string;
}) {
  const key = JSON.stringify([threadId, runId]);
  const [state, setState] = useState<LoadState>({
    key,
    data: null,
    loading: false,
    error: false,
  });
  const pending = useRef<AbortController | null>(null);
  const current =
    state.key === key
      ? state
      : { key, data: null, loading: false, error: false };
  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setState({ key, data: null, loading: false, error: false });
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [key]);

  async function load() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : null,
      loading: true,
      error: false,
    }));
    try {
      const response = await fetch(
        `/api/studio/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error("run_details_unavailable");
      const data = detailsSchema.parse(await response.json());
      if (data.runId !== runId || data.threadId !== threadId)
        throw new Error("run_details_context_mismatch");
      if (!controller.signal.aborted && pending.current === controller)
        setState({ key, data, loading: false, error: false });
    } catch {
      if (!controller.signal.aborted && pending.current === controller) {
        setState((previous) => ({
          key,
          data: previous.key === key ? previous.data : null,
          loading: false,
          error: true,
        }));
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }

  const t = (copyKey: StudioCopyKey) => studioCopy(locale, copyKey);
  const data = current.data;
  const unknown = t("studio.run.unknown");
  const rows: Array<[StudioCopyKey, string | number]> = data
    ? [
        ["studio.run.reference", data.runId],
        ["studio.run.status", t(`studio.run.status.${data.status}`)],
        ["studio.run.provider", data.provider ?? unknown],
        ["studio.run.model", data.model ?? unknown],
        ["studio.run.inputTokens", data.inputTokens ?? unknown],
        ["studio.run.outputTokens", data.outputTokens ?? unknown],
        ["studio.run.actualCost", data.settledUsd ?? unknown],
        ["studio.run.reserved", data.reservation?.reservedUsd ?? unknown],
        [
          "studio.run.reservation",
          data.reservation
            ? t(`studio.run.state.${data.reservation.state}`)
            : data.reservation === null
              ? t("studio.run.noReservation")
              : unknown,
        ],
        ["studio.run.pricing", data.reservation?.pricingVersion ?? unknown],
      ]
    : [];

  return (
    <details
      className={styles["studio-run-details"]}
      onToggle={(event) => {
        if (
          event.currentTarget.open &&
          !data &&
          !current.loading &&
          !current.error
        )
          void load();
      }}
    >
      <summary>{t("studio.run.details")}</summary>
      {current.loading ? <p role="status">{t("studio.run.loading")}</p> : null}
      {current.error ? <p role="alert">{t("studio.run.error")}</p> : null}
      {data ? (
        <dl className={styles["studio-run-data"]}>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{t(label)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <button
        type="button"
        disabled={current.loading}
        className={styles["studio-trace-load"]}
        onClick={() => void load()}
      >
        {t(data ? "studio.run.refresh" : "studio.run.load")}
      </button>
    </details>
  );
}
