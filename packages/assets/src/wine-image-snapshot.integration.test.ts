import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { S3AssetStore } from "./s3-asset-store.js";
it.skipIf(process.env.WINE_LOCAL_S3_E2E !== "1")(
  "local S3 HTTPS snapshots survive upload-key replacement and reject redirected upload credentials",
  async () => {
    const store = S3AssetStore.fromConfig("wukong-local", {
      endpoint: "https://localhost:9012",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "wukong", secretAccessKey: "wukong-secret" },
    });
    const workspaceId = `wine-snapshot-${randomUUID()}`,
      bytes = new Uint8Array([1, 2, 3, 4]);
    const upload = await store.createUpload({
      workspaceId,
      fileName: "bottle.png",
      mimeType: "image/png",
      size: bytes.length,
    });
    expect(
      (
        await fetch(upload.uploadUrl, {
          method: "PUT",
          body: bytes,
          headers: { "content-type": "image/png" },
        })
      ).ok,
    ).toBe(true);
    const snap = await store.createWineImageSnapshot({
      workspaceId,
      runId: randomUUID(),
      assetId: randomUUID(),
      expectedDigest: createHash("sha256").update(bytes).digest("hex"),
      bytes: await store.readObject(workspaceId, upload.key),
      mimeType: "image/png",
    });
    expect(
      (
        await fetch(upload.uploadUrl, {
          method: "PUT",
          body: new Uint8Array([9, 9, 9, 9]),
          headers: { "content-type": "image/png" },
        })
      ).ok,
    ).toBe(true);
    expect(
      new Uint8Array(await (await fetch(snap.readUrl)).arrayBuffer()),
    ).toEqual(bytes);
    const forged = new URL(upload.uploadUrl);
    forged.pathname = new URL(snap.readUrl).pathname;
    expect(
      (
        await fetch(forged, {
          method: "PUT",
          body: new Uint8Array([9, 9, 9, 9]),
          headers: { "content-type": "image/png" },
        })
      ).status,
    ).toBe(403);
    expect(
      new Uint8Array(await (await fetch(snap.readUrl)).arrayBuffer()),
    ).toEqual(bytes);
  },
);
