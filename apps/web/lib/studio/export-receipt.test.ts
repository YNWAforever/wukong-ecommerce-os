import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  STUDIO_EXPORT_SCHEMA_VERSION,
  buildExportReceipt,
  decodeExportSigningKey,
  exportReceiptMessage,
  resolveExportSigningConfig,
  sha256Hex,
  signStudioExportReceipt,
} from "./export-receipt";

/**
 * Shared HMAC export-receipt helpers (B3 follow-up).
 *
 * No real secret is used anywhere: the fixtures are local test-key literals.
 */

const KEY_HEX = "a".repeat(64);
const KEY = Buffer.from(KEY_HEX, "hex");
const SIGNED_AT = "2026-11-08T11:00:00.000Z";
const INPUT = {
  schemaVersion: STUDIO_EXPORT_SCHEMA_VERSION,
  payloadSha256: "b".repeat(64),
  outputId: "55555555-5555-4555-8555-555555555555",
  revision: 3,
  asOf: "2026-11-08T10:00:00.000Z",
  keyId: "pilot-test",
};

describe("exportReceiptMessage", () => {
  it("is the canonical sorted-key JSON a verifier must feed to HMAC", () => {
    expect(exportReceiptMessage(INPUT)).toBe(
      `{"asOf":"${INPUT.asOf}","keyId":"pilot-test","outputId":"${INPUT.outputId}","payloadSha256":"${"b".repeat(64)}","revision":3,"schemaVersion":"${STUDIO_EXPORT_SCHEMA_VERSION}"}`,
    );
  });

  it("is stable across field order in the input object", () => {
    const reordered = {
      keyId: INPUT.keyId,
      revision: INPUT.revision,
      schemaVersion: INPUT.schemaVersion,
      asOf: INPUT.asOf,
      outputId: INPUT.outputId,
      payloadSha256: INPUT.payloadSha256,
    };
    expect(exportReceiptMessage(reordered)).toBe(exportReceiptMessage(INPUT));
  });
});

describe("signStudioExportReceipt", () => {
  it("matches an independent node:crypto HMAC and carries only the key id", () => {
    const receipt = signStudioExportReceipt(KEY, {
      ...INPUT,
      signedAt: SIGNED_AT,
    });
    const expected = createHmac("sha256", KEY)
      .update(exportReceiptMessage(INPUT))
      .digest("hex");
    expect(receipt).toEqual({
      alg: "HMAC-SHA256",
      keyId: "pilot-test",
      signedAt: SIGNED_AT,
      payloadSha256: INPUT.payloadSha256,
      signature: expected,
    });
    expect(JSON.stringify(receipt)).not.toContain(KEY_HEX);
  });

  it("changes when the key changes and is sensitive to every signed field", () => {
    const base = signStudioExportReceipt(KEY, {
      ...INPUT,
      signedAt: SIGNED_AT,
    });
    const otherKey = signStudioExportReceipt(
      Buffer.from("c".repeat(64), "hex"),
      {
        ...INPUT,
        signedAt: SIGNED_AT,
      },
    );
    expect(otherKey.signature).not.toBe(base.signature);
    for (const field of [
      "payloadSha256",
      "outputId",
      "revision",
      "asOf",
      "keyId",
    ] as const) {
      const changed = signStudioExportReceipt(KEY, {
        ...INPUT,
        [field]: field === "revision" ? 4 : "changed",
        signedAt: SIGNED_AT,
      });
      expect(changed.signature, field).not.toBe(base.signature);
    }
  });
});

describe("decodeExportSigningKey", () => {
  it("returns null when absent and decodes hex/base64 keys", () => {
    expect(decodeExportSigningKey(undefined)).toBeNull();
    expect(decodeExportSigningKey("   ")).toBeNull();
    expect((decodeExportSigningKey(KEY_HEX) as Buffer).length).toBe(32);
    const base64 = Buffer.alloc(32, 7).toString("base64");
    expect((decodeExportSigningKey(base64) as Buffer).length).toBe(32);
  });

  it("rejects malformed or too-short keys", () => {
    expect(decodeExportSigningKey("not a key!!")).toBe(false);
    expect(decodeExportSigningKey("abcd")).toBe(false);
    // 16 bytes is the documented minimum even for valid encodings.
    expect(decodeExportSigningKey(Buffer.alloc(8, 1).toString("hex"))).toBe(
      false,
    );
  });
});

describe("resolveExportSigningConfig", () => {
  it("is off without a key and defaults the key id to v1", () => {
    expect(resolveExportSigningConfig({} as NodeJS.ProcessEnv)).toBeNull();
    const config = resolveExportSigningConfig({
      STUDIO_EXPORT_SIGNING_KEY: KEY_HEX,
    } as unknown as NodeJS.ProcessEnv);
    expect(config?.keyId).toBe("v1");
    expect(config?.key.equals(KEY)).toBe(true);
    const custom = resolveExportSigningConfig({
      STUDIO_EXPORT_SIGNING_KEY: KEY_HEX,
      STUDIO_EXPORT_SIGNING_KEY_ID: "pilot-2026-11",
    } as unknown as NodeJS.ProcessEnv);
    expect(custom?.keyId).toBe("pilot-2026-11");
  });

  it("fails closed for a malformed key or key id without echoing them", () => {
    for (const env of [
      { STUDIO_EXPORT_SIGNING_KEY: "too-short" },
      {
        STUDIO_EXPORT_SIGNING_KEY: KEY_HEX,
        STUDIO_EXPORT_SIGNING_KEY_ID: "space id",
      },
    ]) {
      expect(() =>
        resolveExportSigningConfig(env as unknown as NodeJS.ProcessEnv),
      ).toThrow(
        expect.objectContaining({
          status: 500,
          code: "export_signing_misconfigured",
        }),
      );
      try {
        resolveExportSigningConfig(env as unknown as NodeJS.ProcessEnv);
      } catch (error) {
        expect(String(error)).not.toContain(KEY_HEX);
      }
    }
  });
});

describe("buildExportReceipt", () => {
  it("is explicitly unsigned without a key", () => {
    expect(
      buildExportReceipt({
        ...INPUT,
        env: {} as NodeJS.ProcessEnv,
        signedAt: new Date(SIGNED_AT),
      }),
    ).toEqual({ keyConfigured: false, signed: false, receipt: null });
  });

  it("is signed with the configured key and does not leak it", () => {
    const state = buildExportReceipt({
      ...INPUT,
      env: {
        STUDIO_EXPORT_SIGNING_KEY: KEY_HEX,
        STUDIO_EXPORT_SIGNING_KEY_ID: "pilot-test",
      } as unknown as NodeJS.ProcessEnv,
      signedAt: new Date(SIGNED_AT),
    });
    expect(state.keyConfigured).toBe(true);
    expect(state.signed).toBe(true);
    expect(state.receipt?.keyId).toBe("pilot-test");
    expect(state.receipt?.signedAt).toBe(SIGNED_AT);
    expect(JSON.stringify(state)).not.toContain(KEY_HEX);
  });
});

describe("sha256Hex", () => {
  it("is the sha256 of the exact canonical string", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
