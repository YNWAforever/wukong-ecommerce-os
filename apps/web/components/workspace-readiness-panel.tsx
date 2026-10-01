"use client";
import { useCallback, useEffect, useState } from "react";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import type { WorkspaceReadinessItem } from "../lib/workspace-readiness-summary";
export function WorkspaceReadinessPanel() {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [items, setItems] = useState<WorkspaceReadinessItem[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    setError(false);
    try {
      const response = await fetch("/api/workspace/readiness", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("readiness_unavailable");
      const body = (await response.json()) as {
        items: WorkspaceReadinessItem[];
      };
      setItems(body.items);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section
      className="settings-panel"
      aria-label={t("實際運作狀態", "Runtime readiness")}
      aria-busy={busy}
    >
      <h2>{t("實際運作狀態", "Runtime readiness")}</h2>
      <p>
        {t(
          "根據安全的工作區觀察。未驗證與阻塞分開；本頁不發付費測試。下方另列功能成熟度。",
          "Safe workspace observations distinguish unknown from blocked. This page sends no paid probes. Capability maturity is listed separately below.",
        )}
      </p>
      <button type="button" disabled={busy} onClick={() => void load()}>
        {t("重新檢查記錄", "Refresh observations")}
      </button>
      {error && (
        <p role="alert">
          {t(
            "目前無法讀取運作記錄，請重試。",
            "Readiness observations are unavailable. Retry.",
          )}
        </p>
      )}
      {!items && !error && (
        <p role="status">{t("讀取中", "Loading observations")}</p>
      )}
      {items && (
        <dl>
          {items.map((item) => (
            <div key={item.key}>
              <dt>
                {
                  {
                    ai: "AI",
                    queue: t("工作處理", "Queue"),
                    storage: t("檔案儲存", "Storage"),
                    shopline: "SHOPLINE",
                    reviewer: t("覆核人員", "Reviewer"),
                  }[item.key]
                }{" "}
                ·{" "}
                {t(
                  { ready: "已觀察就緒", blocked: "阻塞", unknown: "未驗證" }[
                    item.state
                  ],
                  {
                    ready: "Ready (observed)",
                    blocked: "Blocked",
                    unknown: "Unknown",
                  }[item.state],
                )}
              </dt>
              <dd>
                {item.safeReason}
                <br />
                {item.nextAction}
                <br />
                {t("檢查時間", "Checked at")}:{" "}
                {item.checkedAt
                  ? new Date(item.checkedAt).toLocaleString(locale)
                  : t("尚未安全檢查", "No safe check available")}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
