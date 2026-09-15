// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BatchControls } from "./batch-controls";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("replays the same cancellation command after an uncertain network response", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(Error("network unavailable"))
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ controlRevision: 5 }),
    });
  vi.stubGlobal("fetch", fetcher);
  const onChanged = vi.fn();
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(BatchControls, {
          batchId: "batch",
          revision: 4,
          status: "running",
          items: [],
          onChanged,
        }),
      ),
    );
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel unfinished work",
    )!;
    await act(async () => cancel.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "network unavailable",
    );
    await act(async () => cancel.click());
    expect(onChanged).toHaveBeenCalledOnce();
    const first = JSON.parse(fetcher.mock.calls[0]![1].body),
      second = JSON.parse(fetcher.mock.calls[1]![1].body);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      action: "cancel",
      expectedControlRevision: 4,
      idempotencyKey: expect.any(String),
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
it("offers retry only for terminal current items with bound runs", async () => {
  const container = document.createElement("div"),
    root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(BatchControls, {
          batchId: "batch",
          revision: 4,
          status: "running",
          items: [
            {
              id: "old",
              listingId: "listing1",
              pipelineRunId: "run1",
              outcome: "failed",
              status: "failed",
              isCurrent: false,
              retryOfItemId: null,
            },
            {
              id: "new",
              listingId: "listing1",
              pipelineRunId: "run2",
              outcome: "needs_input",
              status: "skipped",
              isCurrent: true,
              retryOfItemId: "old",
            },
            {
              id: "queued",
              listingId: "listing2",
              pipelineRunId: "run3",
              outcome: null,
              status: "queued",
              isCurrent: true,
              retryOfItemId: null,
            },
          ],
          onChanged: () => {},
        }),
      ),
    );
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      1,
    );
  } finally {
    await act(async () => root.unmount());
  }
});
