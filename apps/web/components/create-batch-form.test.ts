// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { CreateBatchForm, submitCreateBatch } from "./create-batch-form.js";

const validInput = {
  label: "zh names",
  gap: "untranslatedName" as const,
  budgetUsd: 5,
  waveSize: 3,
};

describe("submitCreateBatch", () => {
  it("returns a network_error when the fetcher throws", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await submitCreateBatch(validInput, { fetcher });

    expect(result).toEqual({
      kind: "network_error",
      message: "Could not reach the server. Try again.",
    });
  });

  it("returns a success outcome with the real response fields", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { batchId: "batch_1", selected: 4, budgetUsd: 5, waveSize: 3 },
          { status: 201 },
        ),
      );

    const result = await submitCreateBatch(validInput, { fetcher });

    expect(result).toEqual({
      kind: "success",
      batchId: "batch_1",
      selected: 4,
      budgetUsd: 5,
      waveSize: 3,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it.each([
    ["invalid_budget", "A batch needs a budget greater than zero."],
    ["invalid_wave_size", "Wave size must be a whole number from 1 to 5."],
    [
      "empty_cohort",
      "No products match that gap, so there is nothing to enrich.",
    ],
    ["insufficient_role", "Operator access is required."],
  ])("maps API error code %s to its message", async (code, message) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ code, message: "server detail" }, { status: 400 }),
      );

    const result = await submitCreateBatch(validInput, { fetcher });

    expect(result).toEqual({ kind: "api_error", code, message });
  });
});

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

describe("CreateBatchForm", () => {
  it("calls onCreated after a successful submit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { batchId: "batch_1", selected: 4, budgetUsd: 5, waveSize: 3 },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const onCreated = vi.fn();

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(CreateBatchForm, { onCreated }));
    });

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

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/enrichment-batches",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string),
    ).toEqual({
      label: "zh names",
      gap: "untranslatedName",
      budgetUsd: 5,
      waveSize: 3,
    });

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders the error message via the intake-message paragraph after a failed submit", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { code: "empty_cohort", message: "server detail" },
          { status: 422 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const onCreated = vi.fn();

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(CreateBatchForm, { onCreated }));
    });

    const form = container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const message = container.querySelector(".intake-message");
    expect(message?.textContent).toBe(
      "No products match that gap, so there is nothing to enrich.",
    );
    expect(onCreated).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});
