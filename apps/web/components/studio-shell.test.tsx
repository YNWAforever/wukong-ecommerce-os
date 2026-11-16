// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/studio",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
  usePathname: () => navigation.pathname,
}));

import { StudioShell } from "./studio-shell";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const threads = [
  {
    threadId: "thread-1",
    title: "Synthetic first conversation",
    skillKey: "catalog.find",
    lastMessageAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    status: "open" as const,
  },
  {
    threadId: "thread-2",
    title: "Synthetic second conversation",
    skillKey: null,
    lastMessageAt: null,
    updatedAt: "2026-11-07T00:00:00.000Z",
    status: "archived" as const,
  },
];

function render(overrides: Partial<Parameters<typeof StudioShell>[0]> = {}) {
  return renderToStaticMarkup(
    <StudioShell locale="en" workspaceName="Opak Cellar" {...overrides}>
      <p>page content</p>
    </StudioShell>,
  );
}

function activeAnchor(html: string): string {
  return html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(
  overrides: Partial<Parameters<typeof StudioShell>[0]> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <StudioShell locale="en" workspaceName="Opak Cellar" {...overrides}>
        <p>page content</p>
      </StudioShell>,
    );
  });
  return container;
}

beforeEach(() => {
  navigation.push.mockReset();
  navigation.pathname = "/studio";
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("StudioShell", () => {
  it("renders the workspace name, the work and records destinations, and the page slot", () => {
    const html = render();

    expect(html).toContain("Opak Cellar");
    expect(html).toContain("page content");
    for (const href of [
      "/studio",
      "/studio/inbox",
      "/studio/reviews",
      "/studio/threads",
      "/studio/outputs",
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("Inbox");
    expect(html).toContain("Batch review");
    expect(html).toContain("Saved work");
    // Admin destinations are not dangled in front of an operator: the settings
    // page answers 404 to them, which used to look like a broken Studio.
    expect(html).not.toContain('href="/studio/settings"');
    expect(html).not.toContain('href="/studio/connections"');
  });

  it("renders admin destinations only for administrators", () => {
    const html = render({ canAdmin: true });

    expect(html).toContain('href="/studio/settings"');
    expect(html).toContain('href="/studio/connections"');
    expect(html).toContain("Admin");
  });

  it("marks the current destination with aria-current", () => {
    navigation.pathname = "/studio/inbox";
    const html = render();

    const active = activeAnchor(html);
    expect(active).toContain('href="/studio/inbox"');
    expect(active).not.toContain('href="/studio"');
  });

  it("marks conversations for a thread detail page and keeps Overview exact", () => {
    navigation.pathname = "/studio/t/thread-1";
    expect(activeAnchor(render())).toContain('href="/studio/threads"');

    navigation.pathname = "/studio";
    expect(activeAnchor(render())).toContain('href="/studio"');
  });

  it("expands and collapses the compact rail menu", async () => {
    const container = await mount();

    const toggle = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Menu",
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("aside")?.getAttribute("data-open")).toBe(
      "false",
    );

    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("aside")?.getAttribute("data-open")).toBe(
      "true",
    );
  });

  it("renders recent conversations from props with thread links", () => {
    const html = render({ recentThreads: threads, recentTruncated: true });

    expect(html).toContain("Synthetic first conversation");
    expect(html).toContain("Synthetic second conversation");
    expect(html).toContain('href="/studio/t/thread-1"');
    expect(html).toContain('href="/studio/t/thread-2"');
    expect(html).toContain(
      "Only the most recently updated conversations are shown.",
    );
    expect(html).toContain("View all conversations");
  });

  it("shows the honest empty state and never invents a conversation", () => {
    const html = render({ recentThreads: [] });

    expect(html).toContain("No conversations yet");
    expect(html).not.toMatch(/\/studio\/t\//);
  });

  it("disables New conversation for a role below operator and states why", () => {
    const html = render({ canCreateThread: false });

    expect(html).toMatch(
      /<button[^>]*disabled[^>]*>New conversation<\/button>/,
    );
    expect(html).toContain(
      "An operator or higher role is required to create conversations.",
    );
  });

  it("creates a conversation and navigates to it from the rail action", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ threadId: "thread-new" }, { status: 201 }),
      );
    vi.stubGlobal("fetch", fetcher);

    const container = await mount({ canCreateThread: true });
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "New conversation",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("/api/studio/threads");
    expect(navigation.push).toHaveBeenCalledWith("/studio/t/thread-new");
  });

  it("renders zh-Hant rail copy for the zh-Hant locale", () => {
    const html = renderToStaticMarkup(
      <StudioShell
        locale="zh-Hant"
        workspaceName="Opak Cellar"
        recentThreads={[]}
        canAdmin
      >
        <p>page content</p>
      </StudioShell>,
    );

    expect(html).toContain("新對話");
    expect(html).toContain("總覽");
    expect(html).toContain("設定");
    expect(html).toContain("還沒有對話");
    expect(html).toContain("批次審查");
    expect(html).toContain("已儲存成果");
  });
});
