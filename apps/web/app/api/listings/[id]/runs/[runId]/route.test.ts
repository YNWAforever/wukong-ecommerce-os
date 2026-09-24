import { expect, it, vi } from "vitest";
import { createListingRunHandler } from "./route";
it("requires authentication before reading persisted wine progress", async () => {
  const database = vi.fn();
  const handler = createListingRunHandler({
    sessionContext: { resolve: async () => null },
    getDatabase: database,
  });
  expect(
    (
      await handler(new Request("http://localhost/run"), {
        params: Promise.resolve({
          id: "00000000-0000-4000-8000-000000000001",
          runId: "00000000-0000-4000-8000-000000000002",
        }),
      })
    ).status,
  ).toBe(401);
  expect(database).not.toHaveBeenCalled();
});
