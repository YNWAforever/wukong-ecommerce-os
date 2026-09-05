// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  AdvanceBatchButton,
  submitAdvanceBatch,
} from "./advance-batch-button.js";

describe("submitAdvanceBatch", () => {
  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    expect(result).toEqual({
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    });
  });

  it("returns a success outcome with the real response fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          batchId: "batch_1",
          status: "running",
          enqueued: 2,
          spentUsd: 1,
          budgetUsd: 5,
        },
        { status: 200 },
      ),
    );

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    expect(result).toEqual({
      kind: "success",
      batchId: "batch_1",
      status: "running",
      enqueued: 2,
      spentUsd: 1,
      budgetUsd: 5,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches/batch_1/advance",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    [403, "insufficient_role", "Operator access is required."],
    [404, "batch_not_found", "This batch no longer exists."],
  ])("maps a %d %s to its message", async (status, code, message) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code, message: "server detail" }, { status }),
      );

    const result = await submitAdvanceBatch("batch_1", { fetcher });

    expect(result).toEqual({ kind: "api_error", code, message });
  });
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("AdvanceBatchButton", () => {
  it("calls onAdvanced with the success outcome after a successful click", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          batchId: "batch_1",
          status: "running",
          enqueued: 2,
          spentUsd: 1,
          budgetUsd: 5,
        },
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const onAdvanced = vi.fn();

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(AdvanceBatchButton, { batchId: "batch_1", onAdvanced }),
      );
    });

    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAdvanced).toHaveBeenCalledWith({
      kind: "success",
      batchId: "batch_1",
      status: "running",
      enqueued: 2,
      spentUsd: 1,
      budgetUsd: 5,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches/batch_1/advance",
      expect.objectContaining({ method: "POST" }),
    );

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders the error message via the intake-message paragraph after a failed click", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "batch_not_found", message: "server detail" },
          { status: 404 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const onAdvanced = vi.fn();

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(AdvanceBatchButton, { batchId: "batch_1", onAdvanced }),
      );
    });

    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const message = container.querySelector(".intake-message");
    expect(message?.textContent).toBe("This batch no longer exists.");
    expect(onAdvanced).toHaveBeenCalledWith({
      kind: "api_error",
      code: "batch_not_found",
      message: "This batch no longer exists.",
    });

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("disables the button while the request is in flight and re-enables it afterward", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(AdvanceBatchButton, { batchId: "batch_1" }));
    });

    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(button.disabled).toBe(true);

    await act(async () => {
      resolveFetch(
        Response.json(
          {
            batchId: "batch_1",
            status: "running",
            enqueued: 2,
            spentUsd: 1,
            budgetUsd: 5,
          },
          { status: 200 },
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button.disabled).toBe(false);

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});

// Chromium rejects a native fetch called with the dependency object as receiver.
it("calls browser fetch without a dependency-object receiver", async () => {
  const fetcher = async function (this: unknown) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return Response.json({
      batchId: "batch_1",
      selected: 2,
      budgetUsd: 1,
      waveSize: 2,
      status: "running",
      enqueued: 2,
      spentUsd: 0,
    });
  } as typeof fetch;
  expect((await submitAdvanceBatch("batch_1", { fetcher })).kind).toBe(
    "success",
  );
});
