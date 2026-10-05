// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QualitySummaryClient } from "./quality-summary-client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

async function settleEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountClient() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(createElement(QualitySummaryClient));
    await Promise.resolve();
    await Promise.resolve();
  });
  await settleEffects();
  return { container, root };
}

function stubFetch(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const SAMPLE_SUMMARY = {
  totalAssessed: 42,
  cleanCount: 10,
  hasGapsCount: 32,
  gapCounts: {
    untranslatedName: 5,
    untranslatedSeoTitle: 6,
    seoTitleMirrorsName: 7,
    seoDescriptionMirrorsSeoTitle: 8,
    keywordsMirrorName: 9,
    summaryMissing: 21,
  },
  totalCostUsd: 12.5,
  unknownCostRunCount: 0,
};

describe("QualitySummaryClient", () => {
  it("separates copy signals from facts, current human verification and delivery", async () => {
    stubFetch(SAMPLE_SUMMARY);
    const { container } = await mountClient();
    for (const label of ["文案缺口", "事實證據", "人工核實", "交付條件"])
      expect(
        container.querySelector(`section[aria-label="${label}"]`),
      ).not.toBeNull();
    expect(container.textContent).toContain("無文案缺口訊號");
    expect(container.textContent).toContain("專名相同可能合理");
    expect(container.textContent).toContain("未彙總");
    expect(container.textContent).not.toContain("名稱未翻譯");
    expect(container.querySelector('a[href="/catalog"]')).not.toBeNull();
  });

  it.each(["pending", "failed"] as const)(
    "shows %s projection work and its timestamp without claiming completion",
    async (state) => {
      stubFetch({
        ...SAMPLE_SUMMARY,
        assessmentVersion: "opak-current-content-v1",
        consistency: "revision_aware_projection",
        projection: {
          state,
          asOf: "2026-10-01T12:00:00.000Z",
          stale: true,
          pendingCount: 7,
          failedCount: state === "failed" ? 2 : 0,
        },
      });
      const { container } = await mountClient();
      const status = container.querySelector("[data-quality-projection]");
      expect(status?.textContent).toContain("待重算 7");
      expect(status?.textContent).toContain(
        state === "failed" ? "失敗 2" : "失敗 0",
      );
      expect(status?.textContent).toContain("未完成");
      expect(status?.textContent).not.toContain("已完成");
      expect(
        container.querySelector('time[datetime="2026-10-01T12:00:00.000Z"]'),
      ).not.toBeNull();
    },
  );

  it("links unknown costs only to actual batch or listing lineage and keeps the complete total", async () => {
    const batchId = "10000000-0000-4000-8000-000000000001";
    const listingId = "20000000-0000-4000-8000-000000000001";
    stubFetch({
      ...SAMPLE_SUMMARY,
      unknownCostRunCount: 27,
      unknownCostReferences: {
        asOf: "2026-10-01T12:00:00.000Z",
        total: 27,
        limit: 25,
        hasMore: true,
        items: [
          {
            aiRunId: "30000000-0000-4000-8000-000000000001",
            listingId,
            pipelineRunId: "40000000-0000-4000-8000-000000000001",
            batchId,
            stage: "generate",
            createdAt: "2026-10-01T11:00:00.000Z",
          },
          {
            aiRunId: "30000000-0000-4000-8000-000000000002",
            listingId,
            pipelineRunId: null,
            batchId: null,
            stage: null,
            createdAt: "2026-10-01T11:00:00.000Z",
          },
        ],
      },
    });
    const { container } = await mountClient();
    expect(container.textContent).toContain("另有 27 次執行成本未確認");
    expect(
      container.querySelector(`a[href="/batches/${batchId}"]`),
    ).not.toBeNull();
    expect(
      container.querySelector(`a[href="/listings/${listingId}"]`),
    ).not.toBeNull();
    expect(container.textContent).toContain(
      "30000000-0000-4000-8000-000000000002",
    );
    expect(container.textContent).toContain("未有批次綁定");
    expect(container.textContent).toContain("其餘紀錄仍計入總數");
    expect(container.querySelector('a[href*="/runs/"]')).toBeNull();
    expect(container.querySelector("[data-quality-costs]")).not.toBeNull();
  });

  it("clears visible cached statistics when current membership is denied on refresh", async () => {
    const fetcher = stubFetch(SAMPLE_SUMMARY);
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify(SAMPLE_SUMMARY), { status: 200 }),
    );
    fetcher.mockResolvedValue(new Response("{}", { status: 403 }));
    const { container } = await mountClient();
    expect(container.querySelector(".metric-strip")).not.toBeNull();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settleEffects();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".metric-strip")).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("shows unavailable denominators instead of inventing totals or skipped counts", async () => {
    stubFetch(SAMPLE_SUMMARY);
    const { container } = await mountClient();
    expect(container.textContent).toContain(
      "共 未有資料 個商品，已評估 42 個；未有資料 個未有內容；未有資料 個內容無法評估",
    );
  });

  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("shows unknown charges even when the known subtotal is zero", async () => {
    stubFetch({ ...SAMPLE_SUMMARY, totalCostUsd: 0, unknownCostRunCount: 2 });
    const { container } = await mountClient();
    expect(container.textContent).toContain("已知 AI 成本");
    expect(container.textContent).toContain("另有 2 次執行成本未確認");
  });
  it("omits the unknown-cost notice when all costs are known", async () => {
    stubFetch(SAMPLE_SUMMARY);
    const { container } = await mountClient();
    expect(container.textContent).not.toContain("次執行成本未確認");
  });
  it("fetches /api/quality and renders 4 stat tiles with correct values", async () => {
    const fetcher = stubFetch(SAMPLE_SUMMARY);

    const { container } = await mountClient();

    expect(fetcher).toHaveBeenCalledWith(
      "/api/quality",
      expect.objectContaining({ cache: "no-store" }),
    );

    const tiles = container.querySelectorAll(".metric-value");
    expect(tiles.length).toBe(4);
    const tileText = Array.from(tiles).map((tile) => tile.textContent);
    expect(tileText).toEqual(["42", "10", "32", "US$12.50"]);
  });

  it('exposes each metric tile as a role="group" tied to its visible label', async () => {
    stubFetch(SAMPLE_SUMMARY);

    const { container } = await mountClient();

    const tiles = container.querySelectorAll('.metric-strip > [role="group"]');
    expect(tiles.length).toBe(4);

    const expectedSubstrings = [
      "已評估商品",
      "無文案缺口訊號",
      "有缺口",
      "已知 AI 成本",
    ];

    tiles.forEach((tile, index) => {
      const labelledBy = tile.getAttribute("aria-labelledby");
      expect(labelledBy).not.toBeNull();
      const labelElement = document.getElementById(labelledBy!);
      expect(labelElement?.textContent).toContain(expectedSubstrings[index]);
    });
  });

  it("renders a 6-row table, one row per gap signal, with a human-readable label and its count", async () => {
    stubFetch(SAMPLE_SUMMARY);

    const { container } = await mountClient();

    const rows = Array.from(container.querySelectorAll("tbody tr"));
    expect(rows.length).toBe(6);

    const rowText = rows.map((row) => row.textContent ?? "");
    expect(
      rowText.some(
        (text) => /名稱需檢查用字/i.test(text) && text.includes("5"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) => /SEO 標題需檢查用字/i.test(text) && text.includes("6"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) => /SEO 標題與商品名稱相同/i.test(text) && text.includes("7"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) => /SEO 簡介與 SEO 標題相同/i.test(text) && text.includes("8"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) => /關鍵字與商品名稱相同/i.test(text) && text.includes("9"),
      ),
    ).toBe(true);
    expect(
      rowText.some((text) => /缺少摘要/i.test(text) && text.includes("21")),
    ).toBe(true);
  });

  it("renders a visible error state when the fetch fails", async () => {
    stubFetch({ message: "workspace not found" }, 500);

    const { container } = await mountClient();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "無法載入資料，請重試。",
    );
  });

  it("renders a visible error state when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("network down")),
    );

    const { container } = await mountClient();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "無法載入資料，請重試。",
    );
  });

  it("aborts the in-flight fetch's signal when the component unmounts", async () => {
    // Capture the AbortSignal the component actually passes to fetch, then
    // assert it's aborted once the component unmounts -- exercises the
    // effect's cleanup directly rather than inferring it indirectly (React
    // 18+ no longer warns on a state update after unmount, so a "no console
    // warning fired" assertion would pass even with no cleanup at all).
    let capturedSignal: AbortSignal | undefined;
    const pending = new Promise<Response>(() => {
      // Deliberately never resolves -- the component should still be safe
      // to unmount while this is in flight.
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return pending;
      }) as unknown as typeof fetch,
    );

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(QualitySummaryClient));
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await act(async () => {
      root.unmount();
    });

    expect(capturedSignal?.aborted).toBe(true);

    document.body.innerHTML = "";
  });
});
