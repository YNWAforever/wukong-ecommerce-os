import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/studio/outputs` server page (plan Task 9).
 *
 * The service, the session and the locale cookie are injected fakes; the client
 * `StudioOutputCard` renders its collapsed summary during server rendering, so
 * the assertions cover the honest list/empty/error states without a browser.
 */

const state = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  truncated: false,
  throws: false,
  canSignOff: true,
  locale: "en" as string,
  filters: null as Record<string, unknown> | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" ? { value: state.locale } : undefined,
  }),
}));

vi.mock("../../../../lib/session-context", () => ({
  authSessionContext: {
    resolve: async () => ({
      workspaceId: "workspace",
      actorId: "actor",
      role: "admin",
    }),
  },
  requireWorkspaceRole: () => state.canSignOff,
}));

vi.mock("../studio-service", () => ({
  studioService: () => ({
    listOutputs: async (filters?: Record<string, unknown>) => {
      if (state.throws) throw new Error("connection string must not leak");
      state.filters = filters ?? {};
      return {
        items: state.items,
        truncated: state.truncated,
        offset: typeof filters?.offset === "number" ? filters.offset : 0,
      };
    },
  }),
}));

import StudioOutputsPage from "./page";

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    outputId: "output-1",
    kind: "copy_proposal",
    title: "Synthetic copy proposal",
    status: "saved",
    currentVersion: 2,
    threadId: "thread-1",
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
    ...overrides,
  };
}

async function render(search: Record<string, string> = {}) {
  return renderToStaticMarkup(
    await StudioOutputsPage({ searchParams: Promise.resolve(search) }),
  );
}

beforeEach(() => {
  state.items = [];
  state.truncated = false;
  state.throws = false;
  state.canSignOff = true;
  state.locale = "en";
  state.filters = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StudioOutputsPage", () => {
  it("renders saved artifacts from the service as collapsed output cards", async () => {
    state.items = [
      listItem(),
      listItem({
        outputId: "output-2",
        title: "Synthetic gap report",
        kind: "gap_report",
        status: "draft",
      }),
    ];

    const html = await render();

    expect(html).toContain("Outputs");
    expect(html).toContain("Synthetic copy proposal");
    expect(html).toContain("Synthetic gap report");
    expect(html).toContain("Copy proposal");
    expect(html).toContain("Gap report");
    expect(html).toContain("Saved");
    expect(html).toContain("Draft");
    expect((html.match(/data-expandable="true"/g) ?? []).length).toBe(2);
    expect(html).toContain("View artifact");
  });

  it("renders labelled filter controls in a native GET form", async () => {
    const html = await render();
    expect(html).toContain('role="search"');
    expect(html).toContain("Filter artifacts");
    expect(html).toContain("Search titles");
    expect(html).toContain("Kind");
    expect(html).toContain("Status");
    expect(html).toContain("All kinds");
    expect(html).toContain("All statuses");
    expect(html).toContain("Apply filters");
    expect(html).toContain('type="submit"');
    expect(html).toContain('<select id="studio-outputs-kind" name="kind"');
  });

  it("shows the honest empty state with what will fill it", async () => {
    const html = await render();

    expect(html).toContain("No saved outputs.");
    expect(html).toContain("Artifacts appear here after a skill saves one.");
  });

  it("renders a next-page link when more artifacts exist", async () => {
    state.items = [listItem()];
    state.truncated = true;

    const html = await render();
    expect(html).toContain("Page 1 · 1 item(s)");
    expect(html).toContain('href="/studio/outputs?offset=50"');
    expect(html).toContain("Earlier artifacts");
    expect(html).not.toContain("Newer artifacts");
  });

  it("fails closed to an honest error line and logs no content when the read throws", async () => {
    state.throws = true;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const html = await render();

    expect(html).toContain(
      "The artifact list could not be loaded; nothing is estimated.",
    );
    expect(html).not.toContain("connection string");
    expect(
      info.mock.calls.some((call) =>
        String(call[0]).includes("studio_outputs_read_failed"),
      ),
    ).toBe(true);
  });

  it("passes the validated filters to the server list and shows a filtered summary", async () => {
    state.items = [listItem()];
    const html = await render({
      q: "  proposal  ",
      kind: "copy_proposal",
      status: "saved",
    });
    expect(state.filters).toEqual({
      q: "proposal",
      kind: "copy_proposal",
      status: "saved",
      offset: 0,
    });
    expect(html).toContain(
      "Filtered result: 1 artifact(s), filtered on the server (search: proposal).",
    );
    expect(html).toContain("Clear filters");
    expect(html).toContain('action="/studio/outputs"');
    expect(html).toContain('name="q"');
    expect(html).toContain('name="kind"');
    expect(html).toContain('name="status"');
    // The selected values survive a server round-trip.
    expect(html).toContain('value="copy_proposal" selected=""');
    expect(html).toContain('value="saved" selected=""');
  });

  it("renders the honest filtered-empty state instead of the unfiltered one", async () => {
    const html = await render({ kind: "finding" });
    expect(html).toContain("No artifacts match these filters.");
    expect(html).not.toContain("No saved outputs.");
    expect(html).toContain("0 artifact(s)");
  });

  it("fails closed to an honest notice for invalid filter values", async () => {
    const html = await render({ kind: "bogus", status: "nope" });
    expect(state.filters).toEqual({});
    expect(html).toContain(
      "The filter or page parameters are invalid; no filter was applied.",
    );
    expect(html).toContain("No artifacts match these filters.");
  });

  it("preserves every filter in both pagination links mid-list", async () => {
    state.items = [listItem()];
    state.truncated = true;
    const html = await render({
      q: "proposal",
      kind: "copy_proposal",
      status: "saved",
      offset: "50",
    });
    expect(state.filters).toEqual({
      q: "proposal",
      kind: "copy_proposal",
      status: "saved",
      offset: 50,
    });
    expect(html).toContain("Page 2 · 1 item(s)");
    expect(html).toContain(
      'href="/studio/outputs?q=proposal&amp;kind=copy_proposal&amp;status=saved"',
    );
    expect(html).toContain(
      'href="/studio/outputs?q=proposal&amp;kind=copy_proposal&amp;status=saved&amp;offset=100"',
    );
    expect(html).toContain("Newer artifacts");
    expect(html).toContain("Earlier artifacts");
  });

  it("renders only the newer link on the last page", async () => {
    state.items = [listItem()];
    const html = await render({ offset: "100" });
    expect(html).toContain("Page 3 · 1 item(s)");
    expect(html).toContain('href="/studio/outputs?offset=50"');
    expect(html).not.toContain("Earlier artifacts");
  });

  it("shows an honest empty page beyond the end", async () => {
    const html = await render({ offset: "50" });
    expect(html).toContain("No items on this page; go to a newer page.");
    expect(html).toContain('href="/studio/outputs"');
    expect(html).toContain("Newer artifacts");
  });

  it("fails closed to the first page for an out-of-range offset", async () => {
    const html = await render({ offset: "-1" });
    expect(state.filters).toEqual({});
    expect(html).toContain(
      "The filter or page parameters are invalid; no filter was applied.",
    );
    expect(html).toContain("Page 1 · 0 item(s)");
  });

  it("omits the clear/filtered summary for an unfiltered list", async () => {
    state.items = [listItem()];
    const html = await render();
    expect(state.filters).toEqual({ offset: 0 });
    expect(html).not.toContain("Clear filters");
    expect(html).not.toContain("Filtered result:");
  });

  it("renders zh-Hant labels for the zh-Hant locale", async () => {
    state.items = [listItem()];
    state.locale = "zh-Hant";
    const html = await render();
    expect(html).toContain("輸出");
    expect(html).toContain("文案建議");
    expect(html).toContain("已儲存");
  });
});
