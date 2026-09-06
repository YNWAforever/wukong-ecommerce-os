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
