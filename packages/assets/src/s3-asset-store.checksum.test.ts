/**
 * What the REAL AWS SDK actually signs into a presigned upload URL.
 *
 * Every other test in this package injects a fake `presign`, which doubles out
 * the exact layer that adds a checksum -- so none of them could ever have seen
 * this. These go through `fromConfig`, the same constructor the web app and the
 * Worker use, and read the URL the browser would be handed.
 *
 * Signing is local: an HMAC over a canonical request. No network, no bucket, no
 * credentials beyond the synthetic pair below.
 */
import { describe, expect, it } from "vitest";

import { S3AssetStore } from "./s3-asset-store.js";

const config = {
  region: "us-east-1",
  endpoint: "https://storage.example",
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

const upload = {
  workspaceId: "ws_opak",
  fileName: "label.png",
  mimeType: "image/png",
  size: 30_332,
};

describe("presigned upload URLs", () => {
  it("does not sign a checksum of the empty presign body", async () => {
    // The SDK default, WHEN_SUPPORTED, computes a request checksum and signs it
    // into the URL. A presign has no body, so the value is always the CRC32 of
    // zero bytes -- AAAAAA== -- in a URL the browser then PUTs real file bytes
    // to. Backends differ on whether they enforce it, so it works until one
    // does and then every upload fails at once.
    const store = S3AssetStore.fromConfig("test-bucket", config);

    const { uploadUrl } = await store.createUpload(upload);
    const params = new URL(uploadUrl).searchParams;

    expect(params.get("x-amz-checksum-crc32")).toBeNull();
    expect(uploadUrl).not.toContain("AAAAAA%3D%3D");
    expect(uploadUrl).not.toContain("AAAAAA==");
  });

  it("does not list a checksum header among the signed headers", async () => {
    // Signing it as a header rather than a query parameter would fail the same
    // way: the browser does not send it, so the signature would not verify.
    const store = S3AssetStore.fromConfig("test-bucket", config);

    const { uploadUrl } = await store.createUpload(upload);
    const signedHeaders =
      new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders") ?? "";

    expect(signedHeaders).not.toContain("checksum");
  });

  it("still binds the upload to the declared length", async () => {
    // Dropping the checksum must not drop the bound that actually protects the
    // bucket: the browser cannot PUT more bytes than the server presigned for.
    const store = S3AssetStore.fromConfig("test-bucket", config);

    const { uploadUrl, key } = await store.createUpload(upload);
    const signedHeaders =
      new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders") ?? "";

    expect(signedHeaders).toContain("content-length");
    expect(key).toContain("ws_opak");
  });

  it("does NOT bind the upload to the declared content type", async () => {
    // Pinned because it is a real gap, not because it is desirable. The
    // PutObjectCommand is given a ContentType, but the SDK does not include it
    // in the signature, so a caller holding the URL may PUT any content type it
    // likes and the object is stored with that instead. The presign is
    // therefore not the layer enforcing the media policy -- finalize is, and it
    // has to keep re-reading the stored object rather than trusting the type
    // the browser claimed at upload time.
    const store = S3AssetStore.fromConfig("test-bucket", config);

    const { uploadUrl } = await store.createUpload(upload);
    const signedHeaders =
      new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders") ?? "";

    expect(signedHeaders).toBe("content-length;host");
    expect(signedHeaders).not.toContain("content-type");
  });

  it("lets a deployment override the checksum policy explicitly", async () => {
    const store = S3AssetStore.fromConfig("test-bucket", {
      ...config,
      requestChecksumCalculation: "WHEN_SUPPORTED",
    });

    const { uploadUrl } = await store.createUpload(upload);

    // Pinned so the override stays a deliberate choice rather than a silent
    // default: this is the shape that broke, and it is still reachable.
    expect(new URL(uploadUrl).searchParams.get("x-amz-checksum-crc32")).toBe(
      "AAAAAA==",
    );
  });
});
