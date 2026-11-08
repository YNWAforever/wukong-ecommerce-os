import { describe, expect, it } from "vitest";

import {
  decryptStudioMcpCredential,
  encryptStudioMcpCredential,
  hasStudioMcpEncryptionKey,
  readStudioMcpEncryptionKey,
  STUDIO_MCP_CREDENTIAL_UNAVAILABLE,
  STUDIO_MCP_ENCRYPTION_KEY_ENV,
} from "./mcp-credentials.js";

/**
 * Studio MCP credential envelope tests (plan Task 13).
 *
 * Synthetic keys and payloads only. Nothing is persisted, and every failure
 * has the same content-free message.
 */

/** Deterministic 32-byte keys: base64 of 0x01*32 and 0x02*32. */
const KEY = Buffer.alloc(32, 0x01).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 0x02).toString("base64");

const envWith = (key: string | undefined): NodeJS.ProcessEnv =>
  ({
    [STUDIO_MCP_ENCRYPTION_KEY_ENV]: key,
  }) as unknown as NodeJS.ProcessEnv;

describe("studio mcp encryption key", () => {
  it("reads only a well-formed 32-byte base64 key", () => {
    expect(readStudioMcpEncryptionKey(envWith(KEY))).toBe(KEY);
    expect(hasStudioMcpEncryptionKey(envWith(KEY))).toBe(true);
    // Whitespace from a secrets file is tolerated; the value itself is strict.
    expect(readStudioMcpEncryptionKey(envWith(`  ${KEY}  `))).toBe(KEY);
  });

  it("fails closed for missing, blank, short and non-base64 keys", () => {
    expect(readStudioMcpEncryptionKey(envWith(undefined))).toBeNull();
    expect(readStudioMcpEncryptionKey(envWith(""))).toBeNull();
    expect(readStudioMcpEncryptionKey(envWith("   "))).toBeNull();
    expect(
      readStudioMcpEncryptionKey(
        envWith(Buffer.alloc(16, 1).toString("base64")),
      ),
    ).toBeNull();
    expect(readStudioMcpEncryptionKey(envWith("not-a-key"))).toBeNull();
    expect(hasStudioMcpEncryptionKey(envWith("not-a-key"))).toBe(false);
  });
});

describe("studio mcp credential envelope", () => {
  it("round-trips a credential and never includes the plaintext", async () => {
    const plaintext = "mcp-bearer-token-for-tests";
    const envelope = await encryptStudioMcpCredential(plaintext, KEY);
    expect(envelope).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(envelope).not.toContain(plaintext);
    await expect(decryptStudioMcpCredential(envelope, KEY)).resolves.toBe(
      plaintext,
    );
  });

  it("rejects a wrong key with the same content-free error", async () => {
    const envelope = await encryptStudioMcpCredential("payload", KEY);
    await expect(
      decryptStudioMcpCredential(envelope, OTHER_KEY),
    ).rejects.toThrow(STUDIO_MCP_CREDENTIAL_UNAVAILABLE);
  });

  it("rejects corrupted envelopes and invalid keys", async () => {
    const envelope = await encryptStudioMcpCredential("payload", KEY);
    for (const corrupted of [
      "",
      "v1",
      "v2.a.b",
      "v1.aaaa",
      `v1.${envelope.split(".")[1] ?? ""}`,
      `${envelope.slice(0, -4)}AAAA`,
    ]) {
      await expect(decryptStudioMcpCredential(corrupted, KEY)).rejects.toThrow(
        STUDIO_MCP_CREDENTIAL_UNAVAILABLE,
      );
    }
    await expect(
      decryptStudioMcpCredential(envelope, "not-a-key"),
    ).rejects.toThrow(STUDIO_MCP_CREDENTIAL_UNAVAILABLE);
  });

  it("refuses to encrypt empty plaintext", async () => {
    await expect(encryptStudioMcpCredential("", KEY)).rejects.toThrow(
      STUDIO_MCP_CREDENTIAL_UNAVAILABLE,
    );
  });

  it("produces a fresh IV per envelope", async () => {
    const first = await encryptStudioMcpCredential("payload", KEY);
    const second = await encryptStudioMcpCredential("payload", KEY);
    expect(first).not.toBe(second);
    expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
  });
});
