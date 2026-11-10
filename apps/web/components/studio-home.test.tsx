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

  it("renders every role template with an availability derived from the registry", () => {
    const html = render();

    const pilot = STUDIO_TEMPLATES.filter(
      (template) => template.availability === "pilot",
    );
    const planned = STUDIO_TEMPLATES.filter(
      (template) => template.availability === "planned",
    );
    const unavailable = STUDIO_TEMPLATES.filter(
      (template) => template.availability === "unavailable",
    );
    expect((html.match(/<h3/g) ?? []).length).toBe(STUDIO_TEMPLATES.length);
    expect((html.match(/>Pilot</g) ?? []).length).toBe(pilot.length);
    expect((html.match(/>Planned</g) ?? []).length).toBe(planned.length);
    expect((html.match(/>Unavailable</g) ?? []).length).toBe(
      unavailable.length,
    );
    // Every pilot card is interactive and every non-pilot card is not.
    expect(pilot.every((template) => template.starterKey !== undefined)).toBe(
      true,
    );
    expect((html.match(/>Fill the composer</g) ?? []).length).toBe(
      pilot.length,
    );
  });

  it("derives availability from the reviewed skill registry and keeps blocked skills unavailable", () => {
    expect(
      STUDIO_TEMPLATES.filter(
        (template) => template.availability === "pilot",
      ).map((template) => template.id),
    ).toEqual([
      "catalog.find",
      "catalog.gap_review",
      "listing.draft_from_sources",
      "product_shot.prepare",
      "listing.copy_proposal",
      "category.map_proposal",
      "merchant.audit",
    ]);
    expect(
      STUDIO_TEMPLATES.filter(
        (template) => template.availability === "planned",
      ).map((template) => template.id),
    ).toEqual(["supplier.intel_proposal"]);
    expect(
      STUDIO_TEMPLATES.filter(
        (template) => template.availability === "unavailable",
      ).map((template) => template.id),
    ).toEqual(["customer.reply_draft", "logistics.followup"]);
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

  it("fills from a newly pilot template with its own starter and selected skill", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    const card = Array.from(container.querySelectorAll("li")).find((item) =>
      item.textContent?.includes("Image preparation"),
    );
    const fill = Array.from(card?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Fill the composer",
    );
    await act(async () => fill?.click());

    expect(textarea(container).value).toBe("Prepare product images for: ");
    expect(container.textContent).toContain("Selected skill");
    expect(container.textContent).toContain("product_shot.prepare");
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

  function fileInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
    return input;
  }

  async function chooseFiles(container: HTMLElement, files: File[]) {
    const input = fileInput(container);
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function settle() {
    for (let index = 0; index < 30; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function assetTransport(sendResponse?: () => Response) {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/api/assets/presign")
          return Response.json(
            {
              key: "ws/ws_test/sources/k/photo.png",
              uploadUrl: "https://storage.example.test/put",
              expiresAt: "2026-11-09T04:40:00.000Z",
            },
            { status: 201 },
          );
        if (url === "https://storage.example.test/put")
          return new Response(null, { status: 200 });
        if (url === "/api/assets/finalize")
          return Response.json({ assetId: "asset_1" }, { status: 201 });
        if (url === "/api/studio/threads")
          return Response.json({ threadId: "thread-new" }, { status: 201 });
        if (url.endsWith("/messages"))
          return sendResponse
            ? sendResponse()
            : Response.json(sendResultBody());
        throw new Error(
          `unexpected fetch ${url} (${String(init?.method ?? "GET")})`,
        );
      });
    return fetcher;
  }

  it("uploads an attachment, sends its finalized asset id and clears it", async () => {
    const fetcher = assetTransport();
    vi.stubGlobal("fetch", fetcher);
    const container = await mount();

    await chooseFiles(container, [
      new File([new Uint8Array(5)], "photo.png", { type: "image/png" }),
    ]);
    await settle();
    expect(container.textContent).toContain("Uploaded");

    await type(container, "Find the Opak listings");
    await act(async () => {
      buttonByText(container, "Send")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const presignCall = fetcher.mock.calls.find(
      ([url]) => String(url) === "/api/assets/presign",
    );
    expect(JSON.parse(String(presignCall?.[1]?.body))).toEqual({
      fileName: "photo.png",
      mimeType: "image/png",
      size: 5,
    });
    const sendCall = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/messages"),
    );
    expect(JSON.parse(String(sendCall?.[1]?.body))).toMatchObject({
      attachmentAssetIds: ["asset_1"],
    });
    expect(container.textContent).not.toContain("Uploaded");
    expect(navigation.push).toHaveBeenCalledWith("/studio/t/thread-new");
  });

  it("keeps uploaded ids and the draft after a failed send and reuses them on retry", async () => {
    let attempts = 0;
    const fetcher = assetTransport(() => {
      attempts += 1;
      if (attempts === 1) return Response.json({}, { status: 503 });
      return Response.json(sendResultBody());
    });
    vi.stubGlobal("fetch", fetcher);
    const container = await mount();

    await chooseFiles(container, [
      new File([new Uint8Array(5)], "photo.png", { type: "image/png" }),
    ]);
    await settle();
    await type(container, "keep this draft");
    await act(async () => {
      buttonByText(container, "Send")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(textarea(container).value).toBe("keep this draft");
    expect(container.textContent).toContain("Uploaded");

    await act(async () => {
      buttonByText(container, "Retry send")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const sendBodies = fetcher.mock.calls
      .filter(([url]) => String(url).endsWith("/messages"))
      .map(
        ([, init]) =>
          JSON.parse(String(init?.body)) as {
            attachmentAssetIds?: string[];
          },
      );
    expect(sendBodies).toHaveLength(2);
    expect(sendBodies[0]?.attachmentAssetIds).toEqual(["asset_1"]);
    expect(sendBodies[1]?.attachmentAssetIds).toEqual(["asset_1"]);
    expect(
      fetcher.mock.calls.filter(
        ([url]) => String(url) === "/api/assets/presign",
      ),
    ).toHaveLength(1);
  });

  it("caps a selection at eight attachments and says so", async () => {
    const fetcher = assetTransport();
    vi.stubGlobal("fetch", fetcher);
    const container = await mount();
    await chooseFiles(
      container,
      Array.from(
        { length: 9 },
        (_, index) =>
          new File([new Uint8Array(2)], `photo-${index}.png`, {
            type: "image/png",
          }),
      ),
    );
    await settle();

    expect(container.textContent).toContain("Up to 8 files can be attached.");
    expect(container.querySelectorAll('[data-state="uploaded"]').length).toBe(
      8,
    );
    expect(container.textContent).not.toContain("photo-8.png");
    expect(
      fetcher.mock.calls.filter(
        ([url]) => String(url) === "/api/assets/presign",
      ),
    ).toHaveLength(8);
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
