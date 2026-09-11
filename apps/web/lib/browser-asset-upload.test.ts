/**
 * Uploading one file, and uploading it again after something else failed.
 *
 * Every attempt used to start at presign, which mints a fresh random key. So a
 * retry re-sent the whole file over the connection that had just failed, and
 * the first copy stayed in the bucket attached to nothing. These cases pin the
 * two things that make a retry cheap: the caller learns the key the moment the
 * bytes land, and passing it back skips straight to finalize.
 */
import { describe, expect, it, vi } from "vitest";

import { uploadSourceAsset } from "./browser-asset-upload.js";

const KEY =
  "ws/ws_opak/sources/00000000-0000-4000-8000-0000000000aa/bottle.png";
const SECOND_KEY =
  "ws/ws_opak/sources/00000000-0000-4000-8000-0000000000bb/bottle.png";
const ASSET_ID = "00000000-0000-4000-8000-000000000301";
const digest = async () => "a".repeat(64);

function png(): File {
  return new File(["bottle"], "bottle.png", { type: "image/png" });
}

function presigned(key: string, url: string) {
  return Response.json({ key, uploadUrl: url }, { status: 201 });
}

function gone() {
  return Response.json(
    { message: "Uploaded asset was not found." },
    { status: 404 },
  );
}

describe("uploadSourceAsset", () => {
  it("reports the storage key as soon as the bytes are stored", async () => {
    // Before finalize, deliberately: finalize is the step most likely to fail
    // on a flaky connection, and after it the key is no longer what matters.
    const onStored = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(presigned(KEY, "https://storage.example/upload-1"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ assetId: ASSET_ID }, { status: 201 }),
      );

    const result = await uploadSourceAsset(png(), {
      fetcher,
      digest,
      onStored,
    });

    expect(onStored).toHaveBeenCalledExactlyOnceWith(KEY);
    expect(result).toEqual({ assetId: ASSET_ID, key: KEY });
  });

  it("reports the key even when finalize then fails", async () => {
    const onStored = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(presigned(KEY, "https://storage.example/upload-1"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ message: "Database unavailable" }, { status: 503 }),
      );

    await expect(
      uploadSourceAsset(png(), { fetcher, digest, onStored }),
    ).rejects.toThrow("Database unavailable");

    // This is the whole recovery story: the bytes are safe, and the caller
    // knows where. Without it a retry has no choice but to send them again.
    expect(onStored).toHaveBeenCalledExactlyOnceWith(KEY);
  });

  it("resumes from a stored key without re-sending the file", async () => {
    const file = png();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ assetId: ASSET_ID }, { status: 200 }),
      );

    const result = await uploadSourceAsset(
      file,
      { fetcher, digest },
      { key: KEY },
    );

    expect(result).toEqual({ assetId: ASSET_ID, key: KEY });
    // One call, and it is finalize. No presign, no PUT.
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/assets/finalize",
      expect.objectContaining({
        body: JSON.stringify({
          key: KEY,
          mimeType: "image/png",
          size: file.size,
          sha256: "a".repeat(64),
        }),
      }),
    );
  });

  it("re-uploads once when the resumed key's object is gone", async () => {
    // The one failure a plain retry cannot fix by repeating itself. Finalize
    // HEADs the object, so it is also the first place anyone can notice.
    // Leaving it would give the operator a retry button that can only fail.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(gone())
      .mockResolvedValueOnce(
        presigned(SECOND_KEY, "https://storage.example/upload-2"),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({ assetId: ASSET_ID }, { status: 201 }),
      );

    const result = await uploadSourceAsset(
      png(),
      { fetcher, digest },
      { key: KEY },
    );

    expect(result).toEqual({ assetId: ASSET_ID, key: SECOND_KEY });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("gives up rather than looping when the re-upload also 404s", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(gone())
      .mockResolvedValueOnce(
        presigned(SECOND_KEY, "https://storage.example/upload-2"),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(gone());

    await expect(
      uploadSourceAsset(png(), { fetcher, digest }, { key: KEY }),
    ).rejects.toThrow("Uploaded asset was not found.");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("does not retry a finalize refusal that repeating cannot fix", async () => {
    // 409 means the stored object disagrees with what was declared. Sending the
    // bytes again produces the same disagreement.
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { message: "Asset metadata does not match." },
          { status: 409 },
        ),
      );

    await expect(
      uploadSourceAsset(png(), { fetcher, digest }, { key: KEY }),
    ).rejects.toThrow("Asset metadata does not match.");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
