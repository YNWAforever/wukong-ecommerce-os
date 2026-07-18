// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyListingFields,
  ListingReviewClient,
  mapListingView,
  resolveListingViewState,
  type ListingViewResponse,
} from "./listing-review-client.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const response: ListingViewResponse = {
  listingId: "00000000-0000-4000-8000-000000000101",
  status: "in_review",
  activeVersion: {
    id: "00000000-0000-4000-8000-000000000201",
    sequence: 2,
    content: {
      sku: "OPAK-001",
      producer: "Opak Cellar",
      productType: "wine",
      country: "Germany",
      region: "Mosel",
      vintage: 2024,
      grapeVarieties: ["Riesling"],
      volumeMl: 750,
      abvPercent: 12.5,
      packQuantity: 1,
      priceHkd: 288,
      stockQuantity: null,
      criticScores: [],
      awards: [],
      title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
      description: {
        en: "Dry Mosel Riesling.",
        "zh-Hant": "摩澤爾乾型雷司令。",
      },
      seo: {
        title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
        description: {
          en: "Dry Mosel Riesling.",
          "zh-Hant": "摩澤爾乾型雷司令。",
        },
      },
      tags: ["wine"],
      imageAssetIds: [],
    },
  },
  evidence: [
    {
      field: "producer",
      sourceAssetId: "asset-1",
      page: 1,
      excerpt: "Producer: Opak Cellar",
      confidence: 0.96,
    },
  ],
  flags: [
    {
      id: "description:health_claim:0",
      field: "description",
      rule: "health_claim",
      severity: "blocking",
      status: "open",
      resolutionReason: null,
    },
  ],
  connection: "connected",
  delivery: null,
  queueStatus: null,
  permissions: {
    canProcess: true,
    canEdit: true,
    canResolveFlags: true,
    canApprove: true,
    canDeliver: true,
  },
};

describe("listing review client mapping", () => {
  it("maps the live API snapshot into editable bilingual fields and stable flags", () => {
    const mapped = mapListingView(response);

    expect(mapped.model).toMatchObject({
      id: response.listingId,
      versionId: response.activeVersion?.id,
      status: "in_review",
      title: "Opak 雷司令",
    });
    expect(mapped.model.fields).toContainEqual(
      expect.objectContaining({
        key: "producer",
        value: "Opak Cellar",
        confidence: 0.96,
        evidence: expect.objectContaining({ source: "asset-1" }),
      }),
    );
    expect(mapped.model.fields).toContainEqual(
      expect.objectContaining({ key: "titleEn", value: "Opak Riesling" }),
    );
    expect(mapped.model.fields).toContainEqual(
      expect.objectContaining({ key: "titleZhHant", value: "Opak 雷司令" }),
    );
    expect(mapped.model.blockingFlags).toEqual([
      expect.objectContaining({
        id: "description:health_claim:0",
        code: "health_claim",
        field: "description",
        status: "open",
      }),
    ]);
    expect(mapped.delivery).toMatchObject({
      connection: "connected",
      canReview: true,
      status: "in_review",
    });
  });

  it("applies edited scalar and localized fields without losing canonical metadata", () => {
    const { model } = mapListingView(response);
    const edited = model.fields.map((field) => {
      if (field.key === "priceHkd") return { ...field, value: "318" };
      if (field.key === "titleZhHant")
        return { ...field, value: "Opak 精選雷司令" };
      if (field.key === "stockQuantity") return { ...field, value: "12" };
      return field;
    });

    const listing = applyListingFields(response.activeVersion!.content, edited);

    expect(listing.priceHkd).toBe(318);
    expect(listing.stockQuantity).toBe(12);
    expect(listing.title).toEqual({
      en: "Opak Riesling",
      "zh-Hant": "Opak 精選雷司令",
    });
    expect(listing.seo).toEqual(response.activeVersion!.content.seo);
    expect(listing.tags).toEqual(["wine"]);
  });

  it("rejects a response without an active AI-generated version", () => {
    expect(() => mapListingView({ ...response, activeVersion: null })).toThrow(
      "Listing is not ready for review",
    );
  });

  it.each(["received", "processing", "needs_info", "failed"] as const)(
    "renders %s without an active AI version as processing state",
    (status) => {
      expect(
        resolveListingViewState({
          snapshotStatus: status,
          hasSnapshot: true,
          hasMappedView: false,
          loadError: null,
          mappingError: null,
        }),
      ).toEqual({ kind: "processing", status });
    },
  );

  it("shows the mapping error instead of an endless loading state", () => {
    expect(
      resolveListingViewState({
        snapshotStatus: "in_review",
        hasSnapshot: true,
        hasMappedView: false,
        loadError: null,
        mappingError: "Listing is not ready for review",
      }),
    ).toEqual({
      kind: "error",
      message: "Listing is not ready for review",
    });
  });
});

