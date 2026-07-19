import { describe, expect, it } from "vitest";

import { createListingHandler } from "./listings/route.js";

const sessionContext = {
  async resolve() {
    return {
      workspaceId: "ws_opak",
      actorId: "user_1",
      role: "operator",
    } as const;
  },
};

describe("listing asset ID validation", () => {
  it("returns typed 400 for a malformed asset UUID without opening a transaction", async () => {
    let databaseCalls = 0;
    const handler = createListingHandler({
      sessionContext,
      publisher: {
        async enqueue() {
          return { id: "job_test" };
        },
      },
      getAssetStore: () => {
        throw new Error("unused");
      },
      getDatabase: () => {
        databaseCalls += 1;
        throw new Error("database must remain lazy");
      },
    });

    const response = await handler(
      new Request("http://localhost/api/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceAssetIds: ["asset_1"], note: "" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "invalid_request",
      message: "Request body is invalid.",
    });
    expect(databaseCalls).toBe(0);
  });
});
