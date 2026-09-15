import { createHash } from "node:crypto";
import { MemoryAssetStore } from "@wukong/assets";
import { describe, it, expect, vi } from "vitest";
import { createFinalizeAssetHandler } from "./route";
describe("finalization byte boundary", () => {
  it("rejects spoofed photo bytes before persisting an asset", async () => {
    const store = new MemoryAssetStore();
    const bytes = Buffer.from("not a photo");
    const upload = await store.createUpload({
      workspaceId: "test",
      fileName: "photo.jpg",
      mimeType: "image/jpeg",
      size: bytes.length,
    });
    await store.writeObject("test", upload.key, bytes, "image/jpeg");
    const getDatabase = vi.fn();
    const handler = createFinalizeAssetHandler({
      sessionContext: {
        resolve: async () => ({
          workspaceId: "test",
          actorId: "test",
          role: "operator",
        }),
      },
      getAssetStore: () => store,
      getDatabase,
    });
    const response = await handler(
      new Request("http://localhost/api/assets/finalize", {
        method: "POST",
        body: JSON.stringify({
          key: upload.key,
          mimeType: "image/jpeg",
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "invalid_image" });
    expect(getDatabase).not.toHaveBeenCalled();
  });
});
