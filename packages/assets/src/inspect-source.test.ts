import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, it, expect } from "vitest";
import { MemoryAssetStore } from "./asset-store.js";
import { inspectUploadedSource } from "./inspect-source.js";
async function setup(bytes: Uint8Array, mimeType = "image/jpeg") {
  const store = new MemoryAssetStore();
  const upload = await store.createUpload({
    workspaceId: "inspect",
    fileName: "photo.jpg",
    mimeType: mimeType as never,
    size: bytes.length,
  });
  await store.writeObject("inspect", upload.key, bytes, mimeType);
  return {
    store,
    key: upload.key,
    expected: {
      mimeType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
describe("source inspection", () => {
  it("retains original bytes and creates an oriented metadata-free model source", async () => {
    const bytes = await sharp({
      create: { width: 20, height: 10, channels: 3, background: "red" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { store, key, expected } = await setup(bytes);
    const inspected = await inspectUploadedSource(
      store,
      "inspect",
      key,
      expected,
    );
    expect(await store.readObject("inspect", key)).toEqual(
      new Uint8Array(bytes),
    );
    expect(inspected).toMatchObject({
      hashVerified: true,
      width: 10,
      height: 20,
      metadataStripped: true,
    });
    const decoded = await sharp(
      await store.readObject("inspect", inspected.normalizedStorageKey!),
    ).metadata();
    expect(decoded.exif).toBeUndefined();
    expect(decoded.orientation).toBeUndefined();
    expect(
      await inspectUploadedSource(store, "inspect", key, expected),
    ).toEqual(inspected);

    expect(inspected.verifiedStorageKey).not.toBe(key);
    const verifiedDirectory = inspected.verifiedStorageKey.slice(
      0,
      inspected.verifiedStorageKey.lastIndexOf("/") + 1,
    );
    expect(inspected.normalizedStorageKey.startsWith(verifiedDirectory)).toBe(
      true,
    );
    const modelBytes = await store.readObject(
      "inspect",
      inspected.normalizedStorageKey,
    );
    const replacement = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "blue" },
    })
      .jpeg()
      .toBuffer();
    await store.writeObject("inspect", key, replacement, "image/jpeg");
    expect(
      await store.readObject("inspect", inspected.verifiedStorageKey),
    ).toEqual(new Uint8Array(bytes));
    expect(
      await store.readObject("inspect", inspected.normalizedStorageKey),
    ).toEqual(modelBytes);
    await expect(
      inspectUploadedSource(store, "inspect", key, {
        mimeType: "image/jpeg",
        size: replacement.byteLength,
        sha256: createHash("sha256").update(replacement).digest("hex"),
      }),
    ).rejects.toMatchObject({ code: "asset_already_finalized" });
  });
  it("rejects spoofed MIME, corrupt pixels and a changed content digest", async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "black" },
    })
      .png()
      .toBuffer();
    const f = await setup(png);
    await expect(
      inspectUploadedSource(f.store, "inspect", f.key, f.expected),
    ).rejects.toMatchObject({ code: "invalid_image" });
    const bad = await setup(Buffer.from("not an image"));
    await expect(
      inspectUploadedSource(bad.store, "inspect", bad.key, bad.expected),
    ).rejects.toMatchObject({ code: "invalid_image" });
    await expect(
      inspectUploadedSource(f.store, "inspect", f.key, {
        ...f.expected,
        sha256: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "asset_content_mismatch" });
  });
  it("rejects a small encoded image that exceeds the decoded pixel cap", async () => {
    const bytes = await sharp({
      create: { width: 6400, height: 6400, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const f = await setup(bytes, "image/png");
    await expect(
      inspectUploadedSource(f.store, "inspect", f.key, f.expected),
    ).rejects.toMatchObject({ code: "image_too_large" });
  });
  it("rejects bytes that merely claim to be PDF", async () => {
    const f = await setup(Buffer.from("not a PDF"), "application/pdf");
    await expect(
      inspectUploadedSource(f.store, "inspect", f.key, f.expected),
    ).rejects.toMatchObject({ code: "invalid_document" });
  });
});

it("rejects truncated PDF structures and caps pages before provider admission", async () => {
  const corrupt = await setup(
    Buffer.from("%PDF-1.7\nthis is not a PDF"),
    "application/pdf",
  );
  await expect(
    inspectUploadedSource(
      corrupt.store,
      "inspect",
      corrupt.key,
      corrupt.expected,
    ),
  ).rejects.toMatchObject({ code: "invalid_document" });
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const valid = await setup(await doc.save(), "application/pdf");
  expect(
    await inspectUploadedSource(
      valid.store,
      "inspect",
      valid.key,
      valid.expected,
    ),
  ).toMatchObject({ pageCount: 1, hashVerified: true });
  for (let i = 1; i < 41; i++) doc.addPage([100, 100]);
  const large = await setup(await doc.save(), "application/pdf");
  await expect(
    inspectUploadedSource(large.store, "inspect", large.key, large.expected),
  ).rejects.toMatchObject({ code: "invalid_document" });
});

it("reports an oversized changed upload as a content mismatch", async () => {
  class OversizedUploadStore extends MemoryAssetStore {
    override async readObject(): Promise<Uint8Array> {
      throw Error("asset_body_too_large");
    }
  }
  await expect(
    inspectUploadedSource(
      new OversizedUploadStore(),
      "inspect",
      "ws/inspect/sources/00000000-0000-4000-8000-000000000001/source.pdf",
      {
        mimeType: "application/pdf",
        size: 100,
        sha256: "a".repeat(64),
      },
    ),
  ).rejects.toMatchObject({ code: "asset_content_mismatch" });
});
