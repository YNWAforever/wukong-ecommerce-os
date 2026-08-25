import { describe, expect, it } from "vitest";

import { createCatalogHandler } from "./route.js";

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

    const response = await handler();

    expect(response.status).toBe(401);
  });

  it("joins recent platform products to their listing workflow state", async () => {
    const calls: unknown[] = [];
    const handler = createCatalogHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "viewer",
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
                  return [
                    {
                      id: "00000000-0000-4000-8000-000000000101",
                      connectionId: "00000000-0000-4000-8000-000000000201",
                      remoteProductId: "shopline-1001",
                      origin: "import",
                      sku: "OPAK-001",
                      listingId: "00000000-0000-4000-8000-000000000301",
                      specVersion: "shopline-bulk-v1",
                      rawRow: null,
                      factsPrefill: null,
                      contentDigest: "digest-1",
                    },
                    {
                      id: "00000000-0000-4000-8000-000000000102",
                      connectionId: "00000000-0000-4000-8000-000000000201",
                      remoteProductId: "shopline-1002",
                      origin: "import",
                      sku: "OPAK-002",
                      listingId: null,
                      specVersion: "shopline-bulk-v1",
                      rawRow: null,
                      factsPrefill: null,
                      contentDigest: "digest-2",
                    },
                  ];
                },
              },
              listings: {
                async statusesByIds(ids: string[]) {
                  calls.push(["listings.statusesByIds", ids]);
                  return {
                    "00000000-0000-4000-8000-000000000301": "in_review",
                  };
                },
                async listRecent(limit: number) {
                  calls.push(["listings.listRecent", limit]);
                  return [
                    {
                      id: "00000000-0000-4000-8000-000000000301",
                      status: "in_review",
                      activeVersion: {
                        id: "00000000-0000-4000-8000-000000000401",
                        content: {
                          title: {
                            en: "Opak Riesling",
                            "zh-Hant": "Opak 雷司令",
                          },
                        },
                      },
                      openBlockingFlagCount: 1,
                    },
                  ];
                },
              },
            });
          },
        }) as never,
    });

    const response = await handler();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          id: "00000000-0000-4000-8000-000000000101",
          remoteProductId: "shopline-1001",
          origin: "import",
          sku: "OPAK-001",
          listingId: "00000000-0000-4000-8000-000000000301",
          specVersion: "shopline-bulk-v1",
          title: "Opak 雷司令",
          listingStatus: "in_review",
          openBlockingFlagCount: 1,
          needsReview: true,
          needsAttention: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000102",
          remoteProductId: "shopline-1002",
          origin: "import",
          sku: "OPAK-002",
          listingId: null,
          specVersion: "shopline-bulk-v1",
          title: "OPAK-002",
          listingStatus: null,
          openBlockingFlagCount: null,
          needsReview: false,
          needsAttention: true,
        },
      ],
      summary: {
        total: 2,
        linked: 1,
        unlinked: 1,
        needsReview: 1,
        needsAttention: 2,
        published: 0,
      },
    });
    expect(calls).toEqual([
      ["forWorkspace", "ws_opak"],
      ["platformProducts.listRecent", 100],
      [
        "listings.statusesByIds",
        ["00000000-0000-4000-8000-000000000301"],
      ],
      ["listings.listRecent", 100],
    ]);
  });
});
