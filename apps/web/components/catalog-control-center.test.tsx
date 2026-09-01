// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { CatalogItem, CatalogPage } from "../lib/catalog-contract";
import { CatalogControlCenter } from "./catalog-control-center.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function nativeSet(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function makeItem(
  overrides: Partial<CatalogItem> & { id: string },
): CatalogItem {
  return {
    remoteProductId: `remote-${overrides.id}`,
    origin: "import",
    sku: "OPAK-SKU",
    listingId: null,
    specVersion: "v1",
    title: `Product ${overrides.id}`,
    listingStatus: null,
    openBlockingFlagCount: null,
    needsReview: false,
    needsAttention: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    contentDigest: null,
    ...overrides,
  };
}

function pageResponse(
  items: CatalogItem[],
  overrides: Partial<CatalogPage> = {},
): CatalogPage {
  return {
    items,
    summary: {
      total: 60,
      linked: 10,
      unlinked: 50,
      needsReview: 2,
      needsAttention: 5,
      published: 3,
    },
    page: 1,
    pageSize: 25,
    totalMatching: 60,
    ...overrides,
  };
}

describe("CatalogControlCenter", () => {
  it("drives every fetch through server-side page/pageSize/q/filter params", async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url, "http://localhost");
      calls.push(parsed);

      const page = Number(parsed.searchParams.get("page"));
      const filter = parsed.searchParams.get("filter");
      const q = parsed.searchParams.get("q");

      if (filter === "attention") {
        return Promise.resolve(
          Response.json(
            pageResponse(
              [makeItem({ id: "attn-1", title: "Attention item" })],
              {
                page: 1,
              },
            ),
          ),
        );
      }
      if (q === "riesling") {
        return Promise.resolve(
          Response.json(
            pageResponse(
              [makeItem({ id: "search-1", title: "Riesling bottle" })],
              {
                page: 1,
                totalMatching: 1,
              },
            ),
          ),
        );
      }
      if (page === 2) {
        return Promise.resolve(
          Response.json(
            pageResponse([makeItem({ id: "page2-1", title: "Page 2 item" })], {
              page: 2,
            }),
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          pageResponse([makeItem({ id: "page1-1", title: "Page 1 item" })], {
            page: 1,
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const container = document.createElement("div");
    document.body.append(container);
    const root: Root = createRoot(container);
    await act(async () => {
      root.render(createElement(CatalogControlCenter));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Initial fetch: page 1, default page size, empty query, "all" filter.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe("/api/catalog");
    expect(calls[0]!.searchParams.get("page")).toBe("1");
    expect(calls[0]!.searchParams.get("pageSize")).toBe("25");
    expect(calls[0]!.searchParams.get("q")).toBe("");
    expect(calls[0]!.searchParams.get("filter")).toBe("all");
    expect(container.textContent).toContain("Page 1 item");

    const findButtonByText = (text: string) =>
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes(text),
      );

    const prevButton = () => findButtonByText("上一頁")!;
    const nextButton = () => findButtonByText("下一頁")!;

    // "Prev" is disabled on page 1; "next" is enabled (60 > 1 * 25).
    expect(prevButton().disabled).toBe(true);
    expect(nextButton().disabled).toBe(false);

    // Clicking "next" increments page and refetches.
    await act(async () => {
      nextButton().click();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.searchParams.get("page")).toBe("2");
    expect(calls[1]!.searchParams.get("filter")).toBe("all");
    expect(container.textContent).toContain("Page 2 item");
    // Page 2 of 60 total (25/page): still more remaining, and prev is enabled.
    expect(prevButton().disabled).toBe(false);
    expect(nextButton().disabled).toBe(false);

    // Typing in the search box refetches with the new `q` param AND resets
    // page back to 1 (we were on page 2).
    const searchInput = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    await act(async () => {
      nativeSet(searchInput, "riesling");
      await Promise.resolve();
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]!.searchParams.get("q")).toBe("riesling");
    expect(calls[2]!.searchParams.get("page")).toBe("1");
    expect(container.textContent).toContain("Riesling bottle");
    // Only 1 matching row at pageSize 25: no further page to show.
    expect(nextButton().disabled).toBe(true);

    // Clear the search back out, then advance to page 2 again so we can
    // prove a filter change also resets page back to 1.
    await act(async () => {
      nativeSet(searchInput, "");
      await Promise.resolve();
    });
    expect(calls).toHaveLength(4);
    expect(calls[3]!.searchParams.get("q")).toBe("");
    expect(calls[3]!.searchParams.get("page")).toBe("1");

    await act(async () => {
      nextButton().click();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(5);
    expect(calls[4]!.searchParams.get("page")).toBe("2");

    // Clicking a filter button refetches with the `filter` param instead of
    // re-filtering client-side, and resets page back to 1 (we were on page 2).
    const attentionButton = findButtonByText("需處理")!;
    await act(async () => {
      attentionButton.click();
      await Promise.resolve();
    });
    expect(calls).toHaveLength(6);
    expect(calls[5]!.searchParams.get("filter")).toBe("attention");
    expect(calls[5]!.searchParams.get("page")).toBe("1");
    expect(container.textContent).toContain("Attention item");

    // Result count line reflects the paginated response, not a client-side
    // filtered count.
    expect(container.textContent).toContain("符合 60 / 60 個商品");

    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });
});
