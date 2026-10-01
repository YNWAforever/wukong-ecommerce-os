"use client";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AdminDirtyProvider,
  useAdminDirtyNavigation,
} from "../lib/admin-dirty-context";
import { AdminConnectionPanel } from "./admin-connection-panel";
import { AdminMembersPanel } from "./admin-members-panel";
import { AdminSettingsPanel } from "./admin-settings-panel";
import { CapabilityRegistryPanel } from "./capability-registry-panel";
import { WorkspaceReadinessPanel } from "./workspace-readiness-panel";
import { installAdminHistoryGuard } from "../lib/admin-history-guard";
import styles from "./admin-tabs.module.css";
type AdminTab = "members" | "connection" | "settings" | "capabilities";
const TABS: AdminTab[] = ["members", "connection", "settings", "capabilities"];
type Destination =
  { tab: AdminTab } | { href: string } | { historyDelta: number };
export function AdminTabs() {
  return (
    <AdminDirtyProvider>
      <GuardedAdminTabs />
    </AdminDirtyProvider>
  );
}
function GuardedAdminTabs() {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [active, setActive] = useState<AdminTab>("members");
  const [focused, setFocused] = useState<AdminTab>("members");
  const [pending, setPending] = useState<Destination | null>(null);
  const [saving, setSaving] = useState(false);
  const { hasDirty, saveAll, discardAll } = useAdminDirtyNavigation();
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const navigating = useRef(false);
  const historyGuard = useRef<ReturnType<
    typeof installAdminHistoryGuard
  > | null>(null);
  const dirtyRef = useRef(hasDirty);
  dirtyRef.current = hasDirty;
  const commit = (destination: Destination) => {
    setPending(null);
    if ("tab" in destination) {
      setActive(destination.tab);
      setFocused(destination.tab);
      document.getElementById(`admin-tab-${destination.tab}`)?.focus();
    } else {
      navigating.current = true;
      if ("historyDelta" in destination)
        historyGuard.current?.leave(destination.historyDelta);
      else window.location.assign(destination.href);
    }
  };
  const request = (destination: Destination) => {
    if (pending || saving) return;
    if (!hasDirty) {
      commit(destination);
      return;
    }
    previousFocus.current = document.activeElement as HTMLElement | null;
    setPending(destination);
  };
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    const guard = installAdminHistoryGuard(
      {
        history: window.history,
        location: window.location,
        getIndex() {
          return (
            window as Window & {
              navigation?: { currentEntry?: { index?: number } };
            }
          ).navigation?.currentEntry?.index;
        },
        dispatchPopState(state) {
          window.dispatchEvent(new PopStateEvent("popstate", { state }));
        },
        addEventListener(name, listener) {
          window.addEventListener(name, listener, true);
        },
        removeEventListener(name, listener) {
          window.removeEventListener(name, listener, true);
        },
      },
      () => dirtyRef.current,
      (delta) => requestRef.current({ historyDelta: delta }),
    );
    historyGuard.current = guard;
    return () => {
      guard.dispose();
      if (historyGuard.current === guard) historyGuard.current = null;
    };
  }, []);
  const stay = () => {
    if (saving) return;
    setPending(null);
    previousFocus.current?.focus();
  };
  useEffect(() => {
    if (!hasDirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (navigating.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [hasDirty]);
  useEffect(() => {
    if (!hasDirty) return;
    const click = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (
        !link ||
        link.hasAttribute("download") ||
        (link.target && link.target !== "_self")
      )
        return;
      const url = new URL(link.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        (url.pathname === window.location.pathname &&
          url.search === window.location.search)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      request({ href: url.href });
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  });
  useEffect(() => {
    if (pending)
      dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [pending]);
  function keys(event: KeyboardEvent<HTMLButtonElement>, tab: AdminTab) {
    let index = TABS.indexOf(tab);
    if (event.key === "ArrowRight") index = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft")
      index = (index + TABS.length - 1) % TABS.length;
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = TABS.length - 1;
    else return;
    event.preventDefault();
    const next = TABS[index]!;
    setFocused(next);
    document.getElementById(`admin-tab-${next}`)?.focus();
  }
  return (
    <div className="admin-tabs">
      <div
        className="admin-tab-list"
        role="tablist"
        aria-label={t("管理區段", "Admin sections")}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            id={`admin-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={active === tab}
            aria-controls="admin-tab-panel"
            tabIndex={focused === tab ? 0 : -1}
            className={active === tab ? "admin-tab active" : "admin-tab"}
            onFocus={() => setFocused(tab)}
            onKeyDown={(event) => keys(event, tab)}
            onClick={() => tab !== active && request({ tab })}
          >
            {t(
              {
                members: "成員",
                connection: "SHOPLINE 連線",
                settings: "設定",
                capabilities: "系統真相",
              }[tab],
              {
                members: "Members",
                connection: "SHOPLINE connection",
                settings: "Settings",
                capabilities: "System Truth",
              }[tab],
            )}
          </button>
        ))}
      </div>
      <div
        id="admin-tab-panel"
        className="admin-tab-panel"
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={`admin-tab-${active}`}
      >
        {active === "members" && <AdminMembersPanel />}
        {active === "connection" && <AdminConnectionPanel />}
        {active === "settings" && <AdminSettingsPanel />}
        {active === "capabilities" && (
          <>
            <WorkspaceReadinessPanel />
            <CapabilityRegistryPanel />
          </>
        )}
      </div>
      {pending && (
        <div className={styles.backdrop}>
          <div
            ref={dialog}
            className={styles.dialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="admin-unsaved-title"
            aria-describedby="admin-unsaved-description"
            aria-busy={saving}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                stay();
              }
              if (event.key === "Tab") {
                const buttons = Array.from(
                  dialog.current?.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ) ?? [],
                );
                if (!buttons.length) {
                  event.preventDefault();
                  return;
                }
                const edge = event.shiftKey
                  ? buttons[0]
                  : buttons[buttons.length - 1];
                if (document.activeElement === edge) {
                  event.preventDefault();
                  (event.shiftKey
                    ? buttons[buttons.length - 1]
                    : buttons[0]
                  )?.focus();
                }
              }
            }}
          >
            <h2 id="admin-unsaved-title">
              {t("有未儲存的修改", "Unsaved changes")}
            </h2>
            <p id="admin-unsaved-description">
              {t(
                "保存成功後才離開；保存失敗會保留原有輸入。",
                "Leave after saving succeeds. Failed saves keep your inputs here.",
              )}
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className="primary-button"
                disabled={saving}
                onClick={async () => {
                  if (saving) return;
                  setSaving(true);
                  try {
                    if (await saveAll()) commit(pending);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {t("保存並離開", "Save and leave")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={saving}
                onClick={() => {
                  discardAll();
                  commit(pending);
                }}
              >
                {t("捨棄並離開", "Discard and leave")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={saving}
                onClick={stay}
              >
                {t("留在此頁", "Stay here")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
