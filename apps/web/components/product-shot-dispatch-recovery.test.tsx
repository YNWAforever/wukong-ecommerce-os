// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
const upload = vi.hoisted(() =>
  vi.fn(async () => ({
    assetId: "10000000-0000-4000-8000-000000000099",
    key: "ws/ws/sources/replacement/input.png",
  })),
);
vi.mock("../lib/locale-context", () => ({ useLocale: () => "en" }));
vi.mock("../lib/browser-asset-upload", () => ({ uploadSourceAsset: upload }));
import { ProductShotReview } from "./product-shot-review";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const SOURCE = "10000000-0000-4000-8000-000000000099";
const ATTEMPT = "10000000-0000-4000-8000-000000000090";
const VERSION = "10000000-0000-4000-8000-000000000020";
function view(state = "queued") {
  return {
    enabled: true,
    state,
    attemptId: ATTEMPT,
    expectedVersionId: VERSION,
    inputRevision: 3,
    sourceAssetId: SOURCE,
    sourcePreviewUrl: "/replacement.png",
    candidatePreviewUrl:
      state === "candidate_ready" || state === "approved"
        ? "/new-final.jpg"
        : null,
    candidateDigest: "a".repeat(64),
    lowResolution: false,
    sources: [{ assetId: SOURCE, previewUrl: "/replacement.png" }],
    allowedActions: state === "queued" ? ["retry_queue"] : ["approve"],
    errorCode: null,
  };
}
const mounted: Array<{
  root: ReturnType<typeof createRoot>;
  host: HTMLDivElement;
}> = [];
async function mount(
  fetcher: typeof fetch,
  listingId = "listing",
  canOperate = true,
) {
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(
      <ProductShotReview
        listingId={listingId}
        canOperate={canOperate}
        canApprove={canOperate}
      />,
    );
  });
  return { root, host };
}
async function replace(host: HTMLElement) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const transfer = new DataTransfer();
  transfer.items.add(
    new File(["replacement"], "replacement.png", { type: "image/png" }),
  );
  input.files = transfer.files;
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function retryButton(host: HTMLElement) {
  return [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry dispatch",
  );
}
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
  upload.mockClear();
  vi.unstubAllGlobals();
});

describe("product-shot dispatch recovery", () => {
  it("refreshes a committed replacement after 503 and retries only the observed attempt", async () => {
    let state = "approved";
    let sourcePosts = 0;
    const requests: Record<string, unknown>[] = [];
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, options?: RequestInit) => {
        if (String(url).endsWith("/source") && options?.method === "POST") {
          sourcePosts++;
          state = "queued";
          return Response.json(
            { code: "queue_unavailable", message: "PRIVATE_INGRESS_DETAIL" },
            { status: 503 },
          );
        }
        if (options?.method === "POST") {
          requests.push(JSON.parse(String(options.body)));
          state = "candidate_ready";
          return Response.json({ state: "queued", attemptId: ATTEMPT });
        }
        return Response.json(
          state === "approved"
            ? {
                ...view(state),
                sourceAssetId: "old-source",
                sourcePreviewUrl: "/old-source.png",
                attemptId: "old-attempt",
              }
            : view(state),
        );
      },
    );
    const { host } = await mount(fetcher);
    await replace(host);
    expect(
      host.querySelector('img[alt="Original photo"]')?.getAttribute("src"),
    ).toBe("/replacement.png");
    expect(retryButton(host)).toBeDefined();
    expect(requests).toHaveLength(0);
    expect(host.textContent).not.toContain("PRIVATE_INGRESS_DETAIL");
    await act(async () => {
      retryButton(host)!.click();
    });
    expect(requests).toEqual([
      {
        sourceAssetId: SOURCE,
        expectedVersionId: VERSION,
        expectedInputRevision: 3,
        explicitFreshAttempt: false,
        retryAttemptId: ATTEMPT,
      },
    ]);
    expect(sourcePosts).toBe(1);
    expect(upload).toHaveBeenCalledOnce();
    expect(
      host
        .querySelector('img[alt="Final white-background image"]')
        ?.getAttribute("src"),
    ).toBe("/new-final.jpg");
    expect(retryButton(host)).toBeUndefined();
  });

  it("keeps repeated rejections recoverable without upload or automatic re-dispatch", async () => {
    const posts: Record<string, unknown>[] = [];
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, options?: RequestInit) => {
        if (options?.method === "POST") {
          posts.push(JSON.parse(String(options.body)));
          return Response.json({ code: "queue_unavailable" }, { status: 503 });
        }
        return Response.json(view());
      },
    );
    const { host } = await mount(fetcher);
    expect(posts).toHaveLength(0);
    for (let n = 0; n < 2; n++)
      await act(async () => {
        retryButton(host)!.click();
      });
    expect(posts).toHaveLength(2);
    expect(
      posts.every(
        (body) =>
          body.retryAttemptId === ATTEMPT &&
          body.explicitFreshAttempt === false,
      ),
    ).toBe(true);
    expect(retryButton(host)?.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(upload).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Start a fresh attempt");
  });

  it.each(["processing", "outcome_unknown"])(
    "does not offer dispatch retry for %s even with stale action hints",
    async (state) => {
      const fetcher = vi.fn(async () =>
        Response.json({ ...view(state), allowedActions: ["retry_queue"] }),
      );
      const { host } = await mount(fetcher);
      expect(retryButton(host)).toBeUndefined();
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("keeps queued dispatch recovery unavailable to a viewer", async () => {
    const { host } = await mount(
      vi.fn(async () => Response.json(view())),
      "listing",
      false,
    );
    expect(retryButton(host)).toBeUndefined();
  });

  it("does not refresh an old listing or retain its busy state after navigation", async () => {
    let resolveSource!: (response: Response) => void;
    const gets: string[] = [];
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, options?: RequestInit) => {
        if (options?.method === "POST")
          return new Promise<Response>((resolve) => {
            resolveSource = resolve;
          });
        gets.push(String(url));
        return Response.json(view("approved"));
      },
    );
    const { root, host } = await mount(fetcher);
    await replace(host);
    await act(async () => {
      root.render(
        <ProductShotReview listingId="other-listing" canOperate canApprove />,
      );
    });
    await act(async () => {
      resolveSource(
        Response.json({ code: "queue_unavailable" }, { status: 503 }),
      );
    });
    expect(
      gets.filter((url) => url === "/api/listings/listing/product-shot"),
    ).toHaveLength(1);
    const replacement = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Replace photo",
    );
    expect(replacement?.disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
