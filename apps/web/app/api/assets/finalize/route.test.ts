import { MemoryAssetStore } from "@wukong/assets";
import { describe, expect, it, vi } from "vitest";

import { createFinalizeAssetHandler } from "./route.js";

const sessionContext = {
  async resolve() {
    return { workspaceId: "ws_opak", actorId: "user_1", role: "operator" } as const;
  },
};

function requestFor(body: Record<string, unknown>) {
  return new Request("http://localhost/api/assets/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeDatabase(repositories: Record<string, unknown>) {
  return {
    async forWorkspace<T>(
      _workspaceId: string,
      work: (repos: Record<string, unknown>) => Promise<T>,
    ): Promise<T> {
      return work(repositories);
    },
  };
}

describe("POST /api/assets/finalize", () => {
  it("rejects a viewer before inspecting or persisting an upload", async () => {
    const head = vi.fn();
    const getDatabase = vi.fn(() => {
      throw new Error("unused");
    });
    const handler = createFinalizeAssetHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "viewer",
          } as const;
        },
      },
      getAssetStore: () => ({ head }) as never,
      getDatabase,
    });

    const response = await handler(
      requestFor({
        key: "ws/ws_opak/sources/a/supplier.pdf",
        mimeType: "application/pdf",
        size: 1200,
        sha256: "a".repeat(64),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "insufficient_role",
      message: "Operator access is required.",
    });
    expect(head).not.toHaveBeenCalled();
    expect(getDatabase).not.toHaveBeenCalled();
  });

  it("rejects a storage key from another workspace without touching storage", async () => {
    let headCalls = 0;
    const store = new MemoryAssetStore();
    const originalHead = store.head.bind(store);
    store.head = async (...args) => {
      headCalls += 1;
      return originalHead(...args);
    };
    const handler = createFinalizeAssetHandler({
      sessionContext,
      getAssetStore: () => store,
      getDatabase: () => fakeDatabase({}) as never,
    });

    const response = await handler(
      requestFor({
        key: "ws/ws_other/sources/a/file.pdf",
        mimeType: "application/pdf",
        size: 1200,
        sha256: "a".repeat(64),
      }),
    );

    expect(response.status).toBe(403);
    expect(headCalls).toBe(0);
    expect(await response.json()).toEqual({
      code: "asset_forbidden",
      message: "Asset is not available in this workspace.",
    });
  });

  it("verifies HEAD metadata before persisting the client-reported SHA-256", async () => {
    const store = new MemoryAssetStore();
    const upload = await store.createUpload({
      workspaceId: "ws_opak",
      fileName: "supplier.pdf",
      mimeType: "application/pdf",
      size: 1200,
    });
    store.putObject("ws_opak", upload.key, {
      size: 1200,
      mimeType: "application/pdf",
    });
    const writes: unknown[] = [];
    const audits: unknown[] = [];
    const handler = createFinalizeAssetHandler({
      sessionContext,
      getAssetStore: () => store,
      getDatabase: () =>
        fakeDatabase({
          sourceAssets: {
            async getByStorageKey() {
              return null;
            },
            async create(input: unknown) {
              writes.push(input);
              return { id: "asset_1" };
            },
          },
          audit: {
            async write(event: unknown) {
              audits.push(event);
            },
          },
        }) as never,
    });

    const response = await handler(
      requestFor({
        key: upload.key,
        mimeType: "application/pdf",
        size: 1200,
        sha256: "a".repeat(64),
      }),
    );

    expect(response.status).toBe(201);
    expect(writes).toMatchObject([
      {
        kind: "application/pdf",
        metadata: {
          size: 1200,
          mimeType: "application/pdf",
          clientSha256: "a".repeat(64),
          hashVerified: false,
        },
      },
    ]);
    expect(audits).toMatchObject([{ action: "asset.finalized", entityId: "asset_1" }]);
  });

  it("returns 409 when server-observable metadata differs", async () => {
    const store = new MemoryAssetStore();
    const upload = await store.createUpload({
      workspaceId: "ws_opak",
      fileName: "supplier.pdf",
      mimeType: "application/pdf",
      size: 1200,
    });
    store.putObject("ws_opak", upload.key, { size: 999, mimeType: "application/pdf" });
    const handler = createFinalizeAssetHandler({
      sessionContext,
      getAssetStore: () => store,
      getDatabase: () => fakeDatabase({}) as never,
    });

    const response = await handler(
      requestFor({
        key: upload.key,
        mimeType: "application/pdf",
        size: 1200,
        sha256: "a".repeat(64),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "asset_metadata_mismatch" });
  });

  it("rejects workspace and actor IDs in request JSON", async () => {
    const handler = createFinalizeAssetHandler({
      sessionContext,
      getAssetStore: () => new MemoryAssetStore(),
      getDatabase: () => fakeDatabase({}) as never,
    });
    const response = await handler(
      requestFor({
        key: "ws/ws_opak/sources/a/file.pdf",
        mimeType: "application/pdf",
        size: 1200,
        sha256: "a".repeat(64),
        workspaceId: "ws_other",
        actorId: "attacker",
      }),
    );

    expect(response.status).toBe(400);
  });
});
