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
});
