import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ createDatabase: vi.fn() }));

vi.mock("@wukong/db", () => ({ createDatabase: dbMocks.createDatabase }));

import {
  authenticatedWorkerHealth,
  createCloudflareRuntime,
  createWorkerDatabase,
} from "./cloudflare-runtime.js";
import type { WorkerEnv } from "./worker-env.js";

function env(): WorkerEnv {
  return {
    HYPERDRIVE: { connectionString: "postgres://x" } as never,
    LISTING_QUEUE: { send: vi.fn(async () => undefined) } as never,
    SHOPLINE_QUEUE: { send: vi.fn(async () => undefined) } as never,
    QUEUE_INGRESS_SECRET: "q".repeat(32),
    BUILD_SHA: "abc123",
    SHOPLINE_ADAPTER: "disabled",
  };
}

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

describe("authenticatedWorkerHealth", () => {
  it("reports a reachable database", async () => {
    const database = {
      ping: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };

    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => database as never,
    });

    expect(health.authenticated).toBe(true);
    expect(health.checks.hyperdriveConnects).toBe(true);
    expect(database.close).toHaveBeenCalled();
  });

  it("reports an unreachable database without throwing", async () => {
    const database = {
      ping: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      close: vi.fn(async () => undefined),
    };

    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => database as never,
    });

    expect(health.checks.hyperdriveConnects).toBe(false);
    expect(database.close).toHaveBeenCalled();
  });

  it("survives the database factory throwing", async () => {
    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => {
        throw new Error("HYPERDRIVE binding is required");
      },
    });

    expect(health.authenticated).toBe(true);
    expect(health.checks.hyperdriveConnects).toBe(false);
  });

  it("survives close() rejecting after a successful ping", async () => {
    const database = {
      ping: vi.fn(async () => undefined),
      close: vi.fn(async () => {
        throw new Error("socket already gone");
      }),
    };

    const health = await authenticatedWorkerHealth(env(), {
      createDatabase: () => database as never,
    });

    expect(health.checks.hyperdriveConnects).toBe(true);
  });
});
