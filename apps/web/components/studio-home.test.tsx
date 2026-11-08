// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

import type { StudioOverviewResult } from "../lib/studio/contracts";
import type { StudioTurnReply } from "../lib/studio/types";
import { STUDIO_COPY } from "../lib/studio-copy";
import { STUDIO_TEMPLATES, StudioHome } from "./studio-home";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const overview: StudioOverviewResult = {
  listingCounts: {
    byStatus: { approved: 3 },
    total: 3,
    deepLink: "/dashboard",
  },
  quality: {
    assessmentVersion: "v1",
    totalListings: 6,
    totalAssessed: 5,
    cleanCount: 4,
    hasGapsCount: 1,
    noActiveVersion: 0,
    unassessableActiveVersion: 0,
    projectionState: "ready",
    asOf: "2026-11-08T00:00:00.000Z",
    deepLink: "/quality",
  },
  recentJobs: {
    items: [
      {
        jobId: "job-1",
        state: "failed",
        createdAt: "2026-11-08T00:00:00.000Z",
        deepLink: "/jobs",
      },
    ],
    deepLink: "/jobs",
  },
};

const reply: StudioTurnReply = {
  status: "answered",
  skillKey: "catalog.find",
  skillVersion: "1.0.0",
  records: {
    sections: [
      {
        key: "studio.answer.catalog_found",
        values: { count: 1, truncated: false },
      },
    ],
    checks: [],
    coverage: {},
  },
  outputs: [],
  dispatch: null,
  analysis: null,
  traceSummary: { stepCount: 1 },
  limitations: [],
  followUps: [],
};

function render(
  locale: "zh-Hant" | "en" = "en",
  props: Partial<Parameters<typeof StudioHome>[0]> = {},
) {
  return renderToStaticMarkup(
    <StudioHome
      locale={locale}
      overview={overview}
      canCreateThread
      {...props}
    />,
  );
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(props: Partial<Parameters<typeof StudioHome>[0]> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <StudioHome locale="en" overview={overview} canCreateThread {...props} />,
    );
  });
  return container;
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector("textarea") as HTMLTextAreaElement;
}

function buttonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  ) as HTMLButtonElement | undefined;
}

async function type(container: HTMLElement, value: string) {
  const input = textarea(container);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendResultBody() {
  return {
    threadId: "thread-new",
    messageId: "message-new",
    runId: "run-new",
    reply,
    trace: [],
    replayed: false,
  };
}

beforeEach(() => {
  navigation.push.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("StudioHome", () => {
  it("renders the greeting, composer, overview and permanent disclaimer", () => {
    const html = render();

    expect(html).toContain("Welcome back");
    expect(html).toContain("Ask about listings, quality or jobs…");
    expect(html).toContain("AI may be wrong; verify important numbers.");
    expect(html).toContain("From workspace records; no AI call.");
    expect(html).toContain("3 in total");
    expect(html).toContain('href="/dashboard"');
  });

  it("makes no fetch and no model call while rendering", async () => {
    const fetcher = vi.fn(() => {
      throw new Error("home must not fetch while rendering");
    });
    vi.stubGlobal("fetch", fetcher);

    const html = render();
    expect(html).toContain("Start a conversation");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renders every role template with an honest availability label", () => {
    const html = render();

    expect((html.match(/<h3/g) ?? []).length).toBe(STUDIO_TEMPLATES.length);
    expect((html.match(/>Pilot</g) ?? []).length).toBe(2);
    expect((html.match(/>Planned</g) ?? []).length).toBe(6);
    expect((html.match(/>Unavailable</g) ?? []).length).toBe(2);
    // Only the two pilot cards are interactive.
    expect((html.match(/>Fill the composer</g) ?? []).length).toBe(2);
  });

  it("keeps only the two v1 read skills interactive and none ready", () => {
    expect(
      STUDIO_TEMPLATES.filter(
        (template) => template.availability === "pilot",
      ).map((template) => template.id),
    ).toEqual(["catalog.find", "catalog.gap_review"]);
    expect(
      STUDIO_TEMPLATES.some((template) => template.availability === "ready"),
    ).toBe(false);
    for (const template of STUDIO_TEMPLATES) {
      for (const key of [
        template.titleKey,
        template.outcomeKey,
        template.limitationKey,
        ...(template.starterKey ? [template.starterKey] : []),
      ]) {
        expect(STUDIO_COPY[key]).toBeDefined();
      }
    }
  });

  it("fills the composer and focuses it from a pilot card without sending", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    expect(textarea(container).value).toBe("");

    const fill = buttonByText(container, "Fill the composer");
    await act(async () => fill?.click());

    expect(textarea(container).value).toBe("Find and explain these listings: ");
    expect(container.textContent).toContain("Selected skill");
    expect(container.textContent).toContain("catalog.find");
    expect(document.activeElement).toBe(textarea(container));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("creates a thread and sends the first message, then opens the thread", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/studio/threads")
        return Response.json({ threadId: "thread-new" }, { status: 201 });
      if (url.endsWith("/messages")) return Response.json(sendResultBody());
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await type(container, "Find the Opak listings");
    await act(async () => {
      buttonByText(container, "Send")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/studio/threads");
    expect(String(fetcher.mock.calls[1]?.[0])).toBe(
      "/api/studio/threads/thread-new/messages",
    );
    const body = JSON.parse(
      String(fetcher.mock.calls[1]?.[1]?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      text: "Find the Opak listings",
      locale: "en",
    });
    expect(navigation.push).toHaveBeenCalledWith("/studio/t/thread-new");
  });

  it("keeps the draft and retries the same client message id after a failed send", async () => {
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/studio/threads")
        return Response.json({ threadId: "thread-new" }, { status: 201 });
      attempts += 1;
      if (attempts === 1) return Response.json({}, { status: 503 });
      return Response.json(sendResultBody());
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await type(container, "keep this draft");
    await act(async () => {
      buttonByText(container, "Send")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textarea(container).value).toBe("keep this draft");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "temporarily unavailable",
    );
    const firstClientId = JSON.parse(
      String(fetcher.mock.calls[1]?.[1]?.body ?? "{}"),
    ).clientMessageId;

    await act(async () => {
      buttonByText(container, "Retry send")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The retry reused the created thread (no second POST /threads) and the
    // same client message id, so the server can replay instead of duplicating.
    expect(
      fetcher.mock.calls.filter(
        ([url]) => String(url) === "/api/studio/threads",
      ),
    ).toHaveLength(1);
    const secondClientId = JSON.parse(
      String(fetcher.mock.calls[2]?.[1]?.body ?? "{}"),
    ).clientMessageId;
    expect(secondClientId).toBe(firstClientId);
    expect(navigation.push).toHaveBeenCalledWith("/studio/t/thread-new");
  });

  it("keeps Send disabled for a viewer with the stated reason", () => {
    const html = render("en", { canCreateThread: false });

    expect(html).toContain(
      "Your role can read only; sending requires operator or higher.",
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Send<\/button>/);
  });

  it("renders the not-yet-available notice when the overview read failed", () => {
    const html = render("en", { overview: null });
    expect(html).toContain("The workspace overview could not be read");
  });

  it("renders zh-Hant copy for the zh-Hant locale", () => {
    const html = render("zh-Hant");

    expect(html).toContain("歡迎回來");
    expect(html).toContain("來自工作區記錄；不會呼叫 AI。");
    expect(html).toContain("AI 可能會出錯；重要數字請先核對。");
    expect(html).toContain("規劃中");
    expect(html).toContain("未能提供");
  });
});
