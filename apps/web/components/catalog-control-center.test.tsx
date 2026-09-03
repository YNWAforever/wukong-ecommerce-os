// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { CatalogItem, CatalogPage } from "../lib/catalog-contract";
import { CatalogControlCenter } from "./catalog-control-center.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(fetcher: ReturnType<typeof vi.fn>) {
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
  return { container, root };
}

async function unmount(root: Root) {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
}

function nativeSet(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findButtonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  );
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

/**
 * Fetcher used by the tests that page/paginate: always echoes back a
 * `Page {n} item` for whatever `page` was requested, with 60 total matches
 * (more than 2 pages at pageSize 25) unless a param-specific branch below
 * (search/filter) intercepts it.
 */
function makePagingFetcher(calls: URL[]) {
  return vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, "http://localhost");
    calls.push(parsed);
    const page = Number(parsed.searchParams.get("page"));
    return Promise.resolve(
      Response.json(
        pageResponse(
          [makeItem({ id: `p${page}`, title: `Page ${page} item` })],
          {
            page,
            totalMatching: 60,
          },
        ),
      ),
    );
  });
}

describe("CatalogControlCenter", () => {
  it("sends page, pageSize, q, and filter as query params on the initial fetch", async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(new URL(url, "http://localhost"));
      return Promise.resolve(
        Response.json(pageResponse([makeItem({ id: "1" })])),
      );
    });

    const { root } = await mount(fetcher);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe("/api/catalog");
    expect(calls[0]!.searchParams.get("page")).toBe("1");
    expect(calls[0]!.searchParams.get("pageSize")).toBe("25");
    expect(calls[0]!.searchParams.get("q")).toBe("");
    expect(calls[0]!.searchParams.get("filter")).toBe("all");

    await unmount(root);
  });

  it("clicking next page increments page and refetches", async () => {
    const calls: URL[] = [];
    const fetcher = makePagingFetcher(calls);

    const { container, root } = await mount(fetcher);
    expect(container.textContent).toContain("Page 1 item");

    await act(async () => {
      findButtonByText(container, "下一頁")!.click();
      await Promise.resolve();
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.searchParams.get("page")).toBe("2");
    expect(container.textContent).toContain("Page 2 item");

    await unmount(root);
  });

  it("typing a search query sends q and resets page to 1", async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url, "http://localhost");
      calls.push(parsed);
      const page = Number(parsed.searchParams.get("page"));
      const q = parsed.searchParams.get("q");

      if (q === "riesling") {
        return Promise.resolve(
          Response.json(
            pageResponse(
              [makeItem({ id: "search-1", title: "Riesling bottle" })],
              { page: 1, totalMatching: 1 },
            ),
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          pageResponse(
            [makeItem({ id: `p${page}`, title: `Page ${page} item` })],
            {
              page,
              totalMatching: 60,
            },
          ),
        ),
      );
    });

    const { container, root } = await mount(fetcher);

    // Advance to page 2 first, so we can prove typing a search resets it.
    await act(async () => {
      findButtonByText(container, "下一頁")!.click();
      await Promise.resolve();
    });
    expect(calls[1]!.searchParams.get("page")).toBe("2");

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

    await unmount(root);
  });

  it("clearing the search query refetches with an empty q and resets page to 1", async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url, "http://localhost");
      calls.push(parsed);
      const page = Number(parsed.searchParams.get("page"));
      const q = parsed.searchParams.get("q");

      if (q === "riesling") {
        return Promise.resolve(
          Response.json(
            pageResponse(
              [makeItem({ id: "search-1", title: "Riesling bottle" })],
              { page, totalMatching: 60 },
            ),
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          pageResponse(
            [makeItem({ id: `p${page}`, title: `Page ${page} item` })],
            {
              page,
              totalMatching: 60,
            },
          ),
        ),
      );
    });

    const { container, root } = await mount(fetcher);

    const searchInput = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    // Type a search, then advance to page 2, so clearing has to both refetch
    // with an empty q AND reset page back to 1.
    await act(async () => {
      nativeSet(searchInput, "riesling");
      await Promise.resolve();
    });
    expect(calls[1]!.searchParams.get("q")).toBe("riesling");

    await act(async () => {
      findButtonByText(container, "下一頁")!.click();
      await Promise.resolve();
    });
    expect(calls[2]!.searchParams.get("page")).toBe("2");

    await act(async () => {
      nativeSet(searchInput, "");
      await Promise.resolve();
    });

    expect(calls).toHaveLength(4);
    expect(calls[3]!.searchParams.get("q")).toBe("");
    expect(calls[3]!.searchParams.get("page")).toBe("1");
    expect(container.textContent).toContain("Page 1 item");

    await unmount(root);
  });

  it("clicking a filter button sends filter and resets page to 1", async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url, "http://localhost");
      calls.push(parsed);
      const page = Number(parsed.searchParams.get("page"));
      const filter = parsed.searchParams.get("filter");

      if (filter === "attention") {
        return Promise.resolve(
          Response.json(
            pageResponse(
              [makeItem({ id: "attn-1", title: "Attention item" })],
              {
                page: 1,
                totalMatching: 60,
              },
            ),
          ),
        );
      }
      return Promise.resolve(
        Response.json(
          pageResponse(
            [makeItem({ id: `p${page}`, title: `Page ${page} item` })],
            {
              page,
              totalMatching: 60,
            },
          ),
        ),
      );
    });

    const { container, root } = await mount(fetcher);

    // Advance to page 2 first, so we can prove clicking a filter resets it.
    await act(async () => {
      findButtonByText(container, "下一頁")!.click();
      await Promise.resolve();
    });
    expect(calls[1]!.searchParams.get("page")).toBe("2");

    await act(async () => {
      findButtonByText(container, "需處理")!.click();
      await Promise.resolve();
    });

    expect(calls).toHaveLength(3);
    expect(calls[2]!.searchParams.get("filter")).toBe("attention");
    expect(calls[2]!.searchParams.get("page")).toBe("1");
    expect(container.textContent).toContain("Attention item");
    // Result count line reflects the paginated response, not a client-side
    // filtered count.
    expect(container.textContent).toContain("符合 60 / 60 個商品");

    await unmount(root);
  });

  it("disables prev on page 1 and next once there is no further page", async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      const parsed = new URL(url, "http://localhost");
      calls.push(parsed);
      const page = Number(parsed.searchParams.get("page"));
      return Promise.resolve(
        Response.json(
          pageResponse([makeItem({ id: `p${page}` })], {
            page,
            // 30 total at pageSize 25: page 1 has more, page 2 does not.
            totalMatching: 30,
          }),
        ),
      );
    });

    const { container, root } = await mount(fetcher);
    const prevButton = () => findButtonByText(container, "上一頁")!;
    const nextButton = () => findButtonByText(container, "下一頁")!;

    expect(prevButton().disabled).toBe(true);
    expect(nextButton().disabled).toBe(false);

    await act(async () => {
      nextButton().click();
      await Promise.resolve();
    });

    expect(prevButton().disabled).toBe(false);
    expect(nextButton().disabled).toBe(true);

    await unmount(root);
  });

  it("renders the table with an accessible name", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input.toString();
      new URL(url, "http://localhost");
      return Promise.resolve(
        Response.json(pageResponse([makeItem({ id: "1" })])),
      );
    });

    const { container, root } = await mount(fetcher);

    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.getAttribute("aria-label")).toBe("商品列表");

    await unmount(root);
  });

  it('exposes each metric tile as a role="group" tied to its visible label', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(pageResponse([])));

    const { container, root } = await mount(fetcher);

    const tiles = container.querySelectorAll('[role="group"]');
    expect(tiles.length).toBe(5);

    const expectedLabels = [
      "商品 Products",
      "已連結 Linked",
      "待審核 Needs review",
      "需處理 Attention",
      "已發佈 Published",
    ];

    tiles.forEach((tile, index) => {
      const labelledBy = tile.getAttribute("aria-labelledby");
      expect(labelledBy).not.toBeNull();
      const labelElement = document.getElementById(labelledBy!);
      expect(labelElement?.textContent).toBe(expectedLabels[index]);
    });

    await unmount(root);
  });
});
