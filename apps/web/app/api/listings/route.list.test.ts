import { describe, expect, it } from "vitest";

import { createListListingsHandler } from "./route.js";

describe("GET /api/listings", () => {
  it("requires an authenticated workspace session", async () => {
    const handler = createListListingsHandler({
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

  it("returns recent workspace listings with canonical display fields", async () => {
    const calls: unknown[] = [];
    const updatedAt = new Date("2026-07-18T05:00:00.000Z");
    const handler = createListListingsHandler({
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "ws_opak",
            actorId: "user_1",
            role: "operator",
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
              listings: {
                async listRecent(limit: number) {
                  calls.push(["listRecent", limit]);
                  return [
                    {
                      id: "00000000-0000-4000-8000-000000000101",
                      status: "in_review",
                      target: "shopline",
                      note: "Supplier sheet",
                      updatedAt,
                      activeVersion: {
                        id: "00000000-0000-4000-8000-000000000201",
                        content: {
                          sku: "OPAK-001",
                          title: {
                            en: "Opak Riesling",
                            "zh-Hant": "Opak \u96f7\u53f8\u4ee4",
                          },
                        },
                      },
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
          status: "in_review",
          target: "shopline",
          title: "Opak \u96f7\u53f8\u4ee4",
          sku: "OPAK-001",
          updatedAt: "2026-07-18T05:00:00.000Z",
        },
      ],
    });
    expect(calls).toEqual([
      ["forWorkspace", "ws_opak"],
      ["listRecent", 100],
    ]);
  });
});
