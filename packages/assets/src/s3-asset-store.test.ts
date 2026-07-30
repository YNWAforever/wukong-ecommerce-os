import { describe, expect, it } from "vitest";

import { ASSET_EXPORT_READ_TTL_MS } from "./asset-store.js";
import {
  S3AssetStore,
  type S3Presigner,
  type S3Transport,
} from "./s3-asset-store.js";

describe("S3AssetStore", () => {
  it("presigns a constrained PUT for exactly ten minutes", async () => {
    const sent: Array<{ input?: Record<string, unknown> }> = [];
    const transport: S3Transport = {
      async send(command) {
        sent.push(command);
        return {};
      },
    };
    let expiresIn = 0;
    const presign: S3Presigner = async (_transport, command, options) => {
      sent.push(command);
      expiresIn = options.expiresIn;
      return "https://storage.example/upload";
    };
    const store = new S3AssetStore({
      bucket: "test-bucket",
      transport,
      presign,
    });

    const result = await store.createUpload({
      workspaceId: "ws_opak",
      fileName: "supplier.pdf",
      mimeType: "application/pdf",
      size: 1200,
    });

    expect(expiresIn).toBe(600);
    expect(sent[0]?.input).toMatchObject({
      Bucket: "test-bucket",
      Key: result.key,
      ContentLength: 1200,
      ContentType: "application/pdf",
    });
  });

  it("reads server-observable object metadata through HEAD", async () => {
    const transport: S3Transport = {
      async send() {
        return { ContentLength: 1200, ContentType: "application/pdf" };
      },
    };
    const store = new S3AssetStore({
      bucket: "test-bucket",
      transport,
      presign: async () => "https://storage.example/signed",
    });

    await expect(
      store.head(
        "ws_opak",
        "ws/ws_opak/sources/00000000-0000-4000-8000-000000000001/file.pdf",
      ),
    ).resolves.toEqual({ size: 1200, mimeType: "application/pdf" });
  });

  it("makes no request for a cross-workspace read", async () => {
    let calls = 0;
    const transport: S3Transport = {
      async send() {
        calls += 1;
        return {};
      },
    };
    const store = new S3AssetStore({
      bucket: "test-bucket",
      transport,
      presign: async () => "https://storage.example/signed",
    });

    await expect(
      store.createReadUrl("ws_opak", "ws/ws_other/sources/a/file.pdf"),
    ).rejects.toThrow(/workspace/i);
    expect(calls).toBe(0);
  });

  it("presigns a read for the caller's lifetime and defaults to ten minutes", async () => {
    const seen: number[] = [];
    const presign: S3Presigner = async (_transport, _command, options) => {
      seen.push(options.expiresIn);
      return "https://storage.example/read";
    };
    const store = new S3AssetStore({
      bucket: "test-bucket",
      transport: {
        async send() {
          return {};
        },
      },
      presign,
    });
    const key =
      "ws/ws_opak/sources/4f2807b3-73b8-4f74-9d2f-3359ef36a243/800x.webp";

    await store.createReadUrl("ws_opak", key);
    await store.createReadUrl("ws_opak", key, {
      expiresInMs: ASSET_EXPORT_READ_TTL_MS,
    });

    expect(seen).toEqual([600, 604_800]);
  });
});
