// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  StudioMessageResponse,
  StudioThreadResponse,
} from "../lib/studio/contracts";
import type { StudioTurnReply } from "../lib/studio/types";
import { StudioThreadView } from "./studio-thread-view";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const thread: StudioThreadResponse = {
  threadId: "thread-1",
  title: "Synthetic conversation",
  skillKey: null,
  visibility: "workspace",
  status: "open",
  createdBy: "actor-1",
  lastMessageAt: "2026-11-08T00:00:00.000Z",
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
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
    checks: [
      {
        key: "studio.check.listing_status",
        values: {
          listingId: "listing-1",
          status: "approved",
          activeVersion: "present",
        },
        state: "ok",
      },
    ],
    coverage: { listing: "present" },
  },
  outputs: [],
  dispatch: null,
  analysis: null,
  traceSummary: { stepCount: 1 },
  limitations: [],
  followUps: [],
};

const operatorMessage: StudioMessageResponse = {
  messageId: "message-operator",
  sequence: 1,
  role: "operator",
  content: { text: "Find listing listing-1", locale: "en" },
  clientMessageId: "client-1",
  runId: null,
  createdBy: "actor-1",
  createdAt: "2026-11-08T00:00:00.000Z",
};

const assistantMessage: StudioMessageResponse = {
  messageId: "message-assistant",
  sequence: 2,
  role: "assistant",
  content: reply as unknown as Record<string, unknown>,
  clientMessageId: null,
  runId: "run-1",
  createdBy: "studio",
  createdAt: "2026-11-08T00:00:00.000Z",
};

const runEvents = {
  events: [
    {
      eventId: "event-1",
      sequence: 1,
      kind: "tool",
      toolId: "catalog.search",
      state: "done",
      payload: {
        key: "studio.trace.tool.done",
        values: { tool: "catalog.search", durationMs: 5 },
      },
      durationMs: 5,
      createdAt: "2026-11-08T00:00:00.000Z",
    },
  ],
};

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(
  props: Partial<Parameters<typeof StudioThreadView>[0]> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <StudioThreadView
        locale="en"
        thread={thread}
        messages={[]}
        aiEnabled={false}
        canSend
        canSignOff={false}
        {...props}
      />,
    );
  });
  return container;
}

async function type(container: HTMLElement, value: string) {
  const input = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Send",
  );
  if (!button) throw new Error("Send button not found");
  return button as HTMLButtonElement;
}

