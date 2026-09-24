import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { MemoryAssetStore } from "./asset-store.js";
const bytes = new Uint8Array([1, 2, 3]);
const input = {
  workspaceId: "ws_test",
  runId: "10000000-0000-4000-8000-000000000001",
  assetId: "10000000-0000-4000-8000-000000000002",
  expectedDigest: createHash("sha256").update(bytes).digest("hex"),
  bytes,
  mimeType: "image/png",
};
it("snapshots exactly verified bytes outside upload/read/write namespaces", async () => {
  const store = new MemoryAssetStore();
  const result = await store.createWineImageSnapshot(input);
  expect(result.bytes).toEqual(bytes);
  const key = decodeURIComponent(new URL(result.readUrl).pathname.slice(1));
  await expect(store.createReadUrl(input.workspaceId, key)).rejects.toThrow();
  await expect(
    store.writeObject(input.workspaceId, key, new Uint8Array([4]), "image/png"),
  ).rejects.toThrow();
  bytes[0] = 8;
  expect(result.bytes[0]).toBe(1);
  await expect(
    store.createWineImageSnapshot({ ...input, bytes }),
  ).rejects.toThrow();
});
it("rejects invalid tenant/run/hash and nonimage or empty bytes", async () => {
  const store = new MemoryAssetStore();
  for (const patch of [
    { workspaceId: "../escape" },
    { runId: "x" },
    { assetId: "x" },
    { expectedDigest: "x" },
    { mimeType: "application/pdf" },
    { bytes: new Uint8Array() },
  ]) {
    await expect(
      store.createWineImageSnapshot({ ...input, ...patch }),
    ).rejects.toThrow();
  }
});
