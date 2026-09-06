// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect, vi } from "vitest";
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
import { ProductShotReview } from "./product-shot-review";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const base = {
  enabled: true,
  state: "candidate_ready",
  attemptId: "attempt",
  expectedVersionId: "version",
  sourceAssetId: "source",
  sourcePreviewUrl: "/original.png",
  candidatePreviewUrl: "/exact.jpg",
  candidateDigest: "a".repeat(64),
  lowResolution: true,
  sources: [{ assetId: "source", previewUrl: "/original.png" }],
  allowedActions: ["select_source", "approve"],
};
async function mount(view: any = base) {
  const fetcher = vi.fn(async () => Response.json(view));
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(ProductShotReview, {
        listingId: "listing",
        canOperate: true,
        canApprove: true,
      }),
    );
  });
  return fetcher;
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});
describe("exact image review", () => {
  it("uploads and attaches one replacement image before selecting it on the same draft", async () => {
    const replacement = new File(["replacement"], "replacement.png", {
      type: "image/png",
    });
    let reads = 0;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/assets/presign") {
        return Response.json(
          {
            key: "ws/ws/sources/replacement/input.png",
            uploadUrl: "https://storage.example/replacement",
          },
          { status: 201 },
        );
      }
      if (url === "https://storage.example/replacement") {
        return new Response(null, { status: 200 });
      }
      if (url === "/api/assets/finalize") {
        return Response.json(
          { assetId: "10000000-0000-4000-8000-000000000099" },
          { status: 201 },
        );
      }
      if (url === "/api/listings/listing/product-shot/source") {
        return Response.json({ state: "queued", attemptId: "next-attempt" });
      }
      reads += 1;
      return Response.json(
        reads === 1
          ? base
          : {
              ...base,
              state: "queued",
              attemptId: "next-attempt",
              sourceAssetId: "10000000-0000-4000-8000-000000000099",
              sourcePreviewUrl: "/replacement.png",
              candidatePreviewUrl: null,
              candidateDigest: null,
              sources: [
                ...base.sources,
                {
                  assetId: "10000000-0000-4000-8000-000000000099",
                  previewUrl: "/replacement.png",
                },
              ],
            },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(ProductShotReview, {
          listingId: "listing",
          canOperate: true,
          canApprove: true,
        }),
      );
    });

    const replaceButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Replace photo",
    )!;
    replaceButton.focus();
    expect(document.activeElement).toBe(replaceButton);
    const input = host.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/jpeg,image/png,image/webp"]',
    );
    expect(input).not.toBeNull();
    const transfer = new DataTransfer();
    transfer.items.add(replacement);
    input!.files = transfer.files;
    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url]) => url === "/api/listings/listing/product-shot/source",
        ),
      ).toBe(true),
    );

    expect(fetcher).toHaveBeenCalledWith(
      "/api/assets/presign",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          fileName: "replacement.png",
          mimeType: "image/png",
          size: replacement.size,
        }),
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://storage.example/replacement",
      expect.objectContaining({ method: "PUT", body: replacement }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/api/listings/listing/product-shot/source",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sourceAssetId: "10000000-0000-4000-8000-000000000099",
          expectedVersionId: "version",
        }),
      }),
    );
    expect(
      host.querySelector('img[alt="Original photo"]')?.getAttribute("src"),
    ).toBe("/replacement.png");
  });

  it("keeps the current draft image when replacement upload fails", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/assets/presign") {
        return Response.json(
          {
            key: "ws/ws/sources/replacement/input.png",
            uploadUrl: "https://storage.example/replacement",
          },
          { status: 201 },
        );
      }
      if (url === "https://storage.example/replacement") {
        return Response.json({ message: "Upload rejected" }, { status: 403 });
      }
      return Response.json(base);
    });
    vi.stubGlobal("fetch", fetcher);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(ProductShotReview, {
          listingId: "listing",
          canOperate: true,
          canApprove: true,
        }),
      );
    });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["replacement"], "replacement.png", { type: "image/png" }),
    );
    input.files = transfer.files;
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')).not.toBeNull(),
    );

    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).endsWith("/product-shot/source"),
      ),
    ).toBe(false);
    expect(
      host.querySelector('img[alt="Original photo"]')?.getAttribute("src"),
    ).toBe("/original.png");
  });

  it("reloads a committed attachment after its source request response fails", async () => {
    const replacementId = "10000000-0000-4000-8000-000000000099";
    let reads = 0;
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === "/api/assets/presign") {
        return Response.json(
          {
            key: "ws/ws/sources/replacement/input.png",
            uploadUrl: "https://storage.example/replacement",
          },
          { status: 201 },
        );
      }
      if (url === "https://storage.example/replacement")
        return new Response(null, { status: 200 });
      if (url === "/api/assets/finalize")
        return Response.json({ assetId: replacementId }, { status: 201 });
      if (
        url === "/api/listings/listing/product-shot/source" &&
        options?.method === "POST"
      )
        return Response.json({ code: "queue_unavailable" }, { status: 503 });
      reads += 1;
      return Response.json(
        reads === 1
          ? base
          : {
              ...base,
              sources: [
                ...base.sources,
                { assetId: replacementId, previewUrl: "/replacement.png" },
              ],
            },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(ProductShotReview, {
          listingId: "listing",
          canOperate: true,
          canApprove: true,
        }),
      );
    });
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(["replacement"], "replacement.png", { type: "image/png" }),
    );
    input.files = transfer.files;
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alert"]')).not.toBeNull(),
    );
    const reload = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Reload",
    )!;
    await act(async () => reload.click());

    expect(
      host.querySelector(`input[type="radio"][value="${replacementId}"]`),
    ).not.toBeNull();
    expect(host.textContent).toContain("Use this photo");
  });

  it("shows original and persisted JPEG with accessible white-only approval", async () => {
    const fetcher = await mount();
    expect(
      host.querySelector('img[alt="Original photo"]')?.getAttribute("src"),
    ).toBe("/original.png");
    expect(
      host
        .querySelector('img[alt="Final white-background image"]')
        ?.getAttribute("src"),
    ).toBe("/exact.jpg");
    expect(host.textContent).toContain("Low-resolution");
    expect(host.textContent).not.toContain("Brand background");
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Accept this exact image",
    )!;
    await act(async () => button.click());
    const post = fetcher.mock.calls.find(
      (c: any) => c[1]?.method === "POST",
    ) as any;
    expect(JSON.parse(post[1].body)).toEqual({
      attemptId: "attempt",
      expectedVersionId: "version",
      candidateDigest: "a".repeat(64),
    });
  });
  it("requires a main-photo choice when several originals exist", async () => {
    const fetcher = await mount({
      ...base,
      state: "source_selection_required",
      attemptId: null,
      candidatePreviewUrl: null,
      candidateDigest: null,
      sources: [
        { assetId: "one", previewUrl: "/one" },
        { assetId: "two", previewUrl: "/two" },
      ],
      allowedActions: ["select_source"],
    });
    expect(
      fetcher.mock.calls.filter((c: any) => c[1]?.method === "POST"),
    ).toHaveLength(0);
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(2);
  });
  it("requires explicit charge acknowledgement before a fresh unknown attempt", async () => {
    const fetcher = await mount({
      ...base,
      state: "outcome_unknown",
      candidatePreviewUrl: null,
      allowedActions: ["fresh_attempt", "select_source"],
    });
    const fresh = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Start a fresh attempt",
    )!;
    expect(fresh.disabled).toBe(true);
    const check = host.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => check.click());
    await act(async () => fresh.click());
    const post = fetcher.mock.calls.find(
      (c: any) => c[1]?.method === "POST",
    ) as any;
    expect(JSON.parse(post[1].body).explicitFreshAttempt).toBe(true);
  });
  it("automatically prepares only a persisted cutout and stops automatic retry after failure", async () => {
    let reads = 0;
    const fetcher = vi.fn(async (_url: any, options: any) => {
      if (options?.method === "POST")
        return Response.json({ code: "invalid_image" }, { status: 422 });
      reads++;
      return Response.json({
        ...base,
        state: "cutout_ready",
        candidatePreviewUrl: null,
        allowedActions: ["prepare"],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(ProductShotReview, {
          listingId: "listing",
          canOperate: true,
          canApprove: true,
        }),
      ),
    );
    expect(
      fetcher.mock.calls.filter((c) => c[1]?.method === "POST"),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.find((c) => c[1]?.method === "POST")?.[0],
    ).toContain("/prepare");
    expect(host.textContent).toContain("Retry preparation");
  });
});

