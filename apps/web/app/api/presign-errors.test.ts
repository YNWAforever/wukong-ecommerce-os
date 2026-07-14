import type { AssetStore } from "@wukong/assets";
import { describe, expect, it } from "vitest";

import { createPresignAssetHandler } from "./assets/presign/route.js";

describe("presign infrastructure errors", () => {
  it("returns typed 500 without leaking the storage failure", async () => {
    const store = {
      async createUpload() {
        throw new Error("https://secret-storage.example internal signing failure");
      },
    } as unknown as AssetStore;
    const handler = createPresignAssetHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "operator",
          } as const;
        },
      },
      getAssetStore: () => store,
      getDatabase: () => {
        throw new Error("unused");
      },
    });

    const response = await handler(
      new Request("http://localhost/api/assets/presign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileName: "supplier.pdf",
          mimeType: "application/pdf",
          size: 1200,
        }),
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "internal_error",
      message: "The request could not be completed.",
    });
  });
});
