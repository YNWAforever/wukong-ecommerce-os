// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type {
  CatalogItem,
  PlatformCatalogItem,
  CatalogPage,
} from "../lib/catalog-contract";
import { CatalogControlCenter } from "./catalog-control-center.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(
  fetcher: ReturnType<typeof vi.fn>,
  initialSearch?: string,
) {
  vi.stubGlobal("fetch", fetcher);
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
    expect(tiles.length).toBe(8);

    const expectedLabels = [
      "試算表商品",
      "網站商品",
      "未連結的平台商品",
      "商品",
      "已連結",
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
    expect(container.textContent).toContain("已選取 0 個商品作批量更新");
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
