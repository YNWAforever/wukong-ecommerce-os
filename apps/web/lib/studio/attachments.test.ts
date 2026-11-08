import { describe, expect, it, vi } from "vitest";

import { MAX_ASSET_SIZE } from "@wukong/assets/media-policy";

import {
  planStudioAttachments,
  rejectStudioAttachment,
  STUDIO_ATTACHMENT_ACCEPT,
  STUDIO_MAX_ATTACHMENTS,
  StudioAttachmentError,
  uploadStudioAttachment,
} from "./attachments.js";

/**
 * Composer attachment transport tests (B1).
 *
 * The only transport is the injected fetcher: no test touches the network or
 * S3, and the assertions pin the exact presign/finalize payloads from the
 * existing route schemas rather than a new contract.
 */

const SHA = "a".repeat(64);

function file(name = "photo.png", type = "image/png", bytes = 5): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

type FetchCall = { url: string; init: RequestInit };

function transport(
  handlers: Record<string, () => Response | Promise<Response>>,
): { fetcher: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const handler = handlers[url];
    if (!handler) throw new Error(`unexpected fetch ${url}`);
    return handler();
  }) as typeof fetch;
  return { fetcher, calls };
}

function presignBody(key = "ws/ws_test/sources/k/photo.png") {
  return Response.json(
    {
      key,
      uploadUrl: "https://storage.example.test/put",
      expiresAt: "2026-11-09T04:40:00.000Z",
    },
    { status: 201 },
  );
}

describe("studio attachment validation", () => {
  it("accepts exactly the MIME types and size the upload routes accept", () => {
    for (const mimeType of [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]) {
      expect(rejectStudioAttachment({ mimeType, size: 1 })).toBeNull();
      expect(
        rejectStudioAttachment({ mimeType, size: MAX_ASSET_SIZE }),
      ).toBeNull();
    }
    expect(STUDIO_ATTACHMENT_ACCEPT.split(",")).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ]);
  });

  it("rejects unsupported, empty and oversized files with distinct codes", () => {
    expect(rejectStudioAttachment({ mimeType: "text/plain", size: 10 })).toBe(
      "unsupported_type",
    );
    expect(rejectStudioAttachment({ mimeType: "image/png", size: 0 })).toBe(
      "empty_file",
    );
    expect(
      rejectStudioAttachment({
        mimeType: "image/png",
        size: MAX_ASSET_SIZE + 1,
      }),
    ).toBe("too_large");
  });
});

describe("studio attachment planning", () => {
  it("caps one selection at eight files", () => {
    const plan = planStudioAttachments(
      Array.from({ length: STUDIO_MAX_ATTACHMENTS + 1 }, (_, index) =>
        file(`photo-${index}.png`),
      ),
      0,
    );
    expect(plan.accepted).toHaveLength(STUDIO_MAX_ATTACHMENTS);
    expect(plan.rejected).toEqual([]);
    expect(plan.limitSkipped).toBe(1);
  });

  it("counts already-present attachments against the cap", () => {
    const plan = planStudioAttachments(
      [file("a.png"), file("b.png"), file("c.png")],
      STUDIO_MAX_ATTACHMENTS - 1,
    );
    expect(plan.accepted.map((entry) => entry.name)).toEqual(["a.png"]);
    expect(plan.limitSkipped).toBe(2);
  });

  it("reports invalid files separately without consuming upload slots", () => {
    const plan = planStudioAttachments(
      [
        new File(["x"], "sheet.txt", { type: "text/plain" }),
        new File([], "empty.png", { type: "image/png" }),
        file("ok.png"),
      ],
      STUDIO_MAX_ATTACHMENTS,
    );
    expect(plan.accepted).toEqual([]);
    expect(plan.rejected.map((entry) => entry.code)).toEqual([
      "unsupported_type",
      "empty_file",
    ]);
    expect(plan.limitSkipped).toBe(1);
  });
});

