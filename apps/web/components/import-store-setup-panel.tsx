"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useLocale } from "../lib/locale-context";
import { AdminConnectionPanel } from "./admin-connection-panel";

const summarySchema = z.object({
  connection: z.object({ shopDomain: z.string().min(1) }).nullable(),
  canManageConnection: z.boolean(),
  canImport: z.boolean(),
  credentialStorageConfigured: z.boolean(),
});
type Summary = z.infer<typeof summarySchema>;

export function ImportStoreSetupPanel({
  onImportReadyChange,
}: {
  onImportReadyChange: (ready: boolean) => void;
}) {
  const locale = useLocale();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<"auth" | "unavailable" | null>(null);
  const [open, setOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  const copy = (zh: string, en: string) =>
    locale === "en" ? en : `${zh} ${en}`;
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailure(null);
    setOpen(false);
    onImportReadyChange(false);
    try {
      const response = await fetch("/api/workspace/import-setup", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setSummary(null);
        setFailure(
          response.status === 401 || response.status === 403
            ? "auth"
            : "unavailable",
        );
        return;
      }
      const next = summarySchema.parse(await response.json());
      if (controller.signal.aborted) return;
      setSummary(next);
      onImportReadyChange(Boolean(next.connection && next.canImport));
    } catch {
      if (!controller.signal.aborted) {
        setSummary(null);
        setFailure("unavailable");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [onImportReadyChange]);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);

  return (
    <section
      className="import-store-setup"
      aria-label={copy("SHOPLINE 商店設定", "SHOPLINE store setup")}
      aria-busy={loading}
    >
      <h2>{copy("1. 設定 SHOPLINE 商店", "1. Set up your SHOPLINE store")}</h2>
      <p role="status" aria-live="polite">
        {loading ? (
          copy("正在檢查商店連線…", "Checking store connection…")
        ) : failure === "auth" ? (
          copy(
            "請登入具有存取權的工作區後重試。",
            "Sign in to an authorized workspace and retry.",
          )
        ) : failure ? (
          copy(
            "無法讀取商店狀態，請重試。",
            "Store status is unavailable. Please retry.",
          )
        ) : summary?.connection ? (
          <>
            {copy("已連線：", "Connected:")}{" "}
            <strong>{summary.connection.shopDomain}</strong>
          </>
        ) : (
          copy(
            "匯入前請先連線 SHOPLINE 商店。",
            "Connect a SHOPLINE store before importing.",
          )
        )}
      </p>
      {!loading && !failure && summary && (
        <>
          {!summary.canImport && (
            <p>
              {copy(
                "匯入需要操作員或以上權限。",
                "Operator access or higher is required to import.",
              )}
            </p>
          )}
          {!summary.connection &&
            (!summary.canManageConnection ? (
              <p>
                {copy(
                  "請聯絡工作區管理員連線商店。",
                  "Ask a workspace administrator to connect the store.",
                )}
              </p>
            ) : !summary.credentialStorageConfigured ? (
              <p>
                {copy(
                  "憑證儲存尚未就緒，請聯絡系統管理員完成設定後重新整理。",
                  "Credential storage is unavailable. Ask your system administrator to configure it, then refresh.",
                )}
              </p>
            ) : (
              <button
                className="secondary-button"
                type="button"
                onClick={() => setOpen(!open)}
              >
                {open
                  ? copy("關閉設定", "Close setup")
                  : copy("設定商店", "Set up store")}
              </button>
            ))}
          {open &&
            !summary.connection &&
            summary.canManageConnection &&
            summary.credentialStorageConfigured && (
              <AdminConnectionPanel onConnectionChanged={refresh} />
            )}
        </>
      )}
      <button
        className="secondary-button"
        type="button"
        disabled={loading}
        onClick={() => void refresh()}
      >
        {failure
          ? copy("重試", "Retry")
          : copy("重新整理狀態", "Refresh status")}
      </button>
    </section>
  );
}
