// @vitest-environment happy-dom
/**
 * Retrying after one file of several fails.
 *
 * The form tells the operator, in its own copy, that "成功上傳的檔案不會在重試
 * 時重複上傳". It was not true. `createListingDraft` collected asset ids into a
 * local array and threw on the first failure, so the array went out of scope;
 * the form then reset every row from `uploading` back to `ready`, because a
 * status string was all it kept. A second photo failing therefore cost the
 * operator the first photo's bytes again -- over the connection that had just
 * proved unreliable -- and left the first upload orphaned in the bucket.
 *
 * These cases drive the real component against a stubbed fetch, so they fail if
 * any link in form -> createListingDraft -> uploadSourceAsset drops progress.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

import { ListingIntakeClient } from "./listing-intake-client.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  push.mockReset();
  refresh.mockReset();
});

function png(name: string): File {
  return new File([name], name, { type: "image/png" });
}

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(ListingIntakeClient));
  });
  return container;
}

async function choose(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>("#listing-files")!;
  const list = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: files[Symbol.iterator].bind(files),
  } as unknown as FileList;
  files.forEach((file, index) => {
    (list as unknown as Record<number, File>)[index] = file;
  });
  Object.defineProperty(input, "files", { value: list, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function submit(container: HTMLElement) {
  const form = container.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

/** Flush React work until `condition` holds, rather than a fixed tick count. */
async function settleUntil(condition: () => boolean, timeoutMs = 5_000) {
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

/**
 * A fetch that answers presign, PUT, finalize and create, and can be told to
 * fail one leg. Requests are recorded so a retry can be compared against them.
 */
function intakeFetcher(options: {
  failUploadFor?: string;
  failCreateOnce?: boolean;
}) {
  const calls: Array<{ url: string; method: string }> = [];
  let presigns = 0;
  let finalizes = 0;
  let creates = 0;

  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });

      if (url === "/api/assets/presign") {
        presigns += 1;
        return Response.json(
          {
            key: `ws/ws_opak/sources/${presigns}/photo.png`,
            uploadUrl: `https://storage.example/upload-${presigns}`,
          },
          { status: 201 },
        );
      }

      if (url.startsWith("https://storage.example/")) {
        const body = init?.body;
        const name = body instanceof File ? body.name : "";
        if (options.failUploadFor === name) {
          return Response.json({ message: "Upload rejected" }, { status: 403 });
        }
        return new Response(null, { status: 200 });
      }

      if (url === "/api/assets/finalize") {
        finalizes += 1;
        return Response.json(
          { assetId: `00000000-0000-4000-8000-00000000030${finalizes}` },
          { status: 201 },
        );
      }

      if (url === "/api/listings") {
        creates += 1;
        if (options.failCreateOnce && creates === 1) {
          return Response.json(
            { message: "Queue unavailable" },
            { status: 503 },
          );
        }
        return Response.json(
          {
            listing: { id: "00000000-0000-4000-8000-000000000101" },
            processing: { state: "queued", jobId: "job_1", errorCode: null },
          },
          { status: 201 },
        );
      }

      throw new Error(`unexpected request: ${url}`);
    });

  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    calls,
    uploadsOf(name: string) {
      return fetcher.mock.calls.filter(
        ([, init]) =>
          init?.body instanceof File && (init.body as File).name === name,
      ).length;
    },
  };
}

describe("retrying an intake after one file fails", () => {
  it("does not re-send a file that already uploaded", async () => {
    const first = intakeFetcher({ failUploadFor: "back.png" });
    const container = await mount();
    await choose(container, [png("front.png"), png("back.png")]);

    await submit(container);
    await settleUntil(
      () => container.textContent?.includes("Upload rejected") === true,
    );

    // front.png uploaded; back.png was refused. No draft was created.
    expect(first.uploadsOf("front.png")).toBe(1);
    expect(container.querySelectorAll(".file-uploaded")).toHaveLength(1);
    expect(container.textContent).toContain("重試只會上傳其餘檔案");

    // The bucket stops refusing, and the operator clicks again.
    const retry = intakeFetcher({});
    await submit(container);
    await settleUntil(() => push.mock.calls.length >= 1);

    // The whole point: front.png's bytes are not sent a second time.
    expect(retry.uploadsOf("front.png")).toBe(0);
    expect(retry.uploadsOf("back.png")).toBe(1);
    expect(
      retry.calls.filter((call) => call.url === "/api/assets/presign"),
    ).toHaveLength(1);
    expect(push).toHaveBeenCalledWith(
      "/listings/00000000-0000-4000-8000-000000000101?processing=queued",
    );
  });

  it("keeps both uploads when only the create call fails", async () => {
    // Every file is finalized and the listing POST is what failed. Re-uploading
    // here would be pure waste: the assets already exist and are unattached.
    intakeFetcher({ failCreateOnce: true });
    const container = await mount();
    await choose(container, [png("front.png"), png("back.png")]);

    await submit(container);
    await settleUntil(
      () => container.textContent?.includes("Queue unavailable") === true,
    );

    expect(container.querySelectorAll(".file-uploaded")).toHaveLength(2);

    const retry = intakeFetcher({});
    await submit(container);
    await settleUntil(() => push.mock.calls.length >= 1);

    expect(retry.uploadsOf("front.png")).toBe(0);
    expect(retry.uploadsOf("back.png")).toBe(0);
    // One call, and it is the create it failed on.
    expect(retry.calls).toEqual([{ url: "/api/listings", method: "POST" }]);
  });

  it("reuses the same asset ids, so the replayed create is recognised", async () => {
    // The create route treats the asset set as the natural key for a replay.
    // Re-uploading would mint new ids, and the replay would then look like a
    // different listing built from different files.
    intakeFetcher({ failCreateOnce: true });
    const container = await mount();
    await choose(container, [png("front.png")]);

    await submit(container);
    await settleUntil(
      () => container.textContent?.includes("Queue unavailable") === true,
    );

    const retry = intakeFetcher({});
    await submit(container);
    await settleUntil(() => push.mock.calls.length >= 1);

    const body = retry.fetcher.mock.calls[0]?.[1]?.body;
    expect(JSON.parse(String(body)).sourceAssetIds).toEqual([
      "00000000-0000-4000-8000-000000000301",
    ]);
  });
});
