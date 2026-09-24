"use client";
import { useRef, useState } from "react";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
type Item = {
  id: string;
  listingId: string;
  pipelineRunId: string | null;
  outcome: string | null;
  status: string;
  isCurrent: boolean;
  retryOfItemId: string | null;
};
export function BatchControls({
  batchId,
  revision,
  status,
  items,
  onChanged,
}: {
  batchId: string;
  revision: number;
  status: string;
  items: Item[];
  onChanged(): void;
}) {
  const locale = useLocale();
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<{
    action: string;
    signature: string;
    body: Record<string, unknown>;
  } | null>(null);
  async function control(action: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    const signature = JSON.stringify([batchId, action, selected]);
    if (pending.current?.signature !== signature)
      pending.current = {
        action,
        signature,
        body: {
          action,
          expectedControlRevision: revision,
          idempotencyKey: crypto.randomUUID(),
          ...(action === "retry_selected" ? { itemIds: selected } : {}),
        },
      };
    try {
      const response = await fetch(
        `/api/enrichment-batches/${batchId}/control`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(pending.current.body),
        },
      );
      const body = await response.json();
      if (!response.ok) {
        pending.current = null;
        throw Error(body.message ?? "The batch changed. Refresh and retry.");
      }
      pending.current = null;
      setSelected([]);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Please retry.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label={localized(locale, "批次控制", "Batch controls")}>
      <p>
        {localized(
          locale,
          "暫停會停止新批次分配；已接受的工作可能完成。取消會保留結果及尚未確認的費用。",
          "Pause stops new admission; accepted work may finish. Cancellation retains candidates and uncertain charges.",
        )}
      </p>
      {status === "paused" ? (
        <button disabled={busy} onClick={() => void control("resume")}>
          {localized(locale, "繼續", "Resume")}
        </button>
      ) : (
        !["cancelled", "completed"].includes(status) && (
          <button disabled={busy} onClick={() => void control("pause")}>
            {localized(locale, "暫停", "Pause")}
          </button>
        )
      )}
      {!["cancelled", "completed"].includes(status) && (
        <button disabled={busy} onClick={() => void control("cancel")}>
          {localized(locale, "取消未完成工作", "Cancel unfinished work")}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.isCurrent &&
              ["failed", "needs_input", "superseded", "cancelled"].includes(
                item.outcome ?? "",
              ) &&
              item.pipelineRunId && (
                <input
                  type="checkbox"
                  aria-label={`Retry ${item.listingId}`}
                  checked={selected.includes(item.id)}
                  disabled={busy}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, item.id]
                        : ids.filter((id) => id !== item.id),
                    )
                  }
                />
              )}
            <a href={`/listings/${item.listingId}`}>
              {item.listingId.slice(0, 8)}
            </a>{" "}
            — {item.outcome ?? item.status}{" "}
            {item.isCurrent ? "" : "(prior attempt)"}
            {item.pipelineRunId && <small> · {item.pipelineRunId}</small>}
          </li>
        ))}
      </ul>
      <button
        disabled={
          busy ||
          status === "paused" ||
          selected.length === 0 ||
          selected.length > 5
        }
        onClick={() => void control("retry_selected")}
      >
        {localized(
          locale,
          "重試所選項目（最多 5 個）",
          "Retry selected (up to 5)",
        )}
      </button>
      <p>
        {localized(
          locale,
          "派送重試用盡時，先補充資料並選取失敗項目重試；仍未解決請向支援提供執行編號。",
          "For exhausted dispatch, correct the input and retry selected failed items. Give support the run ID if it remains blocked.",
        )}
      </p>
    </section>
  );
}
