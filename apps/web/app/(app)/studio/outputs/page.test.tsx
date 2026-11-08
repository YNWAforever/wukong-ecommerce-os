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
    listOutputs: async () => {
      if (state.throws) throw new Error("connection string must not leak");
      return { items: state.items, truncated: state.truncated };
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

async function render() {
  return renderToStaticMarkup(await StudioOutputsPage());
}

beforeEach(() => {
  state.items = [];
  state.truncated = false;
  state.throws = false;
  state.canSignOff = true;
  state.locale = "en";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StudioOutputsPage", () => {
  it("renders saved artifacts from the service as collapsed output cards", async () => {
    state.items = [
      listItem(),
      listItem({ outputId: "output-2", title: "Synthetic gap report", kind: "gap_report", status: "draft" }),
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

  it("shows the honest empty state with what will fill it", async () => {
    const html = await render();

    expect(html).toContain("No saved outputs.");
    expect(html).toContain("Artifacts appear here after a skill saves one.");
  });

  it("states when the list is truncated instead of implying a complete list", async () => {
    state.items = [listItem()];
    state.truncated = true;

    const html = await render();
    expect(html).toContain("Only the most recent artifacts are shown.");
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

  it("renders zh-Hant labels for the zh-Hant locale", async () => {
    state.items = [listItem()];
    state.locale = "zh-Hant";
    const html = await render();
    expect(html).toContain("輸出");
    expect(html).toContain("文案建議");
    expect(html).toContain("已儲存");
  });
});
