"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { signOutAccount } from "../lib/account-session";
import { clearWorkSession } from "../lib/catalog-session-state";
import type { Locale } from "../lib/locale";
import type { WorkspaceRole } from "../lib/session-context";
import { localized } from "../lib/ui-copy";
import styles from "./account-menu.module.css";

/**
 * One line of what the signed-in role can do (P1 role clarity).
 *
 * The server remains the authority; this only tells a person who to ask for the
 * action they cannot take, instead of offering a control that silently refuses
 * or hides a destination without explanation.
 */
const ROLE_CAPABILITY: Record<
  WorkspaceRole,
  { readonly zh: string; readonly en: string }
> = {
  viewer: {
    zh: "你只能閱讀；建立對話或審核請聯絡管理員或操作員。",
    en: "Read-only: ask an admin or operator to start a conversation or review.",
  },
  operator: {
    zh: "你可以執行引導審核並準備內容；簽核與設定需要審核員或管理員。",
    en: "You can run guided reviews and prepare work; sign-off and settings need a reviewer or admin.",
  },
  reviewer: {
    zh: "你可以審核並簽核已準備的內容；設定與連線需要管理員。",
    en: "You can review and sign off prepared work; settings and connections need an admin.",
  },
  admin: {
    zh: "你可以審核、簽核並管理工作區設定與連線。",
    en: "You can review, sign off and manage workspace settings and connections.",
  },
  owner: {
    zh: "完整工作區控制，包括設定、連線與角色。",
    en: "Full workspace control, including settings, connections and roles.",
  },
};

export function AccountMenu({
  user,
  workspaceName,
  roleLabel,
  role,
  locale,
}: {
  user: { userId: string; email: string; name: string | null };
  workspaceName: string;
  roleLabel: string;
  role?: WorkspaceRole;
  locale: Locale;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const recheck = async (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      try {
        const response = await fetch("/api/account", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (response.status === 401) {
          clearWorkSession();
          window.location.replace("/signin");
        } else if (response.ok) window.location.reload();
      } catch {
        /* API authority still refuses expired or removed sessions. */
      }
    };
    window.addEventListener("pageshow", recheck);
    return () => window.removeEventListener("pageshow", recheck);
  }, []);
  async function signOut() {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      await signOutAccount({
        fetch: window.fetch.bind(window),
        clearSession: clearWorkSession,
        clearCaches: async () => {
          if ("caches" in window)
            await Promise.all(
              (await caches.keys()).map((key) => caches.delete(key)),
            );
        },
        navigate: (url) => window.location.replace(url),
      });
    } catch {
      setError(true);
      setPending(false);
    }
  }
  return (
    <details className={styles.account} data-testid="account-menu">
      <summary
        aria-label={`${localized(locale, "帳戶", "Account")} · ${user.name || user.email}`}
      >
        <span className={styles.avatar} aria-hidden="true">
          {(user.name || user.email).trim().charAt(0).toUpperCase()}
        </span>
        <span className={styles.identity} aria-hidden="true">
          {user.name || user.email}
        </span>
        <svg
          className={styles.chevron}
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="14"
          height="14"
        >
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className={styles.panel}>
        <strong>{user.name || user.email}</strong>
        <span>{user.email}</span>
        <span>
          {workspaceName} · {roleLabel}
        </span>
        {role ? (
          <p className={styles["capability"]} data-role={role}>
            {localized(
              locale,
              ROLE_CAPABILITY[role].zh,
              ROLE_CAPABILITY[role].en,
            )}
          </p>
        ) : null}
        <Link href="/support">
          {localized(locale, "支援及支援編號", "Support and request ID")}
        </Link>
        <button
          type="button"
          data-testid="sign-out"
          disabled={pending}
          onClick={() => void signOut()}
        >
          {pending
            ? localized(locale, "正在登出…", "Signing out…")
            : localized(locale, "登出", "Sign out")}
        </button>
        {error ? (
          <p role="alert">
            {localized(
              locale,
              "未能登出，請重試。",
              "Could not sign out. Please retry.",
            )}
          </p>
        ) : null}
      </div>
    </details>
  );
}