function processingSnapshot(
  status: "received" | "processing" | "needs_info" | "failed",
): ListingViewResponse {
  return {
    ...response,
    status,
    activeVersion: null,
    evidence: [],
    flags: [],
    delivery: null,
    queueStatus: null,
  };
}

const mountedRoots: Root[] = [];

async function settleEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountReview(initialProcessing?: "queued" | "retry_required") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      createElement(ListingReviewClient, {
        listingId: response.listingId,
        initialProcessing,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await settleEffects();
  return { container, root };
}

async function unmountReview(root: Root) {
  await act(async () => root.unmount());
  const index = mountedRoots.indexOf(root);
  if (index >= 0) mountedRoots.splice(index, 1);
}

function processingFetcher() {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("ListingReviewClient processing orchestration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["queued", "已加入處理佇列 · Queued for processing", false],
    ["retry_required", "尚未開始處理 · Processing not started", true],
  ] as const)(
    "binds initial %s state to the processing panel",
    async (initialProcessing, copy, hasStartButton) => {
      const fetcher = processingFetcher().mockResolvedValue(
        Response.json(processingSnapshot("received")),
      );

      const { container } = await mountReview(initialProcessing);

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain(copy);
      expect(container.textContent?.includes("Start processing")).toBe(
        hasStartButton,
      );
    },
  );

  it("posts Start processing and reloads into the persisted transition", async () => {
    const fetcher = processingFetcher()
      .mockResolvedValueOnce(Response.json(processingSnapshot("received")))
      .mockResolvedValueOnce(
        Response.json(
          { processing: { state: "queued", jobId: "job_1" } },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(Response.json(processingSnapshot("processing")));
    const { container } = await mountReview("retry_required");
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.includes("Start processing"),
    );
    expect(button).toBeDefined();

    await act(async () => {
      button!.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/listings/00000000-0000-4000-8000-000000000101/process",
      { method: "POST" },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "/api/listings/00000000-0000-4000-8000-000000000101",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(container.textContent).toContain(
      "AI 正在建立商品資料 · AI processing",
    );
    expect(container.textContent).not.toContain("Start processing");
  });

  it("polls every three seconds for received and processing, then stops at failed", async () => {
    const fetcher = processingFetcher()
      .mockResolvedValueOnce(Response.json(processingSnapshot("received")))
      .mockResolvedValueOnce(Response.json(processingSnapshot("processing")))
      .mockResolvedValueOnce(Response.json(processingSnapshot("failed")));
    const { container } = await mountReview("queued");

    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("AI processing");

    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("Processing failed");

    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["needs_info", "failed"] as const)(
    "does not poll persisted %s state",
    async (status) => {
      const fetcher = processingFetcher().mockResolvedValue(
        Response.json(processingSnapshot(status)),
      );
      await mountReview();

      await act(async () => vi.advanceTimersByTimeAsync(9_000));

      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("clears the polling interval on unmount", async () => {
    const fetcher = processingFetcher().mockResolvedValue(
      Response.json(processingSnapshot("received")),
    );
    const { root } = await mountReview("queued");

    await unmountReview(root);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("clears a polling warning after the next successful refresh", async () => {
    const fetcher = processingFetcher()
      .mockResolvedValueOnce(Response.json(processingSnapshot("received")))
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(Response.json(processingSnapshot("processing")));
    const { container } = await mountReview("queued");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("temporary network failure");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain("temporary network failure");
    expect(container.textContent).toContain("AI processing");
  });
});
