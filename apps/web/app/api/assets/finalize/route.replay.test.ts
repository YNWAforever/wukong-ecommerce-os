/**
 * Finalizing the same upload twice.
 *
 * `route.test.ts` never reaches this branch, and the branch used to answer
 * `409 asset_already_finalized` unconditionally. That was defensible only while
 * every attempt started at presign and therefore got a fresh random key. Now
 * that the browser can resume a stored key, a finalize whose response was lost
 * is the ordinary way to arrive here -- and refusing it strands bytes that are
 * already safely in the bucket, with no way for the operator to reach them.
 *
 * The distinction being pinned: the same key with the same content is the same
 * asset; the same key with DIFFERENT content is still a conflict.
 */
import { MemoryAssetStore } from "@wukong/assets";
import { describe, expect, it } from "vitest";

import { createFinalizeAssetHandler } from "./route.js";

const SHA = "a".repeat(64);

const sessionContext = {
  async resolve() {
    return {
      workspaceId: "ws_opak",
      actorId: "user_1",
      role: "operator",
    } as const;
  },
};

function requestFor(body: Record<string, unknown>) {
  return new Request("http://localhost/api/assets/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A store holding one uploaded object, plus the key it lives at. */
async function storeWithUpload() {
  const store = new MemoryAssetStore();
  const upload = await store.createUpload({
    workspaceId: "ws_opak",
    fileName: "bottle.png",
    mimeType: "image/png",
    size: 1024,
  });
  store.putObject("ws_opak", upload.key, {
    size: 1024,
    mimeType: "image/png",
  });
  return { store, key: upload.key };
}

function harness(
  store: MemoryAssetStore,
  existing: Record<string, unknown> | null,
) {
  const creates: unknown[] = [];
  const audits: unknown[] = [];
  const handler = createFinalizeAssetHandler({
    sessionContext,
    getAssetStore: () => store,
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repos: Record<string, unknown>) => Promise<T>,
        ) {
          return work({
            sourceAssets: {
              async getByStorageKey() {
                return existing;
              },
              async create(input: unknown) {
                creates.push(input);
                return { id: "asset_1" };
              },
            },
            audit: {
              async write(event: unknown) {
                audits.push(event);
              },
            },
          });
        },
      }) as never,
  });
  return { handler, creates, audits };
}

describe("POST /api/assets/finalize replayed", () => {
  it("returns the asset the first call created", async () => {
    const { store, key } = await storeWithUpload();
    const { handler, creates, audits } = harness(store, {
      id: "asset_1",
      metadata: { clientSha256: SHA },
    });

    const response = await handler(
      requestFor({ key, mimeType: "image/png", size: 1024, sha256: SHA }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assetId: "asset_1" });
    // Nothing was created, so nothing is audited. An "asset.finalized" event
    // per replay would report a mutation that did not happen.
    expect(creates).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("still refuses a key already holding different content", async () => {
    // Same key, different bytes. Handing back the first asset would attach the
    // wrong file to the operator's listing without telling anyone.
    const { store, key } = await storeWithUpload();
    const { handler } = harness(store, {
      id: "asset_1",
      metadata: { clientSha256: "b".repeat(64) },
    });

    const response = await handler(
      requestFor({ key, mimeType: "image/png", size: 1024, sha256: SHA }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "asset_already_finalized",
    });
  });

  it("refuses a row with no recorded checksum rather than assuming a match", async () => {
    // `metadata` is jsonb, so a historical row can be missing clientSha256.
    // Absent is not equal, and treating it as one would make the check hollow.
    const { store, key } = await storeWithUpload();
    const { handler } = harness(store, { id: "asset_1", metadata: {} });

    const response = await handler(
      requestFor({ key, mimeType: "image/png", size: 1024, sha256: SHA }),
    );

    expect(response.status).toBe(409);
  });

  it("still creates and audits on the first call", async () => {
    const { store, key } = await storeWithUpload();
    const { handler, creates, audits } = harness(store, null);

    const response = await handler(
      requestFor({ key, mimeType: "image/png", size: 1024, sha256: SHA }),
    );

    expect(response.status).toBe(201);
    expect(creates).toHaveLength(1);
    expect(audits).toMatchObject([
      { action: "asset.finalized", entityId: "asset_1" },
    ]);
  });

  it("checks the stored object before consulting the database at all", async () => {
    // A replay whose object has since gone is a 404, not a 200. Answering from
    // the row alone would hand back an asset whose bytes no longer exist.
    const store = new MemoryAssetStore();
    const { handler } = harness(store, {
      id: "asset_1",
      metadata: { clientSha256: SHA },
    });

    const response = await handler(
      requestFor({
        key: "ws/ws_opak/sources/00000000-0000-4000-8000-0000000000aa/bottle.png",
        mimeType: "image/png",
        size: 1024,
        sha256: SHA,
      }),
    );

    expect(response.status).toBe(404);
  });
});
