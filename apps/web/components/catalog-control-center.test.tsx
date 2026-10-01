// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CatalogItem,
  PlatformCatalogItem,
  CatalogPage,
} from "../lib/catalog-contract";
import { CatalogControlCenter } from "./catalog-control-center.js";
import { NO_CONTENT_DIGEST } from "./bulk-export-panel.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  window.history.replaceState(null, "", "/catalog");
  sessionStorage.clear();
});

async function mount(
  fetcher: ReturnType<typeof vi.fn>,
  initialSearch?: string,
  assignmentFetcher?: ReturnType<typeof vi.fn>,
) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith("/api/listings/assign")
      ? assignmentFetcher
        ? Reflect.apply(assignmentFetcher, undefined, [input, init])
        : Promise.resolve(Response.json({}, { status: 403 }))
      : Reflect.apply(fetcher, undefined, [input, init]),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<CatalogControlCenter initialSearch={initialSearch} />);
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

it.each([401, 403])(
  "drops cached catalog data, selection and details on trusted refresh %s",
  async (status) => {
    let revoked = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith("/api/listings/assign")) return Response.json({});
      return revoked
        ? new Response("", { status })
        : Response.json(
            pageResponse(
              [
                makeItem({
                  id: "owned",
                  listingId: "00000000-0000-4000-8000-000000000001",
                  title: "Private synthetic row",
                }),
              ],
              {
                selectionScope: "scope-a",
                capabilities: {
                  canGenerateBulkUpdate: true,
                  canRecordImportResult: true,
                },
              },
            ),
          );
    });
    const { container, root } = await mount(fetcher);
    try {
      await act(async () =>
        (
          container.querySelector(
            'tbody input[type="checkbox"]',
          ) as HTMLInputElement
        ).click(),
      );
      expect(container.textContent).toContain("Private synthetic row");
      revoked = true;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
      });
      expect(container.textContent).not.toContain("Private synthetic row");
      expect(
        container.querySelector('tbody input[type="checkbox"]'),
      ).toBeNull();
      expect(
        sessionStorage.getItem("wukong:catalog:selection:scope-a"),
      ).toBeNull();
    } finally {
      await unmount(root);
    }
  },
);
it.each([true, false])(
  "ignores obsolete authorization results when old success is %s",
  async (oldSuccess) => {
    let resolveOld!: (value: Response) => void;
    let resolveNew!: (value: Response) => void;
    const fixture = () =>
      Response.json(
        pageResponse(
          [makeItem({ id: "safe", title: "Latest synthetic row" })],
          { selectionScope: "scope-a" },
        ),
      );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(fixture())
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveNew = resolve;
          }),
      );
    const { container, root } = await mount(fetcher);
    try {
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () =>
        resolveNew(oldSuccess ? new Response("", { status: 403 }) : fixture()),
      );
      expect(container.textContent?.includes("Latest synthetic row")).toBe(
        !oldSuccess,
      );
      await act(async () =>
        resolveOld(oldSuccess ? fixture() : new Response("", { status: 401 })),
      );
      expect(container.textContent?.includes("Latest synthetic row")).toBe(
        !oldSuccess,
      );
    } finally {
      await unmount(root);
    }
  },
);

function findButtonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  );
}

