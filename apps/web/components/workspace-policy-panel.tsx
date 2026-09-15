"use client";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { useEffect, useState } from "react";
import { WORKSPACE_REQUIRED_FIELDS, type WorkspacePolicy } from "@wukong/core";
type View = {
  policy: WorkspacePolicy;
  digest: string;
  usage: {
    heldUsd: string;
    unknownHeldUsd: string;
    settledUsd: string;
    unknownRuns: number;
    physicalCalls: number;
  } | null;
  admission: {
    enabled: boolean;
    provider: string | null;
    model: string | null;
    capUsd: string | null;
  };
};
async function read(response: Response) {
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.message ?? "設定暫時無法儲存 Settings unavailable");
  return body;
}
export function WorkspacePolicyPanel() {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const labels: Record<string, [string, string]> = {
    sku: ["商戶貨號", "Merchant SKU"],
    producer: ["生產商", "Producer"],
    productType: ["產品類型", "Product type"],
    country: ["國家", "Country"],
    region: ["產區", "Region"],
    vintage: ["年份", "Vintage"],
    volumeMl: ["容量 (ml)", "Volume (ml)"],
    abvPercent: ["酒精濃度 (%)", "ABV (%)"],
    packQuantity: ["包裝數量", "Pack quantity"],
    priceHkd: ["售價 (HK$)", "Price (HK$)"],
    stockQuantity: ["庫存", "Stock"],
  };
  const [view, setView] = useState<View | null>(null);
  const [policy, setPolicy] = useState<WorkspacePolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = async () => {
    try {
      const next = await read(await fetch("/api/workspace/policies"));
      setView(next);
      setPolicy(next.policy);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <section
      className="settings-panel workspace-policy-panel"
      aria-label={t("工作區政策", "Workspace policies")}
      aria-busy={busy}
    >
      <h2>{t("工作區政策與用量", "Workspace policies and usage")}</h2>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" disabled={busy} onClick={load}>
            {t("重新載入", "Reload")}
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {policy && view && (
        <>
          <label>
            {t("工作區名稱", "Workspace name")}
            <input
              value={policy.name}
              disabled={busy}
              onChange={(e) => setPolicy({ ...policy, name: e.target.value })}
            />
          </label>
          <label>
            {t("品牌語氣", "Brand voice")}
            <textarea
              value={policy.tone}
              disabled={busy}
              onChange={(e) => setPolicy({ ...policy, tone: e.target.value })}
            />
          </label>
          <label>
            {t("內容指引（每行一項）", "Content guidance (one per line)")}
            <textarea
              value={policy.claimPolicy.join("\n")}
              disabled={busy}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  claimPolicy: e.target.value.split("\n"),
                })
              }
            />
          </label>
          <p>
            {t(
              "內容指引供生成與人工覆核使用；不代表每條自由文字規則都可自動驗證。",
              "Guidance informs generation and human review. Free-text rules are not all automatically verifiable.",
            )}
          </p>
          <fieldset disabled={busy}>
            <legend>{t("批准前必填", "Required before approval")}</legend>
            {WORKSPACE_REQUIRED_FIELDS.map((field) => (
              <label key={field}>
                <input
                  type="checkbox"
                  checked={policy.requiredFields.includes(field)}
                  onChange={(e) =>
                    setPolicy({
                      ...policy,
                      requiredFields: e.target.checked
                        ? [...policy.requiredFields, field]
                        : policy.requiredFields.filter(
                            (value) => value !== field,
                          ),
                    })
                  }
                />
                {t(...labels[field]!)}
              </label>
            ))}
          </fieldset>
          <label>
            {t(
              "允許的來源網域（每行一個；留空允許公開網站）",
              "Allowed source domains (one per line; blank permits public websites)",
            )}
            <textarea
              value={policy.sourcePreferences.allowedDomains.join("\n")}
              disabled={busy}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  sourcePreferences: {
                    allowedDomains: e.target.value.split("\n"),
                  },
                })
              }
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const next = {
                ...policy,
                claimPolicy: policy.claimPolicy
                  .map((value) => value.trim())
                  .filter(Boolean),
                sourcePreferences: {
                  allowedDomains: policy.sourcePreferences.allowedDomains
                    .map((value) => value.trim())
                    .filter(Boolean),
                },
              };
              setPolicy(next);
              void saveNormalized(next);
            }}
          >
            {t("儲存政策", "Save policies")}
          </button>
          <h3>{t("AI 用量（USD）", "AI usage (USD)")}</h3>
          <p>
            {view.admission.enabled
              ? t("已設定付費 AI", "Paid AI configured")
              : t(
                  "付費 AI 未啟用；可繼續手動編輯。請管理員完成模型、額度與部署設定。",
                  "Paid AI is disabled. Manual editing is available. Ask an administrator to complete model, budget and deployment setup.",
                )}{" "}
            {view.admission.model ?? ""}
          </p>
          {view.usage ? (
            <dl>
              <dt>
                {t("已結算（可包含估算）", "Settled (may include estimates)")}
              </dt>
              <dd>{view.usage.settledUsd}</dd>
              <dt>{t("執行中預留", "Held")}</dt>
              <dd>{view.usage.heldUsd}</dd>
              <dt>{t("結果未明預留", "Unknown outcome holds")}</dt>
              <dd>
                {view.usage.unknownHeldUsd} / {view.usage.unknownRuns} runs
              </dd>
              <dt>{t("模型呼叫", "Physical calls")}</dt>
              <dd>{view.usage.physicalCalls}</dd>
              <dt>{t("累計准入上限", "Cumulative admission cap")}</dt>
              <dd>{view.admission.capUsd ?? t("未設定", "Not configured")}</dd>
            </dl>
          ) : (
            <p>
              {t(
                "用量資料結構尚未就緒；請管理員檢查部署。",
                "Usage storage is not ready. Ask an administrator to check the deployment.",
              )}
            </p>
          )}
          <p>
            {t(
              "未知費用不當作零。此為應用程式准入記錄，不是供應商帳單。",
              "Unknown cost is never counted as zero. These are application admission records, not provider invoices.",
            )}
          </p>
        </>
      )}
    </section>
  );
  async function saveNormalized(next: WorkspacePolicy) {
    if (!view) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await read(
        await fetch("/api/workspace/policies", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedDigest: view.digest, policy: next }),
        }),
      );
      setView({ ...view, ...result });
      setPolicy(result.policy);
      setMessage(t("工作區政策已儲存", "Policies saved"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
}
