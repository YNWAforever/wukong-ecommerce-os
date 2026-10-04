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
  recovery?:
    | "retryable"
    | "needs-input"
    | "needs-review"
    | "outcome-unknown"
    | "support-required";
  canRetry?: boolean;
  sku?: string | null;
  sourceRef?: string | null;
  lastStage?: string;
  updatedAt?: string;
  thumbnailUrl?: string | null;
  thumbnailState?: "ready" | "unavailable";
};
const recoveryCopy: Record<NonNullable<Item["recovery"]>, [string, string]> = {
  retryable: [
    "可重試：只重試這次已知失敗。",
    "Retryable: retry this known failed attempt.",
  ],
  "needs-input": [
    "需要資料：手動補資料或採用候選後重新預覽。",
    "Needs input: correct saved input or adopt the candidate, then preview again.",
  ],
  "needs-review": [
    "需要人工確認：檢查目前版本，不能盲目重跑。",
    "Needs review: inspect the current version before starting new work.",
  ],
  "outcome-unknown": [
    "結果／費用未確認：先獨立核對；費用保留。",
    "Outcome/cost unknown: reconcile first; its cost hold remains.",
  ],
  "support-required": [
    "需要支援：提供執行編號及失敗階段。",
    "Support required: provide the run ID and stage.",
  ],
};
export function BatchControls({
  batchId,
  revision,
  status,
  items,
  onChanged,
  archived = false,
}: {
  batchId: string;
  revision: number;
  status: string;
  items: Item[];
  onChanged(): void;
  archived?: boolean;
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
      <button
        disabled={busy}
        onClick={() => void control(archived ? "restore" : "archive")}
      >
        {archived
          ? localized(locale, "還原至工作清單", "Restore to work list")
          : localized(locale, "歸檔工作清單紀錄", "Archive from work list")}
      </button>
      <p>
        {localized(
          locale,
          "歸檔只影響清單顯示；執行、來源、audit 及未核對費用仍保留。",
          "Archive changes list visibility only. Runs, sources, audit and uncertain charges remain available.",
        )}
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.thumbnailUrl ? (
              <img
                src={item.thumbnailUrl}
                alt={localized(locale, "商品來源圖片", "Product source image")}
                width={48}
                height={48}
                loading="lazy"
                onError={(event) => {
                  event.currentTarget.hidden = true;
                }}
              />
            ) : item.thumbnailState === "unavailable" ? (
              <small>
                {localized(
                  locale,
                  "圖片預覽未能提供",
                  "Image preview unavailable",
                )}
              </small>
            ) : null}
            {item.isCurrent && item.canRetry === true && item.pipelineRunId && (
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
              {item.sku ?? item.listingId.slice(0, 8)} ·{" "}
              {item.listingId.slice(0, 8)}
            </a>{" "}
            — {item.outcome ?? item.status}{" "}
            {item.isCurrent ? "" : "(prior attempt)"}
            {item.pipelineRunId && <small> · {item.pipelineRunId}</small>}
            {item.sourceRef ? (
              <small>
                {" "}
                · {localized(locale, "來源", "Source")} {item.sourceRef}
              </small>
            ) : null}
            {item.lastStage ? (
              <small>
                {" "}
                · {localized(locale, "階段", "Stage")} {item.lastStage}
              </small>
            ) : null}
            {item.updatedAt ? <small> · {item.updatedAt}</small> : null}
            {item.recovery ? (
              <p>{localized(locale, ...recoveryCopy[item.recovery])}</p>
            ) : null}
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
