// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppShellNav, type NavItem } from "./app-shell-nav.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelZh: "總覽", labelEn: "Overview" },
  { href: "/catalog", labelZh: "商品中心", labelEn: "Catalog" },
  { href: "/listings/new", labelZh: "建立草稿", labelEn: "New listing" },
  {
    href: "/listings/import",
    labelZh: "SHOPLINE 匯入",
    labelEn: "Bulk import",
  },
  { href: "/batches", labelZh: "批次", labelEn: "Batches" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.cookie = "locale=; path=/; max-age=0";
});

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("AppShellNav", () => {
  it("renders every nav item plus Admin when isAdmin is true", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={true}
        workspaceName="Opak Cellar"
        roleLabelZh="操作員"
        roleLabelEn="Operator"
        initialLocale="zh-Hant"
      />,
    );
    const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    for (const item of NAV_ITEMS) {
      expect(hrefs).toContain(item.href);
    }
    expect(hrefs).toContain("/admin");
  });

  it("omits Admin when isAdmin is false", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).not.toContain("/admin");
  });

  it("renders the workspace name from props, not a hard-coded string", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Distinct Test Workspace Name"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    expect(container.textContent).toContain("Distinct Test Workspace Name");
    expect(container.textContent).not.toContain("Opak Cellar");
  });

  it("opens the mobile drawer, traps focus inside it, and restores focus to the trigger on close", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="drawer-trigger"]',
    );
    expect(trigger).not.toBeNull();

    act(() => {
      trigger!.click();
    });

    const drawer = container.querySelector<HTMLElement>(
      '[data-testid="drawer"]',
    );
    expect(drawer).not.toBeNull();
    expect(drawer!.getAttribute("aria-label")).toBe("流動版完整導覽");
    expect(document.activeElement).not.toBe(document.body);
    expect(drawer!.contains(document.activeElement)).toBe(true);

    // The rest of the shell (sidebar, locale toggle, bottom-nav, etc.) must
    // be made inert while the drawer is the modal foreground, otherwise a
    // pointer user can click straight through to a background link despite
    // aria-modal="true" on the drawer.
    const chrome = container.querySelector(".app-shell-nav-chrome");
    expect(chrome).not.toBeNull();
    expect(chrome!.hasAttribute("inert")).toBe(true);

    // Tab beyond the last focusable element inside the drawer must wrap back
    // to the first one, not escape the drawer. happy-dom does not natively
    // move focus on a dispatched Tab keydown (real Tab-order traversal is a
    // browser behavior, not something a KeyboardEvent triggers by itself),
    // so asserting only `drawer.contains(activeElement)` here would pass
    // trivially even with no wrap-around logic at all (focus would simply
    // stay on `last`, which is still inside the drawer). Assert the actual
    // wrapped target instead so a disabled/broken wrap handler is caught.
    const focusable = drawer!.querySelectorAll<HTMLElement>(
      "a[href], button:not([disabled])",
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    act(() => {
      last.focus();
    });
    act(() => {
      last.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(first);

    act(() => {
      first.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(document.activeElement).toBe(last);

    const closeButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="drawer-close"]',
    );
    act(() => {
      closeButton!.click();
    });
    expect(document.activeElement).toBe(trigger);
    expect(chrome!.hasAttribute("inert")).toBe(false);
  });

  it("closes the drawer and restores focus to the trigger on Escape", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="drawer-trigger"]',
    );
    act(() => {
      trigger!.click();
    });
    const drawer = container.querySelector<HTMLElement>(
      '[data-testid="drawer"]',
    );
    expect(drawer).not.toBeNull();

    act(() => {
      drawer!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });

    expect(container.querySelector('[data-testid="drawer"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the drawer when a nav link inside it is clicked", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="drawer-trigger"]',
    );
    act(() => {
      trigger!.click();
    });
    const drawer = container.querySelector<HTMLElement>(
      '[data-testid="drawer"]',
    );
    expect(drawer).not.toBeNull();
    const navLink =
      drawer!.querySelector<HTMLAnchorElement>('a[href="/catalog"]');
    expect(navLink).not.toBeNull();

    act(() => {
      navLink!.click();
    });

    expect(container.querySelector('[data-testid="drawer"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows only the first MOBILE_NAV_COUNT items in the bottom nav, not the full list", () => {
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
      />,
    );
    const bottomNav = container.querySelector(".app-bottom-nav");
    expect(bottomNav).not.toBeNull();
    const bottomNavHrefs = Array.from(
      bottomNav!.querySelectorAll("a[href]"),
    ).map((a) => a.getAttribute("href"));
    expect(bottomNavHrefs).toEqual([
      "/dashboard",
      "/catalog",
      "/listings/new",
      "/listings/import",
    ]);
    expect(bottomNavHrefs).not.toContain("/batches");

    // The desktop sidebar still renders every item, including the one the
    // bottom nav truncated away.
    const sidebarHrefs = Array.from(
      container.querySelector(".app-sidebar")!.querySelectorAll("a[href]"),
    ).map((a) => a.getAttribute("href"));
    expect(sidebarHrefs).toContain("/batches");
  });

  it("sets the locale cookie and calls the onLocaleChange callback when the toggle is clicked", () => {
    let receivedLocale: string | null = null;
    render(
      <AppShellNav
        navItems={NAV_ITEMS}
        isAdmin={false}
        workspaceName="Opak Cellar"
        roleLabelZh="檢視者"
        roleLabelEn="Viewer"
        initialLocale="zh-Hant"
        onLocaleChange={(locale) => {
          receivedLocale = locale;
        }}
      />,
    );
    const enButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="locale-toggle-en"]',
    );
    act(() => {
      enButton!.click();
    });
    expect(receivedLocale).toBe("en");
    expect(document.cookie).toContain("locale=en");
  });
});
