import { MemoryAssetStore } from "@wukong/assets";
import { describe, expect, it } from "vitest";

import { createPresignAssetHandler } from "./assets/presign/route.js";
import { createListingHandler } from "./listings/route.js";

const sessionContext = {
  async resolve() {
    return { workspaceId: "ws_opak", actorId: "user_1", role: "operator" } as const;
  },
};

function requestFor(url: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${url}`, {
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

describe("POST /api/assets/presign", () => {
  it("derives the key workspace from server-side session context", async () => {
    const handler = createPresignAssetHandler({
      sessionContext,
      getAssetStore: () => new MemoryAssetStore(),
      getDatabase: () => {
        throw new Error("database must stay lazy");
      },
    });

    const response = await handler(
      requestFor("/api/assets/presign", {
        fileName: "bottle.png",
        mimeType: "image/png",
        size: 1200,
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      key: expect.stringMatching(/^ws\/ws_opak\/sources\//),
      uploadUrl: expect.stringContaining("memory://upload/"),
    });
  });

  it("does not accept a client workspace override", async () => {
    const handler = createPresignAssetHandler({
      sessionContext,
      getAssetStore: () => new MemoryAssetStore(),
      getDatabase: () => {
        throw new Error("unused");
      },
    });
    const response = await handler(
      requestFor("/api/assets/presign", {
        fileName: "bottle.png",
        mimeType: "image/png",
        size: 1200,
        workspaceId: "ws_other",
      }),
    );

    expect(response.status).toBe(400);
  });
});

describe("POST /api/listings", () => {
  it("creates one received SHOPLINE draft, associates owned assets, and audits", async () => {
    const calls: unknown[] = [];
    const handler = createListingHandler({
      sessionContext,
      getAssetStore: () => {
        throw new Error("asset store must stay lazy");
      },
      getDatabase: () =>
        fakeDatabase({
          sourceAssets: {
            async getByIds() {
              return [
                { id: "asset_1", listingId: null },
                { id: "asset_2", listingId: null },
              ];
            },
            async attachToListing(listingId: string, assetIds: string[]) {
              calls.push({ listingId, assetIds });
            },
          },
          listings: {
            async create(input: unknown) {
              calls.push(input);
              return { id: "listing_1", status: "received", target: "shopline" };
            },
          },
          audit: {
            async write(event: unknown) {
              calls.push(event);
            },
          },
        }) as never,
    });

    const response = await handler(
      requestFor("/api/listings", {
        sourceAssetIds: ["asset_1", "asset_2"],
        note: "Supplier sheet attached",
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      listing: { id: "listing_1", status: "received", target: "shopline" },
    });
    expect(calls).toContainEqual({
      target: "shopline",
      note: "Supplier sheet attached",
    });
    expect(calls).toContainEqual({
      action: "listing.created",
      actorId: "user_1",
      entityId: "listing_1",
      metadata: { assetCount: 2, hasNote: true },
      workspaceId: "ws_opak",
    });
  });

  it("returns a generic 404 when any asset is outside the workspace", async () => {
    const handler = createListingHandler({
      sessionContext,
      getAssetStore: () => {
        throw new Error("unused");
      },
      getDatabase: () =>
        fakeDatabase({
          sourceAssets: { async getByIds() { return [{ id: "asset_1", listingId: null }]; } },
        }) as never,
    });
    const response = await handler(
      requestFor("/api/listings", {
        sourceAssetIds: ["asset_1", "asset_foreign"],
        note: "",
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "source_assets_not_found",
      message: "One or more source assets were not found.",
    });
  });
});
