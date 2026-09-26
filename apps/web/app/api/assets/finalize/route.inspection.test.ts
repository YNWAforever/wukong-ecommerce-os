import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
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

it("keeps finalized source bytes unchanged when the upload URL overwrites its key", async () => {
  const store = new MemoryAssetStore();
  const document = await PDFDocument.create();
  document.addPage([100, 100]);
  const original = new Uint8Array(await document.save());
  document.addPage([80, 80]);
  const overwritten = new Uint8Array(await document.save());
  const upload = await store.createUpload({
    workspaceId: "test",
    fileName: "source.pdf",
    mimeType: "application/pdf",
    size: original.byteLength,
  });
  await store.writeObject("test", upload.key, original, "application/pdf");
  let storedKey: string | null = null;
  let storedFileName: string | null = null;
  const handler = createFinalizeAssetHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId: "test",
        actorId: "test",
        role: "operator",
      }),
    },
    getAssetStore: () => store,
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repositories: Record<string, unknown>) => Promise<T>,
        ) {
          return work({
            sourceAssets: {
              async getByStorageKey() {
                return null;
              },
              async create(input: {
                storageKey: string;
                metadata: { fileName: string };
              }) {
                storedKey = input.storageKey;
                storedFileName = input.metadata.fileName;
                return { id: "asset_1" };
              },
            },
            audit: { async write() {} },
          });
        },
      }) as never,
  });
  const response = await handler(
    new Request("http://localhost/api/assets/finalize", {
      method: "POST",
      body: JSON.stringify({
        key: upload.key,
        mimeType: "application/pdf",
        size: original.byteLength,
        sha256: createHash("sha256").update(original).digest("hex"),
      }),
    }),
  );
  expect(response.status).toBe(201);
  if (!storedKey) throw new Error("Finalized asset storage key missing");
  expect(storedFileName).toBe("source.pdf");

  await store.writeObject("test", upload.key, overwritten, "application/pdf");
  expect(await store.readObject("test", storedKey)).toEqual(original);

  const conflictingReplay = await handler(
    new Request("http://localhost/api/assets/finalize", {
      method: "POST",
      body: JSON.stringify({
        key: upload.key,
        mimeType: "application/pdf",
        size: overwritten.byteLength,
        sha256: createHash("sha256").update(overwritten).digest("hex"),
      }),
    }),
  );
  expect(conflictingReplay.status).toBe(409);
  expect(await conflictingReplay.json()).toMatchObject({
    code: "asset_already_finalized",
  });
});
