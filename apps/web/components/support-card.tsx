"use client";
import { useState } from "react";
import { validateSupportRequestId } from "../lib/account-session";
import type { Locale } from "../lib/locale";
import { localized } from "../lib/ui-copy";
export function SupportCard({
  contacts,
  requestId,
  locale,
}: {
  contacts: Array<{ userId: string; email: string; name: string | null }>;
  requestId?: string;
  locale: Locale;
}) {
  const id = validateSupportRequestId(requestId);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(id!);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <section className="card" aria-label={localized(locale, "支援", "Support")}>
      <h2>{localized(locale, "工作區支援", "Workspace support")}</h2>
      <p>
        {localized(
          locale,
          "遇到錯誤時，複製畫面顯示的支援編號並提供給工作區管理員。請勿附上密碼、憑證或完整商品內容。",
          "When a request fails, copy its support ID and share it with your workspace administrator. Keep passwords, credentials and full product content out of the report.",
        )}
      </p>
      {id ? (
        <div>
          <p>
            {localized(locale, "支援編號", "Support ID")}: <code>{id}</code>
          </p>
          <button
            className="button"
            type="button"
            data-testid="copy-support-id"
            onClick={() => void copy()}
          >
            {localized(locale, "複製支援編號", "Copy support ID")}
          </button>
        </div>
      ) : (
        <p>
          {localized(
            locale,
            "錯誤訊息會顯示支援編號；本頁未收到有效編號。",
            "An error message shows the support ID; no valid ID was supplied to this page.",
          )}
        </p>
      )}
      <p role="status">
        {state === "copied"
          ? localized(locale, "已複製", "Copied")
          : state === "failed"
            ? localized(
                locale,
                "未能複製，請選取上方編號手動複製。",
                "Could not copy. Select the ID above and copy it manually.",
              )
            : ""}
      </p>
      <h3>{localized(locale, "工作區管理員", "Workspace administrators")}</h3>
      {contacts.length ? (
        <ul>
          {contacts.map((contact) => (
            <li key={contact.userId}>
              <a href={"mailto:" + contact.email}>
                {contact.name ? contact.name + " · " : ""}
                {contact.email}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          {localized(
            locale,
            "尚未設定工作區管理員聯絡方式。",
            "No workspace administrator contact is configured.",
          )}
        </p>
      )}
    </section>
  );
}