function makeItem(
  overrides: Partial<PlatformCatalogItem> & { id: string },
): CatalogItem {
  return {
    sourceType: "platform",
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
    capabilities: {
      canGenerateBulkUpdate: false,
      canRecordImportResult: false,
    },
    summary: {
      website: 0,
      workbook: 0,
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

it("allows operator 2 plus 3 cross-page selections and retains all five through a filter", async () => {
  const items = [1, 2, 3, 4, 5].map((n) =>
    makeItem({
      id: String(n),
      sku: `00${n}`,
      listingId: `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      listingStatus: "received",
    }),
  );
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    const page = Number(url.searchParams.get("page") ?? "1");
    const visible =
      url.searchParams.get("filter") === "website"
        ? []
        : page === 1
          ? items.slice(0, 2)
          : items.slice(2);
    return Response.json(
      pageResponse(visible, {
        page,
        totalMatching: 30,
        capabilities: {
          canGenerateBulkUpdate: false,
          canRecordImportResult: true,
          canMaintainProducts: true,
        },
      }),
    );
  });
  const { container, root } = await mount(fetcher);
  try {
    await act(async () => {
      container
        .querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')
        .forEach((box) => box.click());
    });
    expect(container.textContent).toContain("已選取 2 個商品");
    await act(async () => findButtonByText(container, "下一頁")!.click());
    await act(async () => {
      container
        .querySelectorAll<HTMLInputElement>('tbody input[type="checkbox"]')
        .forEach((box) => box.click());
    });
    expect(container.textContent).toContain("已選取 5 個商品");
    await act(async () => findButtonByText(container, "網站")!.click());
    expect(container.textContent).toContain("另有 5 項不在目前篩選");
    expect(container.textContent).toContain("這次只處理明確選中的 5 件商品");
    await act(async () => findButtonByText(container, "清除選取")!.click());
    expect(container.textContent).not.toContain("已選取 0 個商品");
  } finally {
    await unmount(root);
  }
});
it("debounces rapid zero-prefixed SKU typing, then restores a prior page on popstate", async () => {
  const calls: URL[] = [];
  const { container, root } = await mount(makePagingFetcher(calls));
  try {
    const search = container.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    await act(async () => {
      nativeSet(search, "0006");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      nativeSet(search, "000674");
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.searchParams.get("q")).toBe("000674");
    expect(window.location.search).toBe("?q=000674");
    await act(async () => {
      window.history.replaceState(null, "", "/catalog?page=2&filter=review");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(calls.at(-1)!.searchParams.get("page")).toBe("2");
    expect(calls.at(-1)!.searchParams.get("filter")).toBe("review");
    expect(search.value).toBe("");
  } finally {
    await unmount(root);
  }
});
it("keeps cursor pagination in URL/back navigation and clears it before a debounced search fetch", async () => {
  const calls: URL[] = [];
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    calls.push(url);
    return Response.json(
      pageResponse([makeItem({ id: "cursor-row" })], {
        page: Number(url.searchParams.get("page")),
        nextCursor: "opaque-next",
        previousCursor: "opaque-previous",
      }),
    );
  });
  const { container, root } = await mount(
    fetcher,
    "q=000674&page=2&cursor=opaque-start",
  );
  try {
    await act(async () => findButtonByText(container, "下一頁")!.click());
    expect(calls.at(-1)!.searchParams.get("cursor")).toBe("opaque-next");
    expect(window.location.search).toContain("cursor=opaque-next");
    await act(async () => {
      window.history.replaceState(
        null,
        "",
        "/catalog?q=000674&page=2&cursor=opaque-start",
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(calls.at(-1)!.searchParams.get("cursor")).toBe("opaque-start");
    await act(async () =>
      nativeSet(
        container.querySelector<HTMLInputElement>('input[type="search"]')!,
        "000675",
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    expect(calls.at(-1)!.searchParams.get("q")).toBe("000675");
    expect(calls.at(-1)!.searchParams.get("page")).toBe("1");
    expect(calls.at(-1)!.searchParams.has("cursor")).toBe(false);
  } finally {
    await unmount(root);
  }
});
it("clears old scoped selections when a trusted cursor refresh reports a changed role scope", async () => {
  let changed = false;
  const calls: URL[] = [];
  const fetcher = vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    calls.push(url);
    if (changed && url.searchParams.has("cursor"))
      return Response.json({ code: "invalid_cursor" }, { status: 400 });
    return Response.json(
      pageResponse(
        [
          makeItem({
            id: "scoped",
            listingId: "00000000-0000-4000-8000-000000000001",
          }),
        ],
        {
          selectionScope: changed ? "new-role" : "old-role",
          capabilities: {
            canMaintainProducts: true,
            canGenerateBulkUpdate: false,
            canRecordImportResult: false,
          },
        },
      ),
    );
  });
  const { container, root } = await mount(fetcher, "page=2&cursor=old-scope");
  try {
    await act(async () =>
      (
        container.querySelector(
          'tbody input[type="checkbox"]',
        ) as HTMLInputElement
      ).click(),
    );
    changed = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(calls.at(-1)!.searchParams.has("cursor")).toBe(false);
    expect(calls.at(-1)!.searchParams.get("page")).toBe("1");
    expect(
      sessionStorage.getItem("wukong:catalog:selection:old-role"),
    ).toBeNull();
    expect(
      (
        container.querySelector(
          'tbody input[type="checkbox"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
  } finally {
    await unmount(root);
  }
});

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
    expect(calls).toHaveLength(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 330));
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
    expect(calls).toHaveLength(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 330));
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
    expect(calls).toHaveLength(3);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 330));
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
    expect(container.textContent).toContain("符合 60 / 60 筆目錄紀錄");

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

  it("exposes metric filters as accessible buttons tied to visible scope labels", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(pageResponse([])));

    const { container, root } = await mount(fetcher);

    const tiles = container.querySelectorAll(
      '[aria-labelledby]:is(button,[role="group"])',
    );
    expect(tiles.length).toBe(9);

    const expectedLabels = [
      "商品草稿流程",
      "試算表商品",
      "網站商品",
      "未連結的平台商品",
      "目錄紀錄（包含參考資料）",
      "已綁定 SHOPLINE 商品",
      "待審核",
      "需處理",
      "已發佈",
    ];

    tiles.forEach((tile, index) => {
      const labelledBy = tile.getAttribute("aria-labelledby");
      expect(labelledBy).not.toBeNull();
      const labelElement = document.getElementById(labelledBy!);
      expect(labelElement?.textContent).toBe(expectedLabels[index]);
    });

    await unmount(root);
  });
  it("clears an imported-reference scope when opening a workspace bound metric", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(pageResponse([])));
    const { container, root } = await mount(
      fetcher,
      `importId=${id}&filter=workbook`,
    );
    expect(String(fetcher.mock.calls[0]![0])).toContain(`importId=${id}`);
    await act(async () =>
      findButtonByText(container, "已綁定 SHOPLINE 商品")!.click(),
    );
    const request = new URL(
      String(fetcher.mock.calls.at(-1)![0]),
      "http://local",
    );
    expect(request.searchParams.get("filter")).toBe("bound");
    expect(request.searchParams.has("importId")).toBe(false);
    await unmount(root);
  });
  it("selects only reviewer-authorized imported linked listings for Bulk Update", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        pageResponse(
          [
            makeItem({
              id: "imported",
              listingId: "listing-imported",
              sku: "SKU-IMPORT",
              origin: "import",
            }),
            makeItem({
              id: "created",
              listingId: "listing-created",
              sku: "SKU-CREATED",
              origin: "created",
            }),
          ],
          {
            capabilities: {
              canGenerateBulkUpdate: true,
              canRecordImportResult: true,
            },
          },
        ),
      ),
    );
    const { container, root } = await mount(fetcher);
    const imported = container.querySelector<HTMLInputElement>(
      'input[aria-label="選取 SKU-IMPORT 作批量更新"]',
    );
    expect(imported).not.toBeNull();
    expect(
      container.querySelector(
        'input[aria-label="選取 SKU-CREATED 作批量更新"]',
      ),
    ).toBeNull();
    await act(async () => imported!.click());
    expect(container.textContent).toContain("已選取 1 個商品作批量更新");
    await act(async () => findButtonByText(container, "清除選取")!.click());
    expect(container.textContent).not.toContain("已選取 0 個商品作批量更新");
    await unmount(root);
  });

  it("retries a transient filter load without resetting the selected filter", async () => {
    const calls: URL[] = [];
    let attentionLoads = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      );
      calls.push(url);
      if (
        url.searchParams.get("filter") === "attention" &&
        attentionLoads++ === 0
      ) {
        return Promise.resolve(
          Response.json({ code: "temporary" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json(
          pageResponse([
            makeItem({
              id:
                url.searchParams.get("filter") === "attention"
                  ? "recovered"
                  : "initial",
              title:
                url.searchParams.get("filter") === "attention"
                  ? "Recovered attention item"
                  : "Initial item",
            }),
          ]),
        ),
      );
    });
    const { container, root } = await mount(fetcher);
    await act(async () => {
      findButtonByText(container, "需處理")!.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "無法載入資料，請重試。",
    );
    await act(async () => {
      findButtonByText(container, "重試")!.click();
      await Promise.resolve();
    });
    expect(calls.at(-1)!.searchParams.get("filter")).toBe("attention");
    expect(container.textContent).toContain("Recovered attention item");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await unmount(root);
  });
});

it("keeps compact source provenance visible and disables page controls during a pending page", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const item = makeItem({
    id: "source",
    sourceReadiness: {
      sourceImportId: "import-1",
      merchantAttestedExportAt: "2026-09-05T04:00:00.000Z",
      currentVersionId: "version-1",
      reviewedBinding: {
        versionId: "version-1",
        sourceImportId: "import-1",
        rowDigest: "digest",
        revision: 3,
      },
      approvedBinding: null,
      headerContractCurrent: true,
      freshnessAttested: false as const,
      eligible: false as const,
      eligibleAfterAttestation: true,
      reason: "not_attested" as const,
      downstreamVerification: "unverified" as const,
      scope: "advisory_current_read" as const,
    },
  });
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(pageResponse([item])))
    .mockReturnValueOnce(pending);
  const { container, root } = await mount(fetcher);
  try {
    expect(container.textContent).toContain("匯入: import-1");
    expect(container.textContent).toContain("商戶確認的匯出時間:");
    expect(container.textContent).toContain("修訂 3 · 版本 version-1");
    await act(async () => findButtonByText(container, "下一頁")!.click());
    expect(findButtonByText(container, "下一頁")!.disabled).toBe(true);
    expect(findButtonByText(container, "上一頁")!.disabled).toBe(true);
    await act(async () =>
      resolve(Response.json(pageResponse([item], { page: 2 }))),
    );
    expect(findButtonByText(container, "上一頁")!.disabled).toBe(false);
  } finally {
    await unmount(root);
  }
});

it("keeps selected platform listings through website filtering, failure and recovery without website checkboxes", async () => {
  const website: CatalogItem = {
    sourceType: "website",
    id: "web-only",
    title: "Website observation",
    sourceUrl: "https://store.example/p",
    capturedAt: "2026-09-06T00:00:00Z",
    createdAt: "2026-09-06T00:00:00Z",
    updatedAt: "2026-09-06T00:00:00Z",
    canExport: false,
  };
  const platform = makeItem({ id: "platform-one", listingId: "listing-one" });
  let fail = true;
  const fetcher = vi.fn(async (url: string) => {
    const websiteFilter =
      new URL(url, "http://localhost").searchParams.get("filter") === "website";
    if (websiteFilter && fail) return new Response("", { status: 500 });
    return Response.json(
      pageResponse(websiteFilter ? [website] : [platform, website], {
        capabilities: {
          canGenerateBulkUpdate: true,
          canRecordImportResult: true,
        },
      }),
    );
  });
  const { container, root } = await mount(fetcher);
  try {
    expect(
      container.querySelectorAll('tbody input[type="checkbox"]'),
    ).toHaveLength(1);
    await act(async () => {
      (
        container.querySelector(
          'tbody input[type="checkbox"]',
        ) as HTMLInputElement
      ).click();
    });
    const selected = container.querySelector(
      'tbody input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(selected.checked).toBe(true);
    await act(async () => {
      findButtonByText(container, "網站")!.click();
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    fail = false;
    await act(async () => {
      findButtonByText(container, "重試")?.click();
    });
    expect(container.textContent).toContain("Website observation");
    expect(
      container.querySelectorAll('tbody input[type="checkbox"]'),
    ).toHaveLength(0);
    await act(async () => {
      (
        container.querySelector(
          'button[aria-pressed="false"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      (
        container.querySelector(
          'tbody input[type="checkbox"]',
        ) as HTMLInputElement
      )?.checked,
    ).toBe(true);
  } finally {
    await unmount(root);
  }
});

it("shows workbook source details without platform checkboxes or draft links", async () => {
  const workbook: CatalogItem = {
    sourceType: "workbook",
    id: "book",
    title: "Workbook product",
    sku: "001",
    sourceProductId: "0002",
    canExport: false,
    createdAt: "2026-09-06T00:00:00Z",
    updatedAt: "2026-09-06T00:00:00Z",
  };
  const fetcher = vi.fn(async (url: string) =>
    url.startsWith("/api/workbook-products/")
      ? Response.json({
          id: "book",
          sourceType: "workbook",
          canExport: false,
          product: {
            title: { en: "Stored workbook", "zh-Hant": "原始商品" },
            sku: "001",
            productId: "0002",
            priceHkd: 10,
            raw: {},
          },
          source: {
            filename: "stored.xlsx",
            sheetName: "Default",
            inferredExportTime: null,
          },
        })
      : Response.json(
          pageResponse([workbook], {
            capabilities: {
              canGenerateBulkUpdate: true,
              canRecordImportResult: true,
            },
          }),
        ),
  );
  const { container, root } = await mount(fetcher);
  try {
    expect(container.textContent).toContain("Workbook product");
    expect(
      container.querySelectorAll("tbody input[type=checkbox]"),
    ).toHaveLength(0);
    expect(container.querySelector('tbody a[href="/listings/new"]')).toBeNull();
    expect(container.textContent).toContain("試算表");
    await act(async () => findButtonByText(container, "查看資料")!.click());
    expect(container.textContent).toContain("stored.xlsx");
    expect(
      fetcher.mock.calls.some(([url]) => url === "/api/workbook-products/book"),
    ).toBe(true);
  } finally {
    await unmount(root);
  }
});

it("keeps exact import scope across pagination", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  window.history.replaceState(
    null,
    "",
    `/catalog?filter=workbook&importId=${id}`,
  );
  const calls: URL[] = [];
  const { container, root } = await mount(makePagingFetcher(calls));
  try {
    expect(calls[0]!.searchParams.get("importId")).toBe(id);
    expect(calls[0]!.searchParams.get("filter")).toBe("workbook");
    expect(container.textContent).toContain("此匯入");
    await act(async () => findButtonByText(container, "下一頁")!.click());
    expect(calls.at(-1)!.searchParams.get("page")).toBe("2");
    expect(calls.at(-1)!.searchParams.get("importId")).toBe(id);
  } finally {
    await unmount(root);
    window.history.replaceState(null, "", "/");
  }
});

it("restores validated catalog page and search from the URL", async () => {
  window.history.replaceState(
    null,
    "",
    "/catalog?page=2&q=old&filter=workbook",
  );
  const calls: URL[] = [];
  const { root } = await mount(makePagingFetcher(calls));
  try {
    expect(calls[0]!.searchParams.get("page")).toBe("2");
    expect(calls[0]!.searchParams.get("q")).toBe("old");
  } finally {
    await unmount(root);
    window.history.replaceState(null, "", "/");
  }
});
it("updates import, search, filter and page when the destination query changes", async () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const calls: URL[] = [];
  const { root, container } = await mount(
    makePagingFetcher(calls),
    `importId=${a}&filter=workbook&q=first&page=2`,
  );
  try {
    expect(calls.at(-1)!.searchParams.get("importId")).toBe(a);
    expect(calls.at(-1)!.searchParams.get("page")).toBe("2");
    await act(async () =>
      root.render(
        <CatalogControlCenter
          initialSearch={`importId=${b}&filter=workbook&q=second&page=3`}
        />,
      ),
    );
    expect(calls.at(-1)!.searchParams.get("importId")).toBe(b);
    expect(calls.at(-1)!.searchParams.get("q")).toBe("second");
    expect(calls.at(-1)!.searchParams.get("page")).toBe("3");
    expect(container.textContent).toContain("Page 3 item");
    await act(async () =>
      root.render(<CatalogControlCenter initialSearch={"filter=all&page=1"} />),
    );
    expect(calls.at(-1)!.searchParams.has("importId")).toBe(false);
    expect(calls.at(-1)!.searchParams.get("filter")).toBe("all");
    expect(calls.at(-1)!.searchParams.get("q")).toBe("");
    expect(container.textContent).not.toContain("此匯入");
  } finally {
    await unmount(root);
  }
});

it("hides rows from another import through pending, failure and retry while preserving the export form", async () => {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  let resolveRefresh!: (response: Response) => void;
  let resolveB!: (response: Response) => void;
  let resolveRetry!: (response: Response) => void;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json(
        pageResponse(
          [
            makeItem({
              id: "a",
              title: "Import A row",
              listingId: "listing-a",
            }),
          ],
          {
            capabilities: {
              canGenerateBulkUpdate: true,
              canRecordImportResult: true,
            },
          },
        ),
      ),
    )
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveB = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveRetry = resolve;
      }),
    );
  const { root, container } = await mount(fetcher, `importId=${a}`);
  try {
    expect(container.textContent).toContain("Import A row");
    const search = container.querySelector('input[type="search"]');
    await act(async () =>
      (
        container.querySelector(
          'tbody input[type="checkbox"]',
        ) as HTMLInputElement
      ).click(),
    );
    const attestation = container.querySelector(
      'section section input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => attestation.click());
    expect(attestation.checked).toBe(true);
    await act(async () => findButtonByText(container, "下一頁")!.click());
    expect(container.textContent).toContain("Import A row");
    expect(container.textContent).toContain("正在更新結果");
    await act(async () =>
      resolveRefresh(
        Response.json(
          pageResponse(
            [makeItem({ id: "a2", title: "Import A refreshed row" })],
            { page: 2 },
          ),
        ),
      ),
    );
    expect(container.textContent).toContain("Import A refreshed row");
    await act(async () =>
      root.render(<CatalogControlCenter initialSearch={`importId=${b}`} />),
    );
    expect(container.textContent).not.toContain("Import A");
    expect(container.querySelector('input[type="search"]')).toBe(search);
    expect(
      container.querySelector('section section input[type="checkbox"]'),
    ).toBe(attestation);
    expect(attestation.checked).toBe(true);
    await act(async () => resolveB(new Response("", { status: 503 })));
    expect(container.textContent).not.toContain("Import A");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('input[type="search"]')).toBe(search);
    expect(
      container.querySelector('section section input[type="checkbox"]'),
    ).toBe(attestation);
    expect(attestation.checked).toBe(true);
    await act(async () => findButtonByText(container, "重試")!.click());
    expect(container.textContent).not.toContain("Import A");
    await act(async () =>
      resolveRetry(
        Response.json(
          pageResponse([makeItem({ id: "b", title: "Import B row" })]),
        ),
      ),
    );
    expect(container.textContent).toContain("Import B row");
    expect(container.textContent).not.toContain("Import A");
    expect(container.querySelector('input[type="search"]')).toBe(search);
    expect(
      container.querySelector('section section input[type="checkbox"]'),
    ).toBe(attestation);
    expect(attestation.checked).toBe(true);
  } finally {
    await unmount(root);
  }
});

it("attests a selected listing's real digest, not a sentinel, after it scrolls off the fetched page", async () => {
  // Regression for Defect 1: `selectedListings` deliberately survives page
  // changes (see the "keeps selected platform listings..." and "hides rows
  // from another import..." tests above), so once the operator moves to
  // page 2 the selected listing is no longer in `response.items`. Looking
  // its digest up in the current page alone -- as the code used to -- misses
  // it there and used to fall back to the `NO_CONTENT_DIGEST` sentinel,
  // which the server can only read as a mismatch, silently excluding a
  // perfectly current listing from the export. The fix captures the digest
  // the operator was actually shown at the moment they selected the row, so
  // it survives regardless of which page is loaded when they hit Generate.
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (url === "/api/listings/export") {
      return Promise.resolve(
        Response.json({ exportAttemptId: null, rowCount: 0, manifest: [] }),
      );
    }
    const parsed = new URL(url, "http://localhost");
    const page = Number(parsed.searchParams.get("page"));
    return Promise.resolve(
      Response.json(
        pageResponse(
          page === 1
            ? [
                makeItem({
                  id: "kept",
                  listingId: "listing-kept",
                  contentDigest: "digest-real",
                }),
              ]
            : [makeItem({ id: "other", listingId: "listing-other" })],
          {
            page,
            totalMatching: 60,
            capabilities: {
              canGenerateBulkUpdate: true,
              canRecordImportResult: true,
            },
          },
        ),
      ),
    );
  });

  const { container, root } = await mount(fetcher);
  try {
    await act(async () =>
      (
        container.querySelector(
          'tbody input[type="checkbox"]',
        ) as HTMLInputElement
      ).click(),
    );
    const attestation = container.querySelector(
      'section section input[type="checkbox"]',
    ) as HTMLInputElement;
    await act(async () => attestation.click());
    expect(attestation.checked).toBe(true);

    // Move to page 2: the selected listing is no longer in `response.items`.
    await act(async () => {
      findButtonByText(container, "下一頁")!.click();
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("listing-kept");
    // The digest captured at selection survived the page change, so the
    // attestation is still valid and Generate is still enabled.
    expect(attestation.checked).toBe(true);

    const generateButton = findButtonByText(container, "產生批量更新 XLSX")!;
    expect(generateButton.disabled).toBe(false);
    await act(async () => {
      generateButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const exportCall = calls.find(
      (call) => call.url === "/api/listings/export",
    );
    expect(exportCall).toBeDefined();
    const body = JSON.parse(String(exportCall!.init!.body));
    expect(body.attestation.listings).toEqual([
      { listingId: "listing-kept", contentDigest: "digest-real" },
    ]);
    expect(body.attestation.listings[0].contentDigest).not.toBe(
      NO_CONTENT_DIGEST,
    );
  } finally {
    await unmount(root);
  }
});

it.each([200, 403])(
  "restores saved scroll after the selected assignment layout settles (%s)",
  async (status) => {
    const listingId = "00000000-0000-4000-8000-000000000001";
    const scrollKey = "wukong:catalog:scroll:scope-scroll";
    sessionStorage.setItem(
      "wukong:catalog:selection:scope-scroll",
      JSON.stringify({ ids: [listingId], exports: [] }),
    );
    sessionStorage.setItem(
      scrollKey,
      JSON.stringify({ href: "/catalog", y: 385 }),
    );
    let resolveAssignment!: (response: Response) => void;
    const assignmentFetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveAssignment = resolve;
        }),
    );
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0,
      availableY = 223,
      actualY = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const scroll = vi
      .spyOn(window, "scrollTo")
      .mockImplementation((x: number | ScrollToOptions, y?: number) => {
        actualY = Math.min(
          availableY,
          typeof x === "number" ? (y ?? 0) : (x.top ?? 0),
        );
      });
    const flushFrames = () => {
      const current = [...frames.values()];
      frames.clear();
      current.forEach((callback) => callback(0));
    };
    const fetcher = vi.fn(async () =>
      Response.json(
        pageResponse([makeItem({ id: "selected", listingId })], {
          selectionScope: "scope-scroll",
          capabilities: {
            canMaintainProducts: true,
            canGenerateBulkUpdate: false,
            canRecordImportResult: false,
          },
        }),
      ),
    );
    const { root, container } = await mount(
      fetcher,
      undefined,
      assignmentFetcher,
    );
    try {
      expect(assignmentFetcher).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("正在載入工作責任");
      await act(async () => flushFrames());
      expect(scroll).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(scrollKey)).not.toBeNull();
      availableY = 385;
      await act(async () =>
        resolveAssignment(
          Response.json(
            status === 200
              ? {
                  assignments: [
                    {
                      listingId,
                      assigneeUserId: null,
                      assignmentRevision: 0,
                      assigneeActive: false,
                      assigneeEmail: null,
                    },
                  ],
                  members: [],
                  actorId: "actor",
                  role: "operator",
                }
              : {},
            { status },
          ),
        ),
      );
      expect(container.textContent).not.toContain("正在載入工作責任");
      await act(async () => flushFrames());
      expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 385);
      expect(actualY).toBe(385);
      expect(sessionStorage.getItem(scrollKey)).toBeNull();
    } finally {
      await unmount(root);
      scroll.mockRestore();
    }
  },
);

it("cancels queued scroll restoration on unmount without consuming the saved position", async () => {
  const scrollKey = "wukong:catalog:scroll:scope-scroll";
  sessionStorage.setItem(
    scrollKey,
    JSON.stringify({ href: "/catalog", y: 385 }),
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const fetcher = vi.fn(async () =>
    Response.json(pageResponse([], { selectionScope: "scope-scroll" })),
  );
  const { root } = await mount(fetcher);
  try {
    expect(frames.size).toBe(1);
    await unmount(root);
    frames.forEach((callback) => callback(0));
    expect(scroll).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(scrollKey)).not.toBeNull();
  } finally {
    scroll.mockRestore();
  }
});

it("preserves a departure position when assignments settle before catalog unmount, then restores on return", async () => {
  const listingId = "00000000-0000-4000-8000-000000000001";
  const scrollKey = "wukong:catalog:scroll:scope-scroll";
  sessionStorage.setItem(
    "wukong:catalog:selection:scope-scroll",
    JSON.stringify({ ids: [listingId], exports: [] }),
  );
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const installFrames = () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  };
  const flushFrames = () => {
    const current = [...frames.values()];
    frames.clear();
    current.forEach((callback) => callback(0));
  };
  installFrames();
  const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(385);
  const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const fetcher = vi.fn(async () =>
    Response.json(
      pageResponse([makeItem({ id: "selected", listingId })], {
        selectionScope: "scope-scroll",
        capabilities: {
          canMaintainProducts: true,
          canGenerateBulkUpdate: false,
          canRecordImportResult: false,
        },
      }),
    ),
  );
  const assignmentResponse = () =>
    Response.json({
      assignments: [
        {
          listingId,
          assigneeUserId: null,
          assignmentRevision: 0,
          assigneeActive: false,
          assigneeEmail: null,
        },
      ],
      members: [],
      actorId: "actor",
      role: "operator",
    });
  let resolveAssignment!: (response: Response) => void;
  const assignmentFetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        resolveAssignment = resolve;
      }),
  );
  let { root, container } = await mount(fetcher, undefined, assignmentFetcher);
  try {
    expect(container.textContent).toContain("正在載入工作責任");
    expect(sessionStorage.getItem(scrollKey)).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href^="/listings/"]',
    )!;
    // Keep the outgoing catalog mounted while the router is committing the destination.
    link.addEventListener("click", (event) => event.preventDefault());
    await act(async () =>
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    );
    const saved = sessionStorage.getItem(scrollKey);
    expect(JSON.parse(saved!)).toEqual({ href: "/catalog", y: 385 });
    await act(async () => resolveAssignment(assignmentResponse()));
    await act(async () => flushFrames());
    expect(scroll).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(scrollKey)).toBe(saved);

    await unmount(root);
    installFrames();
    ({ root, container } = await mount(
      fetcher,
      undefined,
      vi.fn(async () => assignmentResponse()),
    ));
    expect(container.textContent).not.toContain("正在載入工作責任");
    await act(async () => flushFrames());
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 385);
    expect(sessionStorage.getItem(scrollKey)).toBeNull();
  } finally {
    await unmount(root);
    scroll.mockRestore();
    scrollY.mockRestore();
  }
});

it("retires a queued incoming restore before saving an identical departure position", async () => {
  const scrollKey = "wukong:catalog:scroll:scope-scroll";
  const saved = JSON.stringify({ href: "/catalog", y: 385 });
  sessionStorage.setItem(scrollKey, saved);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const scrollY = vi.spyOn(window, "scrollY", "get").mockReturnValue(385);
  const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const fetcher = vi.fn(async () =>
    Response.json(
      pageResponse(
        [
          makeItem({
            id: "selected",
            listingId: "00000000-0000-4000-8000-000000000001",
          }),
        ],
        { selectionScope: "scope-scroll" },
      ),
    ),
  );
  const { root, container } = await mount(fetcher);
  try {
    expect(frames.size).toBe(1);
    const queued = [...frames.values()];
    const link = container.querySelector<HTMLAnchorElement>(
      'a[href^="/listings/"]',
    )!;
    link.addEventListener("click", (event) => event.preventDefault());
    await act(async () =>
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ),
    );
    expect(sessionStorage.getItem(scrollKey)).toBe(saved);
    expect(frames.size).toBe(0);
    // A callback already handed to the browser must also observe the departure fence.
    await act(async () => queued.forEach((callback) => callback(0)));
    expect(scroll).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(scrollKey)).toBe(saved);
  } finally {
    await unmount(root);
    scroll.mockRestore();
    scrollY.mockRestore();
  }
});
