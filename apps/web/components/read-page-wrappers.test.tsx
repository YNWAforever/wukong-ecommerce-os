// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
const current = vi.hoisted(() => ({ locale: "zh-Hant" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: current.locale }) }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/catalog",
}));
vi.mock("../lib/session-context", () => ({
  authSessionContext: { resolve: async () => null },
  requireWorkspaceRole: () => false,
}));
vi.mock("../app/(app)/workspace-chrome", () => ({
  resolveWorkspaceChrome: async () => ({
    workspaceName: "Synthetic workspace",
    roleLabel: { zh: "檢視者", en: "Viewer" },
  }),
}));
import CatalogPage from "../app/(app)/catalog/page";
import DashboardPage from "../app/(app)/dashboard/page";
import QueuePage from "../app/(app)/queue/page";
import JobsPage from "../app/(app)/jobs/page";
import QualityPage from "../app/(app)/quality/page";
import SystemMapPage from "../app/(app)/system-map/page";
import AppLayout from "../app/(app)/layout";
import { generateMetadata } from "../app/layout";
import { LocaleProvider } from "../lib/locale-context";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it.each(["zh-Hant", "en"] as const)(
  "resolves server headers, metadata and focusable skip destination from the existing cookie in %s",
  async (locale) => {
    current.locale = locale;
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const el = document.createElement("div");
    const root = createRoot(el);
    const pages = await Promise.all([
      CatalogPage(),
      DashboardPage(),
      QueuePage(),
      JobsPage(),
      QualityPage(),
      SystemMapPage(),
    ]);
    const shell = await AppLayout({ children: pages });
    await act(async () =>
      root.render(<LocaleProvider locale={locale}>{shell}</LocaleProvider>),
    );
    const headers = Array.from(el.querySelectorAll("h1")).map(
      (x) => x.textContent,
    );
    expect(headers).toHaveLength(6);
    expect(headers[0]).toBe(
      locale === "en"
        ? "Track platform products and listing drafts in one place."
        : "由平台商品到可發佈草稿，一頁掌握營運狀態。",
    );
    for (const header of headers)
      expect(header).not.toMatch(
        locale === "en" ? /[\u4e00-\u9fff]/ : /^Track |^Your |^Focus /,
      );
    expect(el.querySelector(".skip-link")?.textContent).toBe(
      locale === "en" ? "Skip to content" : "跳到主要內容",
    );
    expect(el.querySelector("#main-content")?.getAttribute("tabindex")).toBe(
      "-1",
    );
    const metadata = await generateMetadata();
    expect(metadata.title).toBe(
      locale === "en" ? "Wukong · Listing operations" : "Wukong · 商品營運",
    );
    expect(JSON.stringify(metadata)).not.toContain("Opak");
    expect(el.textContent).not.toContain("OPAK PILOT");
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  },
);
