import { describe, expect, it } from "vitest";

import { createQualityHandler } from "./route.js";

describe("GET /api/quality", () => {
  it("requires an authenticated workspace session", async () => {
    const handler = createQualityHandler({
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

  it("returns a QualitySummary-shaped body for an authenticated viewer", async () => {
    const calls: unknown[] = [];
    const cleanContent = {
      title: { en: "A", "zh-Hant": "甲" },
      description: { en: "desc", "zh-Hant": "描述" },
      seo: {
        title: { en: "seo title", "zh-Hant": "seo 標題" },
        description: { en: "seo desc", "zh-Hant": "seo 描述" },
      },
      tags: ["tag1"],
    };
    const gappyContent = {
      ...cleanContent,
      title: { en: "A", "zh-Hant": "A" },
    };

    const handler = createQualityHandler({
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
              listings: {
                async listRecent() {
                  calls.push(["listings.listRecent"]);
                  return [
                    {
                      id: "l1",
                      activeVersion: { id: "v1", content: cleanContent },
                    },
                    {
                      id: "l2",
                      activeVersion: { id: "v2", content: gappyContent },
                    },
                    { id: "l3", activeVersion: null },
                  ];
                },
              },
              aiRuns: {
                async sumCostForListings(listingIds: readonly string[]) {
                  calls.push(["aiRuns.sumCostForListings", listingIds]);
                  return 12.5;
                },
              },
            });
          },
        }) as never,
    });

    const response = await handler();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      totalAssessed: 2,
      cleanCount: 1,
      hasGapsCount: 1,
      gapCounts: {
        untranslatedName: 1,
        untranslatedSeoTitle: 0,
        seoTitleMirrorsName: 0,
        seoDescriptionMirrorsSeoTitle: 0,
        keywordsMirrorName: 0,
        summaryMissing: 0,
      },
      totalCostUsd: 12.5,
    });

    expect(calls).toEqual([
      ["forWorkspace", "ws_opak"],
      ["listings.listRecent"],
      ["aiRuns.sumCostForListings", ["l1", "l2", "l3"]],
    ]);
  });
});
