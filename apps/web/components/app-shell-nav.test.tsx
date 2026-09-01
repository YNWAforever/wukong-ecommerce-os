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
    expect(document.activeElement).not.toBe(document.body);
    expect(drawer!.contains(document.activeElement)).toBe(true);

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
