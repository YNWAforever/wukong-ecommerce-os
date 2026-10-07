"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { signOutAccount } from "../lib/account-session";
import { clearWorkSession } from "../lib/catalog-session-state";
import type { Locale } from "../lib/locale";
import { localized } from "../lib/ui-copy";
import styles from "./account-menu.module.css";

export function AccountMenu({
  user,
  workspaceName,
  roleLabel,
  locale,
}: {
  user: { userId: string; email: string; name: string | null };
  workspaceName: string;
  roleLabel: string;
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
