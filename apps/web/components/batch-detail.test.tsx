// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { BatchDetail } from "./batch-detail.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(fetcher: ReturnType<typeof vi.fn>, batchId = "batch_1") {
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(BatchDetail, { batchId }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
}

describe("BatchDetail", () => {
  it("renders the batch's status and item counts after fetching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        batch: {
          id: "batch_1",
          label: "zh names",
          budgetUsd: 5,
          waveSize: 3,
          status: "running",
          createdBy: "user_1",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        counts: { pending: 1, queued: 0, succeeded: 2, failed: 0, skipped: 0 },
      }),
    );

    const { container, root } = await mount(fetcher, "batch_1");

    expect(container.textContent).toContain("zh names");
    expect(container.textContent).toContain("succeeded");
    expect(fetcher).toHaveBeenCalledWith("/api/enrichment-batches/batch_1");

    await unmount(root);
  });

  it("renders an error message instead of crashing when the response is not ok", async () => {
    // Same regression class as batch-list.test.tsx: a viewer-role user's GET
    // 403s with a well-formed {code, message} body. Without a response.ok
    // check, the old pattern would call setData(body) with an errorful body
    // shaped nothing like BatchDetailData and then crash rendering
    // data.batch.label / data.counts.pending.
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          code: "insufficient_role",
          message: "server detail",
        },
        { status: 403 },
      ),
    );

    const { container, root } = await mount(fetcher);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("Operator access is required.");

    await unmount(root);
  });

  it("renders an error message instead of hanging on a network failure", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const { container, root } = await mount(fetcher);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("Could not reach the server. Try again.");
    expect(container.textContent).not.toContain("載入中");

    await unmount(root);
  });
});