it("keeps an explicit request retry after automatic source request fails", async () => {
  const fetcher = vi.fn(async (_url: any, options: any) =>
    options?.method === "POST"
      ? Response.json({ code: "queue_unavailable" }, { status: 503 })
      : Response.json({
          ...base,
          state: "not_requested",
          attemptId: null,
          allowedActions: ["request"],
          candidatePreviewUrl: null,
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ProductShotReview, {
        listingId: "listing",
        canOperate: true,
        canApprove: true,
      }),
    ),
  );
  expect(
    [...host.querySelectorAll("button")].some(
      (b) => b.textContent === "Request product image",
    ),
  ).toBe(true);
});
it("aborts old listing reads and never renders an old candidate after navigation", async () => {
  let resolveOld!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn(async (url: any, options: any) => {
    if (String(url).includes("/old/")) {
      signal = options.signal;
      return new Promise<Response>((resolve) => {
        resolveOld = resolve;
      });
    }
    return Response.json({ ...base, candidatePreviewUrl: "/new.jpg" });
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(ProductShotReview, {
        listingId: "old",
        canOperate: true,
        canApprove: true,
      }),
    ),
  );
  await act(async () =>
    root.render(
      createElement(ProductShotReview, {
        listingId: "new",
        canOperate: true,
        canApprove: true,
      }),
    ),
  );
  await act(async () =>
    resolveOld(Response.json({ ...base, candidatePreviewUrl: "/stale.jpg" })),
  );
  expect(signal?.aborted).toBe(true);
  expect(
    host
      .querySelector('img[alt="Final white-background image"]')
      ?.getAttribute("src"),
  ).toBe("/new.jpg");
});

