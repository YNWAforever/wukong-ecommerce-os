import { describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ createDatabase: vi.fn() }));

vi.mock("@wukong/db", () => ({ createDatabase: dbMocks.createDatabase }));

import { createWorkerDatabase } from "./cloudflare-runtime.js";
import { handleQueue } from "./queue-consumer.js";

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

  it("closes the Hyperdrive database in finally for every queue batch", async () => {
    const failure = new Error("consumer not installed");
    const database = { close: vi.fn(async () => undefined) };
    const consume = vi.fn(async () => {
      throw failure;
    });

    await expect(
      handleQueue({ messages: [] } as never, {} as never, undefined, {
        createDatabase: () => database as never,
        consume,
      }),
    ).rejects.toBe(failure);
    expect(database.close).toHaveBeenCalledOnce();
  });
});
