import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ createDatabase: vi.fn() }));

vi.mock("@wukong/db", () => ({ createDatabase: dbMocks.createDatabase }));

import {
  createCloudflareRuntime,
  createWorkerDatabase,
} from "./cloudflare-runtime.js";

describe("Cloudflare runtime", () => {
  it("creates a five-connection database only from Hyperdrive", () => {
    const database = { close: vi.fn() };
    dbMocks.createDatabase.mockReturnValue(database);

    expect(
      createWorkerDatabase({
        HYPERDRIVE: { connectionString: "opaque-connection-string" },
      } as never),
    ).toBe(database);
    expect(dbMocks.createDatabase).toHaveBeenCalledWith(
      "opaque-connection-string",
      { maxConnections: 5 },
    );
  });

  it("closes the Hyperdrive database through the Cloudflare runtime", async () => {
    const database = {
      close: vi.fn(async () => undefined),
      forWorkspace: vi.fn(),
    };
    const runtime = createCloudflareRuntime({ AI_PROVIDER: "fake" } as never, {
      databaseFactory: () => database as never,
      assetStoreFactory: () => ({}) as never,
      providerFactory: () => ({}) as never,
    });

    await runtime.close();

    expect(database.close).toHaveBeenCalledOnce();
  });

  it("resolves owned draft images inside the workspace database boundary", async () => {
    const sourceAssets = {
      getByIds: vi.fn(async () => [
        {
          id: "asset_a",
          workspaceId: "ws_opak",
          listingId: "draft_1",
          kind: "image/png",
          storageKey: "ws/ws_opak/sources/asset-a/a.png",
        },
      ]),
    };
    const repositories = { sourceAssets };
    const database = {
      close: vi.fn(async () => undefined),
      forWorkspace: vi.fn(
        async (
          _workspaceId: string,
          work: (value: typeof repositories) => Promise<unknown>,
        ) => work(repositories),
      ),
    };
    const createReadUrl = vi.fn(async () => ({
      url: "https://signed.example/asset-a",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }));
    const runtime = createCloudflareRuntime({ AI_PROVIDER: "fake" } as never, {
      databaseFactory: () => database as never,
      assetStoreFactory: () => ({ createReadUrl }) as never,
      providerFactory: () => ({}) as never,
    });

    await expect(
      runtime.resolveImageUrls("ws_opak", "draft_1", ["asset_a"]),
    ).resolves.toEqual(["https://signed.example/asset-a"]);

    expect(database.forWorkspace).toHaveBeenCalledWith(
      "ws_opak",
      expect.any(Function),
    );
    expect(sourceAssets.getByIds).toHaveBeenCalledWith(["asset_a"]);
    // The pipeline resolves images for in-app use, so it asks for no explicit
    // lifetime and the asset store applies its own default. Only the CSV export
    // path requests the long one.
    expect(createReadUrl).toHaveBeenCalledWith(
      "ws_opak",
      "ws/ws_opak/sources/asset-a/a.png",
      { expiresInMs: undefined },
    );
  });
});
