import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn() }));
vi.mock("./cloudflare-runtime.js", () => ({
  createProductShotRuntime: mocks.create,
}));
vi.mock("./product-shot-pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./product-shot-pipeline.js")>()),
  runProductShot: mocks.run,
}));
import { consumeProductShotMessage } from "./product-shot-consumer.js";
import {
  ProductShotBusyError,
  ProductShotBudgetError,
} from "./product-shot-pipeline.js";
const job = {
  kind: "product_shot",
  workspaceId: "ws",
  draftId: "10000000-0000-4000-8000-000000000001",
  attemptId: "10000000-0000-4000-8000-000000000002",
};
describe("product shot consumer", () => {
  it("acks malformed envelopes without opening runtime", async () => {
    mocks.create.mockClear();
    expect(
      await consumeProductShotMessage(
        { ...job, storageKey: "private" },
        {} as never,
      ),
    ).toBe("ack");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("preserves bounded lease and budget delays while always closing runtime", async () => {
    for (const error of [
      new ProductShotBusyError(121),
      new ProductShotBudgetError(43200),
    ]) {
      const close = vi.fn(async () => {});
      mocks.create.mockReturnValue({ dependencies: {}, close });
      mocks.run.mockRejectedValueOnce(error);
      expect(await consumeProductShotMessage(job, {} as never)).toEqual({
        retryAfterSeconds: error.retryAfterSeconds,
      });
      expect(close).toHaveBeenCalledOnce();
    }
  });
});
