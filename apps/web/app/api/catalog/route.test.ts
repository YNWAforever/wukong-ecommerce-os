import { describe, expect, it } from "vitest";

import { createCatalogHandler } from "./route.js";

type FakeProduct = {
  id: string;
  connectionId: string;
  remoteProductId: string;
  origin: "import" | "created";
  sku: string | null;
  listingId: string | null;
  specVersion: string | null;
  rawRow: null;
  factsPrefill: null;
  contentDigest: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakeListing = {
  id: string;
  status: string;
  activeVersion: {
    id: string;
    content: { title: { en: string; "zh-Hant"?: string } };
  } | null;
  openBlockingFlagCount: number;
};

function buildRequest(query = ""): Request {
  return new Request(`http://localhost/api/catalog${query ? `?${query}` : ""}`);
}

function product(
  overrides: Partial<FakeProduct> & { id: string },
): FakeProduct {
  return {
    connectionId: "00000000-0000-4000-8000-000000000201",
    remoteProductId: `remote-${overrides.id}`,
    origin: "import",
    sku: `SKU-${overrides.id}`,
    listingId: null,
    specVersion: "shopline-bulk-v1",
    rawRow: null,
    factsPrefill: null,
    contentDigest: `digest-${overrides.id}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeHandler({
  products,
  listingsById = new Map<string, FakeListing>(),
  statuses = {},
}: {
  products: FakeProduct[];
  listingsById?: Map<string, FakeListing>;
  statuses?: Record<string, string>;
}) {
  const calls: unknown[] = [];
  const handler = createCatalogHandler({
    sessionContext: {
      async resolve() {
        return {
          workspaceId: "ws_opak",
          actorId: "user_1",
          role: "viewer" as const,
        };
      },
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          workspaceId: string,
          work: (repositories: any) => Promise<T>,
        ) {
          calls.push(["forWorkspace", workspaceId]);
          return work({
            platformProducts: {
              async listRecent(limit: number) {
                calls.push(["platformProducts.listRecent", limit]);
                return products;
              },
            },
            listings: {
              async statusesByIds(ids: string[]) {
                calls.push(["listings.statusesByIds", ids]);
                return statuses;
              },
              // Deliberately no `listRecent` here: the route must not call
              // it any more. If it did, this fake would throw
              // "listings.listRecent is not a function" and every assertion
              // below would fail.
              async getByIds(ids: string[]) {
                calls.push(["listings.getByIds", ids]);
                return ids
                  .map((id) => listingsById.get(id))
                  .filter(
                    (listing): listing is FakeListing => listing !== undefined,
                  );
              },
            },
          });
        },
      }) as never,
  });
  return { handler, calls };
}

describe("GET /api/catalog", () => {
  it("requires an authenticated workspace session", async () => {
    const handler = createCatalogHandler({
      sessionContext: {
        async resolve() {
          return null;
        },
      },
      getDatabase: () => {
        throw new Error("database should not be opened");
      },
    });

    const response = await handler(buildRequest());

    expect(response.status).toBe(401);
  });

  it("returns page 1 at page size 25 with no query params", async () => {
    const products = [product({ id: "1" }), product({ id: "2" })];
    const { handler } = makeHandler({ products });

    const response = await handler(buildRequest());
    const body = (await response.json()) as {
      page: number;
      pageSize: number;
      totalMatching: number;
      items: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
    expect(body.totalMatching).toBe(2);
    expect(body.items).toHaveLength(2);
  });

  it("returns different items on page 2 than on page 1", async () => {
    const products = Array.from({ length: 30 }, (_, index) =>
      product({ id: String(index).padStart(3, "0") }),
    );
    const { handler } = makeHandler({ products });

    const page1Response = await handler(buildRequest("page=1"));
    const page2Response = await handler(buildRequest("page=2"));
    const page1Body = (await page1Response.json()) as {
      page: number;
      totalMatching: number;
      items: Array<{ id: string }>;
    };
    const page2Body = (await page2Response.json()) as {
      page: number;
      items: Array<{ id: string }>;
    };

    expect(page1Body.page).toBe(1);
    expect(page1Body.totalMatching).toBe(30);
    expect(page1Body.items).toHaveLength(25);
    expect(page2Body.page).toBe(2);
    expect(page2Body.items).toHaveLength(5);

    const page1Ids = new Set(page1Body.items.map((item) => item.id));
    const page2Ids = page2Body.items.map((item) => item.id);
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }
    // Page 2 holds exactly the tail beyond the first 25.
    expect(page2Ids).toEqual(products.slice(25).map((p) => p.id));
  });

  it("finds a q match outside page 1's default window", async () => {
    const products = Array.from({ length: 30 }, (_, index) =>
      product({ id: String(index).padStart(3, "0") }),
    );
    // Row 27 (index 27) sits past the first 25-item page.
    products[27] = product({ id: "027", sku: "UNIQUE-NEEDLE" });
    const { handler } = makeHandler({ products });

    const response = await handler(buildRequest("q=unique-needle"));
    const body = (await response.json()) as {
      totalMatching: number;
      items: Array<{ id: string; sku: string | null }>;
    };

    expect(response.status).toBe(200);
    expect(body.totalMatching).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.sku).toBe("UNIQUE-NEEDLE");
  });

  it("filters to only matching items for a given filter value", async () => {
    const attentionProduct = product({ id: "1", listingId: null });
    const listingId = "00000000-0000-4000-8000-000000000301";
    const publishedProduct = product({ id: "2", listingId });
    const { handler } = makeHandler({
      products: [attentionProduct, publishedProduct],
      statuses: { [listingId]: "published" },
      listingsById: new Map([
        [
          listingId,
          {
            id: listingId,
            status: "published",
            activeVersion: {
              id: "v1",
              content: { title: { en: "Opak Riesling" } },
            },
            openBlockingFlagCount: 0,
          },
        ],
      ]),
    });

    const response = await handler(buildRequest("filter=attention"));
    const body = (await response.json()) as {
      items: Array<{ id: string; needsAttention: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(attentionProduct.id);
    expect(body.items.every((item) => item.needsAttention)).toBe(true);
  });

  it("includes createdAt, updatedAt and contentDigest on every item", async () => {
    const products = [
      product({
        id: "1",
        contentDigest: "digest-abc",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      }),
      product({ id: "2", contentDigest: null }),
    ];
    const { handler } = makeHandler({ products });

    const response = await handler(buildRequest());
    const body = (await response.json()) as {
      items: Array<{
        createdAt: string;
        updatedAt: string;
        contentDigest: string | null;
      }>;
    };

    expect(body.items).toEqual([
      expect.objectContaining({
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
        contentDigest: "digest-abc",
      }),
      expect.objectContaining({
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        contentDigest: null,
      }),
    ]);
  });

  it("regression: resolves a linked listing's title via getByIds, not the 100-most-recent window", async () => {
    // This listing is deliberately the only one in the fake's `listings`
    // store -- it stands in for a listing that a naive `listRecent(100)`
    // lookup would miss because it isn't among the globally most-recently
    // updated 100 listings, even though this specific platform product links
    // to it. The route must resolve it by id via `getByIds`.
    const listingId = "00000000-0000-4000-8000-000000000999";
    const linkedProduct = product({
      id: "1",
      sku: "OPAK-FALLBACK-SKU",
      remoteProductId: "shopline-fallback-1",
      listingId,
    });
    const { handler, calls } = makeHandler({
      products: [linkedProduct],
      statuses: { [listingId]: "in_review" },
      listingsById: new Map([
        [
          listingId,
          {
            id: listingId,
            status: "in_review",
            activeVersion: {
              id: "v1",
              content: {
                title: { en: "Opak Riesling", "zh-Hant": "Opak 雷司令" },
              },
            },
            openBlockingFlagCount: 0,
          },
        ],
      ]),
    });

    const response = await handler(buildRequest());
    const body = (await response.json()) as {
      items: Array<{ id: string; title: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.items[0]?.title).toBe("Opak 雷司令");
    // Not the degraded sku/remoteProductId fallback the bug used to produce.
    expect(body.items[0]?.title).not.toBe("OPAK-FALLBACK-SKU");
    expect(body.items[0]?.title).not.toBe("shopline-fallback-1");
    expect(calls).toContainEqual(["listings.getByIds", [listingId]]);
  });
});
