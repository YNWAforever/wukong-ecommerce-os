import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryAssetStore, createExportAssetKey } from "@wukong/assets";
import { ensureExportArtifact } from "./export-artifact";

const workspaceId = "ws_artifact";
const id = "11111111-1111-4111-8111-111111111111";
const body = new TextEncoder().encode("immutable bytes");
const artifactSha256 = createHash("sha256").update(body).digest("hex");
const key = createExportAssetKey({
  workspaceId,
  exportAttemptId: id,
  fileName: `export-${id}.xlsx`,
});

describe("durable export artifact", () => {
  it("creates missing bytes once and verifies an identical retry without writing", async () => {
    const store = new MemoryAssetStore();
    let writes = 0;
    const original = store.writeObjectIfAbsent.bind(store);
    store.writeObjectIfAbsent = async (...args) => {
      writes++;
      return original(...args);
    };
    await ensureExportArtifact(
      { workspaceId, id, artifactSha256, body },
      store,
    );
    await ensureExportArtifact(
      { workspaceId, id, artifactSha256, body },
      store,
    );
    expect(writes).toBe(1);
    expect(await store.readObject(workspaceId, key)).toEqual(body);
  });

  it("never overwrites a stored object with a different hash", async () => {
    const store = new MemoryAssetStore();
    const corrupt = new TextEncoder().encode("different bytes");
    await store.writeObject(
      workspaceId,
      key,
      corrupt,
      "application/octet-stream",
    );
    await expect(
      ensureExportArtifact({ workspaceId, id, artifactSha256, body }, store),
    ).rejects.toMatchObject({ code: "artifact_hash_mismatch" });
    expect(await store.readObject(workspaceId, key)).toEqual(corrupt);
  });

  it("rejects a regenerated candidate that disagrees with the committed hash before storage", async () => {
    const store = new MemoryAssetStore();
    await expect(
      ensureExportArtifact(
        { workspaceId, id, artifactSha256, body: new Uint8Array([1]) },
        store,
      ),
    ).rejects.toMatchObject({ code: "artifact_candidate_mismatch" });
  });

  it("does not interpret an outage as missing and try to write", async () => {
    const store = new MemoryAssetStore();
    store.readObject = async () => {
      throw new Error("connection reset");
    };
    store.writeObjectIfAbsent = async () => {
      throw new Error("must not write");
    };
    await expect(
      ensureExportArtifact({ workspaceId, id, artifactSha256, body }, store),
    ).rejects.toThrow("connection reset");
  });
  it("resolves concurrent creates by verifying the one committed object", async () => {
    const store = new MemoryAssetStore();
    const input = { workspaceId, id, artifactSha256, body };
    await Promise.all([
      ensureExportArtifact(input, store),
      ensureExportArtifact(input, store),
    ]);
    expect(await store.readObject(workspaceId, key)).toEqual(body);
  });
  it("does not let caller mutation alter the committed bytes", async () => {
    const store = new MemoryAssetStore();
    const candidate = new Uint8Array(body);
    await ensureExportArtifact(
      { workspaceId, id, artifactSha256, body: candidate },
      store,
    );
    candidate.fill(0);
    const downloaded = await store.readObject(workspaceId, key);
    downloaded.fill(0);
    expect(await store.readObject(workspaceId, key)).toEqual(body);
  });
});
