import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/studio/inbox` server page (P3.1).
 *
 * The service and locale cookie are fakes; the page renders whatever the
 * pure builder returned. These tests pin the four sections, honest empty and
 * unavailable states, truncation notices, deep links and the single
 * content-free failure line.
 */

const state = vi.hoisted(() => ({
  inbox: null as Record<string, unknown> | null,
  throws: false,
  locale: "en" as string,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "locale" ? { value: state.locale } : undefined,
  }),
}));

vi.mock("../studio-service", () => ({
  studioService: () => ({
    inbox: async () => {
      if (state.throws) throw new Error("connection string must not leak");
      return state.inbox;
    },
  }),
}));

import StudioInboxPage from "./page";
import type { StudioInboxResult } from "../../../../lib/studio/contracts";

const AS_OF = "2026-11-09T12:00:00.000Z";

function emptyInbox(): StudioInboxResult {
  return {
    asOf: AS_OF,
    needsAttention: {
      items: [
        { key: "listings_with_gaps", count: 0, deepLink: "/quality" },
        {
          key: "listings_without_active_version",
          count: 0,
          deepLink: "/quality",
        },
        {
          key: "unassessable_active_version",
          count: 0,
          deepLink: "/quality",
        },
        {
          key: "listings_awaiting_review",
          count: 0,
          deepLink: "/dashboard",
        },
      ],
      unavailable: false,
      deepLink: "/quality",
    },
    jobs: {
      items: [],
      truncated: false,
      unavailable: false,
      deepLink: "/jobs",
    },
    outputs: {
      items: [],
      truncated: false,
      unavailable: false,
      deepLink: "/studio/outputs",
    },
    conversations: {
      items: [],
      truncated: false,
      unavailable: false,
      deepLink: "/studio/threads",
    },
  };
}

function populatedInbox(): StudioInboxResult {
  const inbox = emptyInbox();
  inbox.needsAttention.items = [
    { key: "listings_with_gaps", count: 3, deepLink: "/quality" },
    {
      key: "listings_without_active_version",
      count: 1,
      deepLink: "/quality",
    },
    { key: "unassessable_active_version", count: 2, deepLink: "/quality" },
    { key: "listings_awaiting_review", count: 4, deepLink: "/dashboard" },
  ];
  inbox.jobs = {
    items: [
      {
        jobId: "job-failed-1",
        state: "failed",
        errorCode: "provider_error",
        createdAt: AS_OF,
        deepLink: "/jobs",
      },
    ],
    truncated: true,
    unavailable: false,
    deepLink: "/jobs",
  };
  inbox.outputs = {
    items: [
      {
        outputId: "output-draft",
        kind: "copy_proposal",
        title: "Draft proposal",
        status: "draft",
        deepLink: "/studio/outputs",
      },
      {
        outputId: "output-saved",
        kind: "merchant_audit",
        title: "Saved audit",
        status: "saved",
        deepLink: "/studio/outputs",
      },
    ],
    truncated: false,
    unavailable: false,
    deepLink: "/studio/outputs",
  };
  inbox.conversations = {
    items: [
      {
        threadId: "thread-1",
        title: "Recent conversation",
        updatedAt: AS_OF,
        deepLink: "/studio/t/thread-1",
      },
    ],
    truncated: false,
    unavailable: false,
    deepLink: "/studio/threads",
  };
  return inbox;
}

async function render() {
  return renderToStaticMarkup(await StudioInboxPage());
}

beforeEach(() => {
  state.inbox = emptyInbox();
  state.throws = false;
  state.locale = "en";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StudioInboxPage", () => {
  it("renders the four aggregated sections with counts and deep links", async () => {
    state.inbox = populatedInbox();
    const html = await render();

    expect(html).toContain("Orchestration inbox");
    expect(html).toContain("Needs attention");
    expect(html).toContain("3 listing(s) with gaps");
    expect(html).toContain("1 listing(s) without an active version");
    expect(html).toContain("2 unassessable active version(s)");
    expect(html).toContain("4 listing(s) awaiting review");
    expect(html).toContain("Recent pipeline jobs");
    expect(html).toContain("job-failed-1");
    expect(html).toContain("State: failed");
    expect(html).toContain("Artifacts needing action");
    expect(html).toContain("Draft proposal");
    expect(html).toContain("Saved audit");
    expect(html).toContain("Draft (needs save)");
    expect(html).toContain("Saved (awaiting sign-off)");
    expect(html).toContain("Recent conversations");
    expect(html).toContain("Recent conversation");
    expect(html).toContain('href="/studio/t/thread-1"');
    // Section links stay on the existing screens.
    for (const href of [
      "/quality",
      "/jobs",
      "/studio/outputs",
      "/studio/threads",
    ])
      expect(html).toContain(`href="${href}"`);
    // Bounded views say so instead of implying completeness.
    expect(html).toContain("Only some items are shown; open the full list.");
    expect(html).toContain("From workspace records; no AI call.");
  });

  it("shows honest per-section empty states and an all-clear attention line", async () => {
    const html = await render();
    expect(html).toContain("Nothing needs attention right now.");
    expect(html).toContain("No failed or unfinished jobs.");
    expect(html).toContain(
      "No drafts awaiting save or artifacts awaiting sign-off.",
    );
    expect(html).toContain("No conversations yet.");
    expect(html).not.toContain("Only some items are shown");
  });

  it("renders an unavailable section instead of a zero", async () => {
    const inbox = emptyInbox();
    inbox.needsAttention.unavailable = true;
    inbox.needsAttention.items = [];
    inbox.jobs.unavailable = true;
    state.inbox = inbox;
    const html = await render();
    expect(html).toContain(
      "This section could not be read; it is not replaced with zero.",
    );
    expect(html).not.toContain("Nothing needs attention right now.");
  });

  it("collapses a read failure to one content-free failure line", async () => {
    state.throws = true;
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const html = await render();

    expect(html).toContain(
      "The inbox could not be read; no estimated or invented numbers are shown.",
    );
    expect(html).not.toContain("connection string");
    expect(
      info.mock.calls.some((call) =>
        String(call[0]).includes("studio_inbox_read_failed"),
      ),
    ).toBe(true);
  });

  it("renders zh-Hant copy for the zh-Hant locale", async () => {
    state.inbox = populatedInbox();
    state.locale = "zh-Hant";
    const html = await render();
    expect(html).toContain("編排收件匣");
    expect(html).toContain("需要處理");
    expect(html).toContain("3 個商品有缺口");
  });
});
