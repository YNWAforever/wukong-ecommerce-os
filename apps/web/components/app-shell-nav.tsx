"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";

import { useLocalePreference } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { setLocaleCookie, type Locale } from "../lib/locale";

export type NavItem = {
  href: string;
  labelZh: string;
  labelEn: string;
  group?: "primary" | "tools";
};

type AppShellNavProps = {
  navItems: NavItem[];
  isAdmin: boolean;
  workspaceName: string;
  roleLabelZh: string;
  roleLabelEn: string;
  initialLocale: Locale;
  onLocaleChange?: (locale: Locale) => void;
};

const MOBILE_NAV_COUNT = 4;
const ADMIN_ITEM: NavItem = {
  href: "/admin",
  labelZh: "管理",
  labelEn: "Admin",
};
const FOCUSABLE_SELECTOR = "a[href], button:not([disabled])";
const DRAWER_LABEL = "流動版完整導覽";

export function AppShellNav({
  navItems,
  isAdmin,
  workspaceName,
  roleLabelZh,
  roleLabelEn,
  initialLocale,
  onLocaleChange,
}: AppShellNavProps) {
  const preference = useLocalePreference();
  const [fallbackLocale, setLocale] = useState<Locale>(initialLocale);
  const locale = preference?.locale ?? fallbackLocale;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  const searchParams = useSearchParams();
  const primaryNav = navItems.filter((item) => item.group !== "tools");
  const toolsNav = navItems.filter((item) => item.group === "tools");
  const mobileNav = primaryNav.slice(0, MOBILE_NAV_COUNT);
  const isActive = (href: string) => {
    const [itemPath, query] = href.split("?");
    if (pathname !== itemPath && !pathname.startsWith(`${itemPath}/`))
      return false;
    if (itemPath === "/jobs") {
      const exportSelected = searchParams.get("kind") === "export";
      return (
        (new URLSearchParams(query).get("kind") === "export") === exportSelected
      );
    }
    return true;
  };
  const navClassName = (item: NavItem) =>
    isActive(item.href) ? "active" : undefined;
  const label = (item: NavItem) =>
    localized(locale, item.labelZh, item.labelEn);

  function navGroups(inDrawer = false) {
    return (["primary", "tools"] as const).map((group) => {
      const items = group === "primary" ? primaryNav : toolsNav;
      if (items.length === 0) return null;
      const groupLabel =
        group === "primary"
          ? localized(locale, "主要", "Primary")
          : localized(locale, "工具", "Tools");
      return (
        <div
          key={group}
          className="app-nav-group"
          role="group"
          aria-label={groupLabel}
        >
          <span className="app-nav-group-label" aria-hidden="true">
            {groupLabel}
          </span>
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={navClassName(item)}
              aria-current={isActive(item.href) ? "page" : undefined}
              onClick={inDrawer ? closeDrawer : undefined}
            >
              {label(item)}
            </Link>
          ))}
        </div>
      );
    });
  }

  function changeLocale(next: Locale) {
    setLocale(next);
    if (preference) preference.changeLocale(next);
    else setLocaleCookie(next);
    onLocaleChange?.(next);
  }

  function openDrawer() {
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

  // useLayoutEffect (not useEffect) so initial focus moves into the drawer
  // before paint, and so the cleanup below restores focus to the trigger
  // only after the background content's `inert` attribute has already been
  // cleared by the same commit (inert content cannot be focused).
  useLayoutEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    const background = Array.from(
      document.querySelectorAll<HTMLElement>(
        "#main-content,.app-footer,.skip-link",
      ),
    );
    const inertBefore = background.map((el) => el.hasAttribute("inert"));
    background.forEach((el) => el.setAttribute("inert", ""));
    const focusable = () =>
      Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    focusable()[0]?.focus();

    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    drawer.addEventListener("keydown", handleKeydown);
    return () => {
      drawer.removeEventListener("keydown", handleKeydown);
      background.forEach((el, i) => {
        if (!inertBefore[i]) el.removeAttribute("inert");
      });
      triggerRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen]);

  return (
    <>
      {/* Everything the mobile drawer sits on top of. `inert` while the
          drawer is open removes it from the focus order, the accessibility
          tree, and pointer/touch hit-testing, so it can't be reached or
          clicked through around the modal drawer — `aria-modal="true"` on
          the drawer alone doesn't enforce that on its own. */}
      <div className="app-shell-nav-chrome" inert={drawerOpen}>
        <div className="brand-lockup">
          <Link
            className="brand-mark"
            href="/dashboard"
            aria-label={localized(locale, "Wukong 首頁", "Wukong home")}
          >
            W
          </Link>
          <div>
            <Link className="brand-name" href="/dashboard">
              Wukong
            </Link>
            <span className="brand-context">{workspaceName}</span>
          </div>
        </div>

        <nav
          className={
            isAdmin ? "app-sidebar" : "app-sidebar app-sidebar--no-admin-footer"
          }
          aria-label={localized(locale, "主要導覽", "Main navigation")}
        >
          {navGroups()}
        </nav>

        {isAdmin ? (
          <div className="app-sidebar-admin">
            <Link
              href="/admin"
              className={navClassName(ADMIN_ITEM)}
              aria-current={isActive("/admin") ? "page" : undefined}
            >
              {label(ADMIN_ITEM)}
            </Link>
          </div>
        ) : null}

        <div
          className="locale-toggle"
          role="group"
          aria-label={localized(locale, "介面語言", "Interface language")}
        >
          <button
            type="button"
            data-testid="locale-toggle-zh"
            aria-pressed={locale === "zh-Hant"}
            onClick={() => changeLocale("zh-Hant")}
          >
            繁中
          </button>
          <button
            type="button"
            data-testid="locale-toggle-en"
            aria-pressed={locale === "en"}
            onClick={() => changeLocale("en")}
          >
            EN
          </button>
        </div>

        <nav
          className="app-bottom-nav"
          aria-label={localized(
            locale,
            "流動版主要導覽",
            "Mobile main navigation",
          )}
        >
          {mobileNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={navClassName(item)}
              aria-current={isActive(item.href) ? "page" : undefined}
            >
              {label(item)}
            </Link>
          ))}
          <button
            type="button"
            ref={triggerRef}
            data-testid="drawer-trigger"
            aria-expanded={drawerOpen}
            onClick={openDrawer}
          >
            {localized(locale, "開啟導覽", "Open navigation")}
          </button>
        </nav>

        <div className="topbar-meta">
          <span className="pilot-badge">
            {localized(locale, "試行", "PILOT")}
          </span>
          <span className="operator-name">
            {localized(locale, roleLabelZh, roleLabelEn)}
          </span>
        </div>
      </div>

      {drawerOpen ? (
        <div
          className="app-drawer"
          data-testid="drawer"
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label={localized(locale, DRAWER_LABEL, "Full mobile navigation")}
        >
          <button
            type="button"
            data-testid="drawer-close"
            onClick={closeDrawer}
          >
            {localized(locale, "關閉", "Close")}
          </button>
          <nav
            aria-label={localized(
              locale,
              DRAWER_LABEL,
              "Full mobile navigation",
            )}
          >
            {navGroups(true)}
            {isAdmin ? (
              <Link
                href="/admin"
                className={navClassName(ADMIN_ITEM)}
                aria-current={isActive("/admin") ? "page" : undefined}
                onClick={closeDrawer}
              >
                {label(ADMIN_ITEM)}
              </Link>
            ) : null}
          </nav>
        </div>
      ) : null}
    </>
  );
}
