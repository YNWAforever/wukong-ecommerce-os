"use client";

import { useState, type ReactNode } from "react";

import { setLocaleCookie, type Locale } from "../lib/locale";

type AuthShellProps = {
  initialLocale: Locale;
  children: ReactNode;
};

const PRINCIPLES: { zh: string; en: string }[] = [
  {
    zh: "邀請制帳戶及工作區成員資格",
    en: "Invite-only accounts and workspace membership",
  },
  {
    zh: "角色權限必須由後端強制執行",
    en: "Role permissions are enforced server-side",
  },
  {
    zh: "所有輸出保留人工審批關卡",
    en: "Every output keeps a human approval gate",
  },
  {
    zh: "正式環境直接寫入維持停用",
    en: "Direct production writes stay disabled",
  },
];

export function AuthShell({ initialLocale, children }: AuthShellProps) {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const isZh = locale === "zh-Hant";

  function changeLocale(next: Locale) {
    setLocale(next);
    setLocaleCookie(next);
  }

  return (
    <div className="auth-shell">
      <aside
        className="auth-shell-brand"
        aria-label="Wukong Catalog Operations OS"
      >
        <div className="auth-shell-brand-header">
          <div className="auth-shell-logo" aria-hidden="true">
            WK
          </div>
          <div>
            <p className="auth-shell-wordmark">Wukong</p>
            <p className="auth-shell-tagline-small">CATALOG OPERATIONS OS</p>
          </div>
          <div className="locale-toggle" role="group" aria-label="介面語言">
            <button
              type="button"
              data-testid="locale-toggle-zh"
              aria-pressed={isZh}
              onClick={() => changeLocale("zh-Hant")}
            >
              繁中
            </button>
            <button
              type="button"
              data-testid="locale-toggle-en"
              aria-pressed={!isZh}
              onClick={() => changeLocale("en")}
            >
              EN
            </button>
          </div>
        </div>
        <div className="auth-shell-brand-body">
          <p className="auth-shell-eyebrow">
            {isZh
              ? "Evidence-first 商品目錄營運"
              : "Evidence-first catalog operations"}
          </p>
          <h1>
            {isZh
              ? "先核實證據，再批准內容。"
              : "Verify the evidence before approving the content."}
          </h1>
          <p>
            {isZh
              ? "Wukong 將來源檔、AI 建議、人手審批及 SHOPLINE 匯入證明分開管理，避免把已產生檔案誤當成已完成更新。"
              : "Wukong keeps source files, AI suggestions, human approval, and SHOPLINE import proof separate, so a generated file is never mistaken for a completed update."}
          </p>
          <div className="auth-shell-stats">
            <div>
              <strong>71</strong>
              <span>
                {isZh ? "SHOPLINE 範本欄位" : "SHOPLINE template fields"}
              </span>
            </div>
            <div>
              <strong>8</strong>
              <span>{isZh ? "可修改內容欄位" : "editable content fields"}</span>
            </div>
            <div>
              <strong>0</strong>
              <span>
                {isZh ? "直接 SHOPLINE 寫入" : "direct SHOPLINE writes"}
              </span>
            </div>
          </div>
          <div className="auth-shell-principles">
            <p>{isZh ? "存取原則" : "Access principles"}</p>
            <ul>
              {PRINCIPLES.map((principle) => (
                <li key={principle.en}>{isZh ? principle.zh : principle.en}</li>
              ))}
            </ul>
          </div>
        </div>
      </aside>
      <main className="auth-shell-card-wrap">{children}</main>
    </div>
  );
}
