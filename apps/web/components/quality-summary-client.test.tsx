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
};

describe("QualitySummaryClient", () => {
  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
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
    expect(tileText).toEqual(["42", "10", "32", "$12.50"]);
  });

  it("renders a 6-row table, one row per gap signal, with a human-readable label and its count", async () => {
    stubFetch(SAMPLE_SUMMARY);

    const { container } = await mountClient();

    const rows = Array.from(container.querySelectorAll("tbody tr"));
    expect(rows.length).toBe(6);

    const rowText = rows.map((row) => row.textContent ?? "");
    expect(
      rowText.some(
        (text) => /Untranslated name/i.test(text) && text.includes("5"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) => /Untranslated SEO title/i.test(text) && text.includes("6"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) => /SEO title mirrors name/i.test(text) && text.includes("7"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) =>
          /SEO description mirrors SEO title/i.test(text) && text.includes("8"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) => /Keywords mirror name/i.test(text) && text.includes("9"),
      ),
    ).toBe(true);
    expect(
      rowText.some(
        (text) => /Summary missing/i.test(text) && text.includes("21"),
      ),
    ).toBe(true);
  });

  it("renders a visible error state when the fetch fails", async () => {
    stubFetch({ message: "workspace not found" }, 500);

    const { container } = await mountClient();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Unable to load quality summary",
    );
  });

  it("renders a visible error state when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new Error("network down")),
    );

    const { container } = await mountClient();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "network down",
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
