import { describe, expect, it } from "vitest";

import { createAssetKey, MemoryAssetStore } from "./asset-store.js";

describe("MemoryAssetStore", () => {
  it("prefixes every key with the authorized workspace", async () => {
    const store = new MemoryAssetStore();
    const upload = await store.createUpload({
      workspaceId: "ws_opak",
      fileName: "supplier.pdf",
      mimeType: "application/pdf",
      size: 1024,
    });

    expect(upload.key).toMatch(
      /^ws\/ws_opak\/sources\/[0-9a-f-]+\/supplier\.pdf$/,
    );
  });

  it.each([
    ["path traversal", "../secret.pdf"],
    ["Windows traversal", "..\\secret.pdf"],
    ["nested path", "folder/secret.pdf"],
  ])("rejects %s in file names", async (_label, fileName) => {
    const store = new MemoryAssetStore();

    await expect(
      store.createUpload({
        workspaceId: "ws_opak",
        fileName,
        mimeType: "application/pdf",
        size: 1,
      }),
    ).rejects.toThrow(/file name/i);
  });

  it("rejects unsupported MIME types and invalid sizes", async () => {
    const store = new MemoryAssetStore();

    await expect(
      store.createUpload({
        workspaceId: "ws_opak",
        fileName: "payload.txt",
        mimeType: "text/plain" as "application/pdf",
        size: 1,
      }),
    ).rejects.toThrow(/mime/i);
    await expect(
      store.createUpload({
        workspaceId: "ws_opak",
        fileName: "empty.pdf",
        mimeType: "application/pdf",
        size: 0,
      }),
    ).rejects.toThrow(/20 MB/i);
  });

  it("refuses cross-workspace reads and object inspection", async () => {
    const store = new MemoryAssetStore();
    const upload = await store.createUpload({
      workspaceId: "ws_other",
      fileName: "supplier.pdf",
      mimeType: "application/pdf",
      size: 12,
    });

    await expect(store.createReadUrl("ws_opak", upload.key)).rejects.toThrow(
      /workspace/i,
    );
    await expect(store.head("ws_opak", upload.key)).rejects.toThrow(
      /workspace/i,
    );
  });
});

describe("MemoryAssetStore.writeObject", () => {
  it("stores metadata derived from the written bytes and makes it visible to head/exists", async () => {
    const store = new MemoryAssetStore();
    const body = new TextEncoder().encode("fake-png-bytes");
    const key = createAssetKey({
      workspaceId: "ws_opak",
      fileName: "cutout.png",
      mimeType: "image/png",
      size: body.byteLength,
    });

    const result = await store.writeObject("ws_opak", key, body, "image/png");

    expect(result).toEqual({ size: body.byteLength, mimeType: "image/png" });
    await expect(store.head("ws_opak", key)).resolves.toEqual({
      size: body.byteLength,
      mimeType: "image/png",
    });
    await expect(store.exists("ws_opak", key)).resolves.toBe(true);
  });

  it("rejects a key that does not belong to the workspace", async () => {
    const store = new MemoryAssetStore();
    await expect(
      store.writeObject(
        "ws_opak",
        "ws/other-workspace/sources/x/file.png",
        new Uint8Array(),
        "image/png",
      ),
    ).rejects.toThrow("Asset key does not belong to workspace");
  });
});
