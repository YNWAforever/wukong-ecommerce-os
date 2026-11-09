import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/studio/threads` server page (B5.1).
 *
 * The list is filtered by the service, not by narrowing an already-read first
 * page: these tests assert the `q` handed to the service, the validated-limit
 * behaviour and the honest filtered/empty states, with fakes only.
 */

const state = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  truncated: false,
  throws: false,
  locale: "en" as string,
  filters: null as Record<string, unknown> | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" ? { value: state.locale } : undefined,
  }),
}));

vi.mock("../studio-service", () => ({
  studioService: () => ({
    listThreads: async (filters?: Record<string, unknown>) => {
      if (state.throws) throw new Error("connection string must not leak");
      state.filters = filters ?? {};
      return { items: state.items, truncated: state.truncated };
    },
  }),
}));

import StudioThreadsPage from "./page";

function threadItem(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "11111111-1111-4111-8111-111111111111",
    title: "Synthetic conversation",
    skillKey: "catalog.find",
    visibility: "workspace",
    status: "open",
    createdBy: "actor",
    lastMessageAt: "2026-11-08T00:00:00.000Z",
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

async function render(search: Record<string, string | string[]> = {}) {
  return renderToStaticMarkup(
    await StudioThreadsPage({ searchParams: Promise.resolve(search) }),
  );
}

beforeEach(() => {
  state.items = [];
  state.truncated = false;
  state.throws = false;
  state.locale = "en";
  state.filters = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StudioThreadsPage search", () => {
  it("passes a trimmed server-side search to the service and renders matches", async () => {
    state.items = [threadItem()];
    const html = await render({ q: "  synthetic  " });
    expect(state.filters).toEqual({ q: "synthetic" });
    expect(html).toContain("Synthetic conversation");
    expect(html).toContain(
      "Search “synthetic”: 1 conversation(s), filtered on the server.",
    );
    expect(html).toContain('action="/studio/threads"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="q"');
    // Labelled, native GET form: Enter submits without any client JS.
    expect(html).toContain("Search conversations");
    expect(html).toContain('type="search"');
    expect(html).toContain('type="submit"');
    expect(html).toContain("Search");
  });

  it("uses the filtered-empty state when a search matches nothing", async () => {
    const html = await render({ q: "no-such-thread" });
    expect(html).toContain("No conversations match this search.");
    expect(html).not.toContain("No conversations yet.");
    expect(html).toContain("Search “no-such-thread”: 0 conversation(s)");
  });

  it("rejects an over-long search without filtering and says so", async () => {
    const html = await render({ q: "x".repeat(121) });
    expect(state.filters).toEqual({});
    expect(html).toContain(
      "A search is at most 120 characters; no filter was applied.",
    );
    expect(html).toContain("No conversations yet.");
  });

  it("takes the first value of a repeated query parameter", async () => {
    const html = await render({ q: ["first", "second"] });
    expect(state.filters).toEqual({ q: "first" });
    expect(html).toContain("Search “first”");
  });

  it("renders an unfiltered list without a search summary", async () => {
    state.items = [threadItem()];
    const html = await render();
    expect(state.filters).toEqual({});
    expect(html).toContain("Synthetic conversation");
    expect(html).not.toContain("filtered on the server");
  });

  it("keeps the honest failure line when the read throws", async () => {
    state.throws = true;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const html = await render({ q: "anything" });
    expect(html).toContain(
      "The conversation list could not be loaded; no estimated or invented conversations are shown.",
    );
    expect(html).not.toContain("connection string");
    expect(
      info.mock.calls.some((call) =>
        String(call[0]).includes("studio_threads_read_failed"),
      ),
    ).toBe(true);
  });

  it("renders zh-Hant copy for the zh-Hant locale", async () => {
    state.locale = "zh-Hant";
    state.items = [threadItem()];
    const html = await render({ q: "synthetic" });
    expect(html).toContain("搜尋「synthetic」");
    expect(html).toContain("對話");
  });
});