it.each(["not_requested", "cutout_ready"])(
  "recovers the initial GET error and resumes automatic %s work",
  async (state) => {
    let reads = 0;
    const fetcher = vi.fn(async (_url: any, options: any) => {
      if (options?.method === "POST") return Response.json({});
      if (++reads === 1) return Response.json({}, { status: 503 });
      return Response.json(
        reads === 2
          ? {
              ...base,
              state,
              attemptId: state === "not_requested" ? null : "attempt",
              candidatePreviewUrl: null,
            }
          : base,
      );
    });
    vi.stubGlobal("fetch", fetcher);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(ProductShotReview, {
          listingId: "listing",
          canOperate: true,
          canApprove: true,
        }),
      ),
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Unable to load",
    );
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const posts = fetcher.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(
      `/api/listings/listing/product-shot${state === "cutout_ready" ? "/prepare" : ""}`,
    );
    expect(JSON.parse(posts[0]![1].body)).toMatchObject({
      expectedVersionId: "version",
      ...(state === "cutout_ready"
        ? { attemptId: "attempt" }
        : { sourceAssetId: "source", explicitFreshAttempt: false }),
    });
  },
);

it("does not clear the current listing error when an old retry succeeds after navigation", async () => {
  let oldReads = 0;
  let resolveRetry!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/old/") && ++oldReads > 1)
        return new Promise<Response>((r) => {
          resolveRetry = r;
        });
      return Response.json({}, { status: 503 });
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (listingId: string) =>
    root.render(
      createElement(ProductShotReview, {
        listingId,
        canOperate: true,
        canApprove: true,
      }),
    );
  await act(async () => render("old"));
  await act(async () => host.querySelector("button")!.click());
  await act(async () => render("new"));
  await act(async () => resolveRetry(Response.json(base)));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Unable to load",
  );
  expect(host.querySelector("img")).toBeNull();
});
