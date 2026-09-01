import { describe, expect, it } from "vitest";

import type { ListingStatus } from "@wukong/core";

import { createListListingsHandler } from "./route.js";

const zeroCounts: Record<ListingStatus, number> = {
  received: 0,
  processing: 0,
  needs_info: 0,
  in_review: 0,
  approved: 0,
  reopened: 0,
  publishing: 0,
  published: 0,
  publish_failed: 0,
  failed: 0,
};

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
                      openBlockingFlagCount: 2,
                    },
                  ];
                },
                async countByStatus() {
                  calls.push(["countByStatus"]);
                  return { ...zeroCounts, in_review: 1 };
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
          openBlockingFlagCount: 2,
        },
      ],
      counts: { ...zeroCounts, in_review: 1 },
    });
    expect(calls).toEqual([
      ["forWorkspace", "ws_opak"],
      ["listRecent", 100],
      ["countByStatus"],
    ]);
  });

  it("includes a workspace-accurate counts field sourced from countByStatus, not the capped item list", async () => {
    const fullCounts: Record<ListingStatus, number> = {
      received: 3,
      processing: 1,
      needs_info: 2,
      in_review: 5,
      approved: 4,
      reopened: 1,
      publishing: 0,
      // Exceeds listRecent's 100-row cap on purpose: if counts were ever
      // derived from `items` instead of a real countByStatus() call, this
      // value could never appear in the response.
      published: 120,
      publish_failed: 1,
      failed: 2,
    };
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
            _workspaceId: string,
            work: (repositories: any) => Promise<T>,
          ) {
            return work({
              listings: {
                async listRecent() {
                  return [];
                },
                async countByStatus() {
                  return fullCounts;
                },
              },
            });
          },
        }) as never,
    });

    const response = await handler();
    const body = (await response.json()) as { counts: unknown };

    expect(body.counts).toEqual(fullCounts);
  });
});
