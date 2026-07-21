import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { decryptShoplineToken } from "@wukong/shopline";
import {
  runShoplineConnectionSeed,
  seedShoplineConnection,
  type ShoplineConnectionSeedStore,
} from "./seed-shopline-connection.js";

const base64Key = Buffer.alloc(32, 19).toString("base64");
const token = "stdin-shopline-token-do-not-log";

function makeStore(connectionId = "00000000-0000-4000-8000-000000000008") {
  const store: ShoplineConnectionSeedStore = {
    upsert: vi.fn(async () => connectionId),
  };
  return store;
}

describe("controlled SHOPLINE connection seed", () => {
  it("encrypts before insertion and returns only safe connection metadata", async () => {
    const store = makeStore();
    const result = await seedShoplineConnection(store, {
      workspaceId: "ws_opak",
      shopDomain: "opakcellar.com",
      token,
      base64Key,
    });
    const inserted = vi.mocked(store.upsert).mock.calls[0]?.[0];

    expect(inserted?.encryptedAccessToken).toMatch(/^v1\./);
    expect(inserted?.encryptedAccessToken).not.toContain(token);
    await expect(
      decryptShoplineToken(inserted?.encryptedAccessToken ?? "", base64Key),
    ).resolves.toBe(token);
    expect(result).toEqual({
      workspaceId: "ws_opak",
      connectionId: "00000000-0000-4000-8000-000000000008",
      shopDomain: "opakcellar.com",
    });
    expect(Object.keys(result).sort()).toEqual([
      "connectionId",
      "shopDomain",
      "workspaceId",
    ]);
  });

  it("reads exactly one token line from stdin and emits only safe JSON", async () => {
    const store = makeStore();
    const output: string[] = [];
    const databaseUrl = "postgres://admin-secret@example/db";
    await runShoplineConnectionSeed({
      argv: [],
      env: {
        DATABASE_ADMIN_URL: databaseUrl,
        SHOPLINE_TOKEN_ENCRYPTION_KEY: base64Key,
        SHOPLINE_ACCESS_TOKEN: "env-token-must-be-ignored",
      },
      stdin: Readable.from([`${token}\n`]),
      stdout: { write: (value) => output.push(String(value)) },
      databaseFactory: () => ({ close: vi.fn(async () => undefined) }) as never,
      storeFactory: () => store,
    });

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "")).toEqual({
      workspaceId: "ws_opak",
      connectionId: "00000000-0000-4000-8000-000000000008",
      shopDomain: "opakcellar.com",
    });
    const serialized = output.join("");
    const inserted = vi.mocked(store.upsert).mock.calls[0]?.[0];
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("env-token-must-be-ignored");
    expect(serialized).not.toContain(inserted?.encryptedAccessToken ?? "v1.");
    expect(serialized).not.toContain(base64Key);
    expect(serialized).not.toContain(databaseUrl);
    await expect(
      decryptShoplineToken(inserted?.encryptedAccessToken ?? "", base64Key),
    ).resolves.toBe(token);
  });

  it("rejects CLI token arguments and zero or multiple stdin lines", async () => {
    const common = {
      env: {
        DATABASE_ADMIN_URL: "postgres://hidden",
        SHOPLINE_TOKEN_ENCRYPTION_KEY: base64Key,
      },
      stdout: { write: vi.fn() },
      databaseFactory: vi.fn(),
      storeFactory: vi.fn(),
    };
    await expect(
      runShoplineConnectionSeed({
        ...common,
        argv: [token],
        stdin: Readable.from(["ignored\n"]),
      }),
    ).rejects.toThrow("SHOPLINE token must be provided exactly once on stdin");
    await expect(
      runShoplineConnectionSeed({
        ...common,
        argv: [],
        stdin: Readable.from([]),
      }),
    ).rejects.toThrow("SHOPLINE token must be provided exactly once on stdin");
    await expect(
      runShoplineConnectionSeed({
        ...common,
        argv: [],
        stdin: Readable.from(["first\nsecond\n"]),
      }),
    ).rejects.toThrow("SHOPLINE token must be provided exactly once on stdin");
    expect(common.databaseFactory).not.toHaveBeenCalled();
    expect(common.stdout.write).not.toHaveBeenCalled();
  });

  it("sanitizes database failures without emitting secret output", async () => {
    const databaseUrl = "postgres://admin-secret@example/db";
    const output = { write: vi.fn() };
    const close = vi.fn(async () => undefined);
    const store: ShoplineConnectionSeedStore = {
      async upsert(input) {
        throw new Error(
          token +
            " " +
            input.encryptedAccessToken +
            " " +
            base64Key +
            " " +
            databaseUrl,
        );
      },
    };

    try {
      await runShoplineConnectionSeed({
        argv: [],
        env: {
          DATABASE_ADMIN_URL: databaseUrl,
          SHOPLINE_TOKEN_ENCRYPTION_KEY: base64Key,
        },
        stdin: Readable.from([token + "\n"]),
        stdout: output,
        databaseFactory: () => ({ close }) as never,
        storeFactory: () => store,
      });
      throw new Error("expected seed rejection");
    } catch (error) {
      expect(String(error)).toBe("Error: SHOPLINE connection seed failed");
      expect(String(error)).not.toContain(token);
      expect(String(error)).not.toContain(base64Key);
      expect(String(error)).not.toContain(databaseUrl);
    }
    expect(output.write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});
