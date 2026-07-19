import { describe, expect, it, vi } from "vitest";

import { createPresignAssetHandler } from "./route.js";

function requestFor(body: Record<string, unknown>) {
  return new Request("http://localhost/api/assets/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/assets/presign", () => {
  it("rejects a viewer before creating an upload", async () => {
    const createUpload = vi.fn();
    const handler = createPresignAssetHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "viewer",
          } as const;
        },
      },
      getAssetStore: () => ({ createUpload }) as never,
      getDatabase: () => {
        throw new Error("unused");
      },
    });

    const response = await handler(
      requestFor({
        fileName: "supplier.pdf",
        mimeType: "application/pdf",
        size: 1200,
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "insufficient_role",
      message: "Operator access is required.",
    });
    expect(createUpload).not.toHaveBeenCalled();
  });
});
