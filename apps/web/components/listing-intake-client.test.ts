import { describe, expect, it, vi } from "vitest";

import { createListingDraft } from "./listing-intake-client.js";

describe("live listing intake", () => {
  it("presigns, uploads, finalizes, and creates a listing with the finalized assets", async () => {
    const file = new File(["bottle"], "bottle.png", { type: "image/png" });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            key: "workspaces/ws_opak/assets/file-1",
            uploadUrl: "https://storage.example/upload-1",
            expiresAt: "2026-07-18T06:00:00.000Z",
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json(
          { assetId: "00000000-0000-4000-8000-000000000301" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            listing: {
              id: "00000000-0000-4000-8000-000000000101",
              status: "received",
              target: "shopline",
            },
            processing: {
              state: "queued",
              jobId: "job_1",
              errorCode: null,
            },
          },
          { status: 201 },
        ),
      );

    const result = await createListingDraft(
      { files: [file], note: "Opak pilot" },
      {
        fetcher,
        digest: async () => "a".repeat(64),
      },
    );

    expect(result).toEqual({
      listingId: "00000000-0000-4000-8000-000000000101",
      processing: "queued",
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/assets/presign",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          fileName: "bottle.png",
          mimeType: "image/png",
          size: file.size,
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://storage.example/upload-1",
      expect.objectContaining({ method: "PUT", body: file }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/assets/finalize",
      expect.objectContaining({
        body: JSON.stringify({
          key: "workspaces/ws_opak/assets/file-1",
          mimeType: "image/png",
          size: file.size,
          sha256: "a".repeat(64),
        }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "/api/listings",
      expect.objectContaining({
        body: JSON.stringify({
          sourceAssetIds: ["00000000-0000-4000-8000-000000000301"],
          note: "Opak pilot",
        }),
      }),
    );
  });

  it("preserves a retry-required outcome without re-uploading assets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json(
        {
          listing: { id: "00000000-0000-4000-8000-000000000101" },
          processing: {
            state: "retry_required",
            jobId: null,
            errorCode: "queue_unavailable",
          },
        },
        { status: 201 },
      ),
    );

    await expect(
      createListingDraft({ files: [], note: "Opak pilot" }, { fetcher }),
    ).resolves.toEqual({
      listingId: "00000000-0000-4000-8000-000000000101",
      processing: "retry_required",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops before listing creation when an upload boundary fails", async () => {
    const file = new File(["bottle"], "bottle.png", { type: "image/png" });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { key: "key-1", uploadUrl: "https://storage.example/upload-1" },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ message: "Upload rejected" }, { status: 403 }),
      );

    await expect(
      createListingDraft(
        { files: [file], note: "" },
        { fetcher, digest: async () => "a".repeat(64) },
      ),
    ).rejects.toThrow("Upload rejected");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
