// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

import {
  createListingDraft,
  ListingIntakeClient,
} from "./listing-intake-client.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("names object storage when the browser refuses the cross-origin upload", async () => {
    const file = new File(["bottle"], "bottle.png", { type: "image/png" });
    // What a blocked CORS preflight actually produces.
    const blocked = new TypeError("Failed to fetch");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { key: "key-1", uploadUrl: "https://storage.example/upload-1" },
          { status: 201 },
        ),
      )
      .mockRejectedValueOnce(blocked);

    const outcome = await createListingDraft(
      { files: [file], note: "" },
      { fetcher, digest: async () => "a".repeat(64) },
    ).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(Error);
    const failure = outcome as Error;
    expect(failure.message).toContain("object storage");
    expect(failure.message).not.toBe("Failed to fetch");
    expect(failure.cause).toBe(blocked);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [0, "prepare the upload"],
    [2, "record the uploaded file"],
    [3, "create the draft"],
  ])(
    "attributes an unreachable request at call %i to its own step",
    async (failingCall, expected) => {
      const file = new File(["bottle"], "bottle.png", { type: "image/png" });
      const responses = [
        Response.json(
          { key: "key-1", uploadUrl: "https://storage.example/upload-1" },
          { status: 201 },
        ),
        new Response(null, { status: 200 }),
        Response.json({ assetId: "asset-1" }, { status: 201 }),
      ];
      let call = -1;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        call += 1;
        if (call === failingCall) throw new TypeError("Failed to fetch");
        return responses[call] ?? new Response(null, { status: 200 });
      });

      const outcome = await createListingDraft(
        { files: [file], note: "" },
        { fetcher, digest: async () => "a".repeat(64) },
      ).catch((error: unknown) => error);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(expected);
    },
  );
});

const intakeRoots: Root[] = [];

async function mountIntake() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  intakeRoots.push(root);
  await act(async () => {
    root.render(createElement(ListingIntakeClient));
  });
  return { container, root };
}

/** Flushes React work until `condition` holds, instead of a fixed tick count. */
async function settleUntil(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the intake flow to settle");
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function navigationFetcher(state: "queued" | "retry_required") {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        {
          key: "workspaces/ws_opak/assets/file-1",
          uploadUrl: "https://storage.example/upload-1",
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
          listing: { id: "00000000-0000-4000-8000-000000000101" },
          processing: {
            state,
            jobId: state === "queued" ? "job_1" : null,
            errorCode: state === "retry_required" ? "queue_unavailable" : null,
          },
        },
        { status: 201 },
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("ListingIntakeClient navigation", () => {
  beforeEach(() => {
    push.mockReset();
    refresh.mockReset();
  });

  afterEach(async () => {
    for (const root of intakeRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it.each(["queued", "retry_required"] as const)(
    "navigates the rendered form to the listing with %s processing state",
    async (state) => {
      const fetcher = navigationFetcher(state);
      const { container } = await mountIntake();
      const input =
        container.querySelector<HTMLInputElement>('input[type="file"]');
      const form = container.querySelector("form");
      expect(input).not.toBeNull();
      expect(form).not.toBeNull();
      Object.defineProperty(input!, "files", {
        configurable: true,
        value: [new File(["bottle"], "bottle.png", { type: "image/png" })],
      });

      await act(async () => {
        input!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        form!.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      // Submit chains presign -> upload -> finalize -> create, so the number of
      // microtask turns it needs is not fixed. Counting a set number of flushes
      // made this assertion fail whenever the suite ran under parallel load.
      await settleUntil(
        () => fetcher.mock.calls.length >= 4 && push.mock.calls.length >= 1,
      );

      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(push).toHaveBeenCalledWith(
        "/listings/00000000-0000-4000-8000-000000000101?processing=" + state,
      );
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );
});
