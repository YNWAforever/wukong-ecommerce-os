// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { BatchList } from "./batch-list.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(BatchList));
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

describe("BatchList", () => {
  it("renders each batch's label and status after fetching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        batches: [
          {
            id: "batch_1",
            label: "zh names",
            budgetUsd: 5,
            waveSize: 3,
            status: "running",
            createdBy: "user_1",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const { container, root } = await mount(fetcher);

    expect(container.textContent).toContain("zh names");
    expect(fetcher).toHaveBeenCalledWith("/api/enrichment-batches");

    await unmount(root);
  });

  it("links each batch to /batches/{id}", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        batches: [
          {
            id: "batch_42",
            label: "seo titles",
            budgetUsd: 12.5,
            waveSize: 2,
            status: "completed",
            createdBy: "user_1",
            createdAt: "2026-08-02T00:00:00.000Z",
          },
        ],
      }),
    );

    const { container, root } = await mount(fetcher);

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/batches/batch_42");
    expect(link!.textContent).toBe("seo titles");

    await unmount(root);
  });

  it("renders an empty-state message when there are no batches", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ batches: [] }));

    const { container, root } = await mount(fetcher);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("尚無批次紀錄");

    await unmount(root);
  });
});
