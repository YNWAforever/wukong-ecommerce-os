// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DraftDispatch } from "../lib/studio/types";
import { StudioDispatchCard } from "./studio-dispatch-card";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ASSET_A = "11111111-1111-4111-8111-111111111111";
const ASSET_B = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

function dispatch(overrides: Partial<DraftDispatch> = {}): DraftDispatch {
  return {
    kind: "listing_draft",
    assetIds: [ASSET_A, ASSET_B],
    note: "Synthetic operator note",
    ready: true,
    ...overrides,
  };
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(
  props: Partial<Parameters<typeof StudioDispatchCard>[0]> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <StudioDispatchCard
        locale="en"
        threadId={THREAD_ID}
        runId={RUN_ID}
        dispatch={dispatch()}
        canDispatch
        {...props}
      />,
    );
  });
  return container;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  ) as HTMLButtonElement | undefined;
}

function okDispatch(overrides: Record<string, unknown> = {}) {
  return {
    listingId: "55555555-5555-4555-8555-555555555555",
    runId: "66666666-6666-4666-8666-666666666666",
    queueState: "enqueued",
    replayed: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StudioDispatchCard", () => {
  it("shows the prepared asset count and note without dispatching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    expect(container.textContent).toContain("Create listing draft");
    expect(container.textContent).toContain("2 source asset(s)");
    expect(container.textContent).toContain("Synthetic operator note");
    expect(container.textContent).toContain("Review and confirm");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the operator to open and confirm before anything is created", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const container = await mount();

    await act(async () => {
      buttonByText(container, "Review and confirm")?.click();
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "Confirming creates a real listing draft",
    );
    // The confirmation panel repeats the asset count and note.
    expect(container.textContent).toContain("2 source asset(s)");

    await act(async () => {
      buttonByText(container, "Cancel")?.click();
    });
    expect(container.textContent).not.toContain(
      "Confirming creates a real listing draft",
    );
  });

  it("posts an explicit confirmed dispatch and reports the created listing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/studio/dispatch/listing-draft")
        return Response.json(okDispatch());
      if (url.includes("/api/listings/"))
        return Response.json({ state: "queued" });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await act(async () => {
      buttonByText(container, "Review and confirm")?.click();
    });
    await act(async () => {
      buttonByText(container, "Confirm create draft")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const post = fetcher.mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      threadId: THREAD_ID,
      runId: RUN_ID,
      assetIds: [ASSET_A, ASSET_B],
      note: "Synthetic operator note",
      skillKey: "listing.draft_from_sources",
      confirmed: true,
    });
    expect(container.textContent).toContain("Listing draft created.");
    expect(container.textContent).toContain(
      "Queued into the existing listing pipeline.",
    );
    expect(
      container.querySelector(
        'a[href="/listings/55555555-5555-4555-8555-555555555555"]',
      ),
    ).not.toBeNull();
  });

  it("never claims processing when the queue did not accept the job", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url === "/api/studio/dispatch/listing-draft")
          return Response.json(okDispatch({ runId: null, queueState: "queue_unavailable" }));
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const container = await mount();
    await act(async () => {
      buttonByText(container, "Review and confirm")?.click();
    });
    await act(async () => {
      buttonByText(container, "Confirm create draft")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Listing draft created.");
    expect(container.textContent).toContain(
      "The draft exists, but processing has not started",
    );
    expect(container.textContent).not.toContain(
      "Queued into the existing listing pipeline.",
    );
    expect(container.textContent).toContain(
      "No processing run is available yet.",
    );
  });

  it("polls the run while mounted and stops after a terminal state", async () => {
    let runReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/studio/dispatch/listing-draft")
        return Response.json(okDispatch());
      runReads += 1;
      return Response.json({ state: runReads === 1 ? "running" : "succeeded" });
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await act(async () => {
      buttonByText(container, "Review and confirm")?.click();
    });
    await act(async () => {
      buttonByText(container, "Confirm create draft")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Running");
    expect(runReads).toBe(1);

    // Advance one interval: a non-terminal run is polled again.
    await act(async () => {
      vi.advanceTimersByTime(4000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(runReads).toBe(2);
    expect(container.textContent).toContain("Succeeded");

    // Terminal state: no further polling on later ticks.
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(runReads).toBe(2);
  });

  it("stops polling on unmount", async () => {
    let runReads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/studio/dispatch/listing-draft")
        return Response.json(okDispatch());
      runReads += 1;
      return Response.json({ state: "running" });
    });
    vi.stubGlobal("fetch", fetcher);

    const container = await mount();
    await act(async () => {
      buttonByText(container, "Review and confirm")?.click();
    });
    await act(async () => {
      buttonByText(container, "Confirm create draft")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const before = runReads;

    const root = roots.at(-1)!;
    await act(async () => root.unmount());
    roots.pop();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(runReads).toBe(before);
  });

  it("disables the action with the role reason for a non-operator", async () => {
    const container = await mount({ canDispatch: false });
    const review = buttonByText(container, "Review and confirm");
    expect(review?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "An operator or higher role is required to create a draft.",
    );
  });

  it("disables the action when some source assets did not resolve", async () => {
    const container = await mount({
      dispatch: dispatch({ ready: false }),
    });
    const review = buttonByText(container, "Review and confirm");
    expect(review?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Some source assets could not be resolved, so no draft can be created.",
    );
  });

  it("shows an honest role error when the server refuses the dispatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () =>
        Response.json({ code: "insufficient_role" }, { status: 403 }),
      ),
    );

    const container = await mount();
    await act(async () => {
      buttonByText(container, "Review and confirm")?.click();
    });
    await act(async () => {
      buttonByText(container, "Confirm create draft")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "You do not have permission to create a draft.",
    );
    expect(container.textContent).not.toContain("Listing draft created.");
  });
});
