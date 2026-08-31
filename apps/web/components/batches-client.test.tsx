// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { BatchesClient } from "./batches-client.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function nativeSet(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("BatchesClient", () => {
  it("refetches the batch list after a successful create", async () => {
    let listCalls = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url === "/api/enrichment-batches") {
        return Promise.resolve(
          Response.json(
            { batchId: "batch_new", selected: 2, budgetUsd: 5, waveSize: 3 },
            { status: 201 },
          ),
        );
      }
      if (url === "/api/enrichment-batches") {
        listCalls += 1;
        const batches =
          listCalls === 1
            ? []
            : [
                {
                  id: "batch_new",
                  label: "zh names",
                  budgetUsd: 5,
                  waveSize: 3,
                  status: "running",
                  createdBy: "user_1",
                  createdAt: "2026-08-01T00:00:00.000Z",
                },
              ];
        return Promise.resolve(Response.json({ batches }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(BatchesClient));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Initial fetch returned no batches.
    expect(container.textContent).toContain("尚無批次紀錄");
    expect(listCalls).toBe(1);

    const inputs = container.querySelectorAll<HTMLInputElement>("input");
    const labelInput = inputs[0]!;
    const budgetInput = inputs[1]!;
    const form = container.querySelector("form")!;

    await act(async () => {
      nativeSet(labelInput, "zh names");
      nativeSet(budgetInput, "5");
    });

    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    // BatchList remounts (new key) and fetches again.
    await act(async () => {
      await Promise.resolve();
    });

    expect(listCalls).toBe(2);
    expect(container.textContent).toContain("zh names");

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});
