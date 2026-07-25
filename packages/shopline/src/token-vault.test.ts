import { describe, expect, it } from "vitest";

import { decryptShoplineToken, encryptShoplineToken } from "./token-vault.js";

const key = Buffer.alloc(32, 7).toString("base64");
const wrongKey = Buffer.alloc(32, 8).toString("base64");
const token = "shopline-token-do-not-log";
const safeError = "Error: SHOPLINE credential is unavailable";

describe("SHOPLINE token vault", () => {
  it("uses randomized v1 AES-GCM envelopes and decrypts them", async () => {
    const first = await encryptShoplineToken(token, key);
    const second = await encryptShoplineToken(token, key);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(first.split(".")).toHaveLength(3);
    await expect(decryptShoplineToken(first, key)).resolves.toBe(token);
  });

  it("requires a canonical base64 key that decodes to exactly 32 bytes", async () => {
    const invalidKeys = [
      Buffer.alloc(31, 7).toString("base64"),
      Buffer.alloc(33, 7).toString("base64"),
      Buffer.alloc(32, 255).toString("base64").replaceAll("/", "_"),
      ` ${key}`,
      key.slice(0, -1),
    ];

    for (const invalidKey of invalidKeys) {
      await expect(encryptShoplineToken(token, invalidKey)).rejects.toThrow(
        "SHOPLINE credential is unavailable",
      );
    }
  });

  it("returns one uniform secret-free error for key, envelope, and crypto failures", async () => {
    const envelope = await encryptShoplineToken(token, key);
    const failures = [
      () => decryptShoplineToken(envelope, wrongKey),
      () => decryptShoplineToken("v2.bad.bad", key),
      () => decryptShoplineToken("v1.not-base64!.ciphertext", key),
      () => decryptShoplineToken("v1.AAAAAAAAAAAAAAAA.AA", key),
      () => decryptShoplineToken(envelope, "not-a-key"),
    ];

    for (const failure of failures) {
      try {
        await failure();
        throw new Error("expected token vault rejection");
      } catch (error) {
        expect(String(error)).toBe(safeError);
        expect(String(error)).not.toContain(token);
        expect(String(error)).not.toContain(key);
        expect(String(error)).not.toContain(envelope);
        expect(String(error)).not.toMatch(/operation|decrypt|cipher|crypto/i);
      }
    }
  });
});
