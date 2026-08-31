import { describe, expect, it, vi } from "vitest";

import { submitCreateBatch } from "./create-batch-form.js";

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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
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
    ["empty_cohort", "No products match that gap, so there is nothing to enrich."],
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