function sendSuccess(body: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    messageId: "message-new-assistant",
    runId: "run-new",
    reply,
    trace: [
      {
        kind: "tool",
        toolId: "catalog.search",
        state: "done",
        durationMs: null,
        detail: {
          key: "studio.trace.tool.done",
          values: { tool: "catalog.search", durationMs: 5 },
        },
      },
    ],
    replayed: false,
    ...body,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StudioThreadView", () => {
  it("renders server messages, the thread header and the latest evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(runEvents)),
    );
    const container = await mount({
      messages: [operatorMessage, assistantMessage],
    });

    expect(container.textContent).toContain("Synthetic conversation");
    expect(container.textContent).toContain("Find listing listing-1");
    expect(container.textContent).toContain("From your records");
    expect(container.textContent).toContain(
      "Listing listing-1: status approved",
    );
    expect(
      container.querySelectorAll('article[data-role="assistant"]'),
    ).toHaveLength(1);
  });

  it("tolerates invalid persisted assistant content with an honest notice", async () => {
    const container = await mount({
      messages: [
        {
          ...assistantMessage,
          content: { status: "answered", raw: "<b>x</b>" },
        },
      ],
    });

    expect(container.textContent).toContain(
      "This reply could not be displayed; nothing is invented.",
    );
    expect(container.innerHTML).not.toContain("<b>x</b>");
  });

  it("sends a message, appends the persisted turn, clears the draft and shows the trace", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/messages")) return Response.json(sendSuccess());
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await type(container, "Find the Opak listings");
    expect(sendButton(container).disabled).toBe(false);

    await act(async () => {
      sendButton(container).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const body = JSON.parse(
      String(fetcher.mock.calls[0]?.[1]?.body ?? "{}"),
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      text: "Find the Opak listings",
      locale: "en",
    });
    expect(typeof body.clientMessageId).toBe("string");

    expect(container.textContent).toContain("Find the Opak listings");
    expect(
      container.querySelectorAll('article[data-role="assistant"]'),
    ).toHaveLength(1);
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(container.textContent).toContain("catalog.search");
  });

  it("uploads an attachment and includes its finalized id in the send body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
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
        return Response.json({ assetId: "asset-1" }, { status: 201 });
      if (url.endsWith("/messages")) return Response.json(sendSuccess());
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [
        new File([new Uint8Array(4)], "photo.png", { type: "image/png" }),
      ],
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    for (let index = 0; index < 30; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(container.textContent).toContain("Uploaded");

    await type(container, "Find the Opak listings");
    await act(async () => {
      sendButton(container).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const sendCall = fetcher.mock.calls.find(([url]) =>
      String(url).endsWith("/messages"),
    );
    expect(JSON.parse(String(sendCall?.[1]?.body))).toMatchObject({
      attachmentAssetIds: ["asset-1"],
    });
    expect(container.textContent).not.toContain("Uploaded");
  });

  it("prevents a duplicate send while the first turn is in flight", async () => {
    let resolveSend: (value: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await type(container, "one turn only");

    // Two synchronous Enters: React has not re-rendered the disabled button
    // yet, so this exercises the hook's own synchronous in-flight guard.
    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend(Response.json(sendSuccess()));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it("keeps the draft, surfaces localized copy and retries with the same client message id", async () => {
    let attempts = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) return Response.json({}, { status: 503 });
      return Response.json(sendSuccess());
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await type(container, "retry this exact draft");
    await act(async () => {
      sendButton(container).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("temporarily unavailable");
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).value,
    ).toBe("retry this exact draft");

    const firstClientId = JSON.parse(
      String(fetcher.mock.calls[0]?.[1]?.body ?? "{}"),
    ).clientMessageId;

    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry send",
    ) as HTMLButtonElement;
    await act(async () => {
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const secondClientId = JSON.parse(
      String(fetcher.mock.calls[1]?.[1]?.body ?? "{}"),
    ).clientMessageId;
    expect(secondClientId).toBe(firstClientId);
    expect(
      container.querySelectorAll('article[data-role="assistant"]'),
    ).toHaveLength(1);
  });

  it("shows the replay notice when the server replayed a previous turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json(sendSuccess({ replayed: true })),
        ),
    );

    const container = await mount();
    await type(container, "replayed message");
    await act(async () => {
      sendButton(container).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "This message was already processed; the saved reply is shown.",
    );
  });

  it("loads a persisted trace on demand from the run endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/runs/run-1")) return Response.json(runEvents);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount({ messages: [assistantMessage] });
    const load = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Load execution trace",
    ) as HTMLButtonElement;
    expect(load).not.toBeUndefined();

    await act(async () => {
      load.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/runs/run-1");
    expect(container.textContent).toContain("Read catalog.search (5 ms).");
  });

  it("renders an output card for a reply that produced an artifact", async () => {
    const outputReply = {
      ...reply,
      outputs: [{ outputId: "output-1", revision: 1 }],
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/studio/outputs/output-1") {
        return Response.json({
          output: {
            outputId: "output-1",
            kind: "copy_proposal",
            title: "Synthetic proposal artifact",
            status: "draft",
            currentVersion: 1,
            threadId: "thread-1",
            createdAt: "2026-11-08T00:00:00.000Z",
            updatedAt: "2026-11-08T00:00:00.000Z",
          },
          versions: [
            {
              revision: 1,
              payload: {
                listingId: "listing-1",
                activeVersionId: "version-1",
                activeVersionSequence: 7,
                fields: [
                  {
                    field: "title.en",
                    current: "Synthetic old title",
                    proposed: "Synthetic proposed title",
                    evidenceRefs: ["listing:listing-1:v7"],
                  },
                ],
                limitations: [],
                asOf: "2026-11-08T00:00:00.000Z",
              },
              contentDigest: "a".repeat(64),
              asOf: "2026-11-08T00:00:00.000Z",
              scope: {},
              createdBy: "studio",
              createdAt: "2026-11-08T00:00:00.000Z",
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount({
      messages: [
        {
          ...assistantMessage,
          content: outputReply as unknown as Record<string, unknown>,
        },
      ],
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Synthetic proposal artifact");
    expect(container.textContent).toContain("Synthetic proposed title");
    expect(
      container.querySelector('[data-output-id="output-1"]'),
    ).not.toBeNull();
  });

  it("keeps Send disabled for a viewer with the stated reason", async () => {
    const container = await mount({ canSend: false });

    expect(sendButton(container).disabled).toBe(true);
    expect(container.textContent).toContain(
      "Your role can read only; sending requires operator or higher.",
    );
  });
});

describe("StudioThreadView share control", () => {
  function shareButton(container: HTMLElement): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Copy link to conversation",
    );
    if (!button) throw new Error("share button not found");
    return button as HTMLButtonElement;
  }

  function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  it("copies the thread link and reports real success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const container = await mount();

    await act(async () => {
      shareButton(container).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const copied = String(writeText.mock.calls[0]?.[0] ?? "");
    expect(copied.endsWith("/studio/t/thread-1")).toBe(true);
    expect(container.textContent).toContain("Link copied to the clipboard.");
    expect(container.textContent).toContain(
      "Shares the current address only; nothing is published or made more visible.",
    );
  });

  it("reports a clipboard refusal honestly instead of claiming a share", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubClipboard(writeText);
    const container = await mount();

    await act(async () => {
      shareButton(container).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      "Could not copy the link; copy the address manually.",
    );
    expect(container.textContent).not.toContain(
      "Link copied to the clipboard.",
    );
  });

  it("warns that a private thread link is limited to the creator and admins", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    const container = await mount({
      thread: { ...thread, visibility: "private" },
    });
    expect(container.textContent).toContain(
      "This conversation is private: only you and admins can open this link.",
    );
  });

  it("does not show the private warning for a workspace-visible thread", async () => {
    const container = await mount();
    expect(container.textContent).not.toContain("This conversation is private");
  });
});
