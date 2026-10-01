// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";
const current = vi.hoisted(() => ({
  locale: "zh-Hant",
  authenticated: true,
  workspaceId: "wrapper-workspace",
  actorId: "wrapper-actor",
  role: "viewer",
}));
const workspaceRead = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: current.locale }) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/catalog",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../lib/session-context", () => ({
  authSessionContext: {
    resolve: async () =>
      current.authenticated
        ? {
            workspaceId: current.workspaceId,
            actorId: current.actorId,
            role: current.role,
          }
        : null,
  },
  requireWorkspaceRole: () => false,
}));
vi.mock("../lib/intake-runtime", () => ({
  getDatabase: () => ({
    forWorkspace: async (
      workspaceId: string,
      work: (repos: unknown) => unknown,
    ) => {
      workspaceRead(workspaceId);
      expect(workspaceId).toBe("wrapper-workspace");
      return work({
        assignments: {
          listActiveMembers: async () => [
            {
              userId: "wrapper-actor",
              email: "wrapper@local.invalid",
              name: "Synthetic viewer",
              role: "viewer",
            },
          ],
        },
      });
    },
  }),
}));
vi.mock("../lib/workspace-selection", () => ({
  listUserWorkspaces: async (actorId: string) => {
    expect(actorId).toBe("wrapper-actor");
    return [];
  },
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
      locale === "en" ? "Catalog operations" : "商品營運",
    );
    expect(el.textContent).toContain("Synthetic viewer");
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
it("redirects an absent server session before reading workspace account data", async () => {
  current.authenticated = false;
  const readsBefore = workspaceRead.mock.calls.length;
  try {
    await expect(AppLayout({ children: null })).rejects.toThrow(
      "redirect:/signin",
    );
    expect(workspaceRead.mock.calls).toHaveLength(readsBefore);
  } finally {
    current.authenticated = true;
  }
});

it("remounts quality work when the server workspace, actor or role changes", async () => {
  const clientKey = async () => (await QualityPage()).props.children.at(-1).key;
  const initial = await clientKey();
  try {
    current.workspaceId = "wrapper-other";
    const switched = await clientKey();
    expect(switched).not.toBe(initial);
    current.actorId = "wrapper-other-actor";
    const otherActor = await clientKey();
    expect(otherActor).not.toBe(switched);
    current.role = "operator";
    expect(await clientKey()).not.toBe(otherActor);
  } finally {
    current.workspaceId = "wrapper-workspace";
    current.actorId = "wrapper-actor";
    current.role = "viewer";
  }
});

it("redirects quality when the current server membership is absent", async () => {
  current.authenticated = false;
  try {
    await expect(QualityPage()).rejects.toThrow("redirect:/signin");
  } finally {
    current.authenticated = true;
  }
});
