import { expect, it, vi } from "vitest";
import { createWineQueueRuntime } from "./wine-queue-runtime.js";
it("constructs copy runtime without Tavily or eager storage/research setup", () => {
  const database = { forWorkspace: vi.fn(), close: vi.fn() } as never;
  const assetStoreFactory = vi.fn(() => {
    throw Error("must be lazy");
  });
  expect(() =>
    createWineQueueRuntime({ OPENCODE_GO_API_KEY: "synthetic" } as never, {
      databaseFactory: () => database,
      assetStoreFactory,
    }),
  ).not.toThrow();
  expect(assetStoreFactory).not.toHaveBeenCalled();
});