describe("uploadStudioAttachment", () => {
  it("sends the reviewed presign, PUT and finalize payloads and returns the asset id", async () => {
    const { fetcher, calls } = transport({
      "/api/assets/presign": () => presignBody(),
      "https://storage.example.test/put": () =>
        new Response(null, { status: 200 }),
      "/api/assets/finalize": () =>
        Response.json({ assetId: "asset_1" }, { status: 201 }),
    });
    const upload = file("photo.png", "image/png", 7);

    const result = await uploadStudioAttachment(upload, {
      fetcher,
      digest: async () => SHA,
    });

    expect(result).toEqual({ assetId: "asset_1" });
    expect(calls).toHaveLength(3);

    expect(calls[0]?.url).toBe("/api/assets/presign");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toMatchObject({
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      fileName: "photo.png",
      mimeType: "image/png",
      size: 7,
    });

    expect(calls[1]?.url).toBe("https://storage.example.test/put");
    expect(calls[1]?.init.method).toBe("PUT");
    expect(calls[1]?.init.body).toBe(upload);

    expect(calls[2]?.url).toBe("/api/assets/finalize");
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      key: "ws/ws_test/sources/k/photo.png",
      mimeType: "image/png",
      size: 7,
      sha256: SHA,
    });
  });

  it("fails honestly when presign, the PUT or finalize fails", async () => {
    const cases: Array<Record<string, () => Response>> = [
      { "/api/assets/presign": () => new Response(null, { status: 500 }) },
      {
        "/api/assets/presign": () => presignBody(),
        "https://storage.example.test/put": () =>
          new Response(null, { status: 403 }),
      },
      {
        "/api/assets/presign": () => presignBody(),
        "https://storage.example.test/put": () =>
          new Response(null, { status: 200 }),
        "/api/assets/finalize": () => new Response(null, { status: 500 }),
      },
    ];
    for (const handlers of cases) {
      const { fetcher } = transport(handlers);
      await expect(
        uploadStudioAttachment(file(), { fetcher, digest: async () => SHA }),
      ).rejects.toMatchObject({
        name: "StudioAttachmentError",
        code: "failed",
        copyKey: "studio.composer.attachment.failed",
      });
    }
  });

  it("rejects an unsupported file before any transport call", async () => {
    const { fetcher, calls } = transport({});
    const unsupported = new File(["hello"], "notes.txt", {
      type: "text/plain",
    });
    await expect(
      uploadStudioAttachment(unsupported, { fetcher }),
    ).rejects.toMatchObject({
      name: "StudioAttachmentError",
      code: "unsupported_type",
      copyKey: "studio.composer.attachment.unsupported",
    });
    expect(calls).toEqual([]);
  });

  it("honours cancellation before the upload starts", async () => {
    const { fetcher, calls } = transport({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadStudioAttachment(file(), { fetcher, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "StudioAttachmentError",
      code: "cancelled",
      copyKey: "studio.composer.attachment.cancelled",
    });
    expect(calls).toEqual([]);
  });

  it("honours cancellation between presign and the byte upload", async () => {
    const controller = new AbortController();
    const { fetcher, calls } = transport({
      "/api/assets/presign": () => {
        controller.abort();
        return presignBody();
      },
      "https://storage.example.test/put": () =>
        new Response(null, { status: 200 }),
      "/api/assets/finalize": () => Response.json({ assetId: "asset_1" }),
    });
    await expect(
      uploadStudioAttachment(file(), {
        fetcher,
        digest: async () => SHA,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "StudioAttachmentError",
      code: "cancelled",
    });
    expect(calls.map((call) => call.url)).toEqual(["/api/assets/presign"]);
  });

  it("never uses the global fetch when a transport is injected", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const { fetcher } = transport({
      "/api/assets/presign": () => presignBody(),
      "https://storage.example.test/put": () =>
        new Response(null, { status: 200 }),
      "/api/assets/finalize": () => Response.json({ assetId: "asset_1" }),
    });
    await uploadStudioAttachment(file(), {
      fetcher,
      digest: async () => SHA,
    });
    expect(globalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("exposes only typed errors, not provider or response text", async () => {
    const { fetcher } = transport({
      "/api/assets/presign": () =>
        Response.json({ message: "bucket arn kid leak" }, { status: 403 }),
    });
    const failure = await uploadStudioAttachment(file(), { fetcher }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StudioAttachmentError);
    expect(String((failure as Error).message)).toBe("failed");
    expect(JSON.stringify(failure)).not.toContain("bucket");
  });
});
