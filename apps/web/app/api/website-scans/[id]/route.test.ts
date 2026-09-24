import { describe, it, expect, vi } from "vitest";
import { createWebsiteScanHandler } from "./route";
const id = "10000000-0000-4000-8000-000000000001";
describe("read website scan", () => {
  it("reads only session workspace and exposes bounded public fields without mutations", async () => {
    const getScan = vi.fn(async () => ({
      id,
      requestedUrl: "https://store.example/",
      state: "ready",
      updatedAt: new Date("2026-09-06Z"),
      productRequests: 1,
      leaseToken: "secret",
      checkpoint: {
        preview: { products: [], warnings: [] },
        candidateUrls: [],
      },
    }));
    const database = {
      forWorkspace: async (ws: string, work: any) => {
        expect(ws).toBe("own");
        return work({ websiteCatalog: { getScan } });
      },
    };
    const handler = createWebsiteScanHandler({
      session: {
        resolve: async () => ({
          workspaceId: "own",
          actorId: "actor",
          role: "operator",
        }),
      },
      getDatabase: () => database as any,
    });
    const response = await handler(new Request("https://app.example"), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        "id",
        "state",
        "sourceUrl",
        "capturedAt",
        "products",
        "warnings",
        "progress",
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain("secret");
  });
  it("hides a foreign workspace scan", async () => {
    const handler = createWebsiteScanHandler({
      session: {
        resolve: async () => ({
          workspaceId: "own",
          actorId: "actor",
          role: "operator",
        }),
      },
      getDatabase: () =>
        ({
          forWorkspace: async (_ws: string, work: any) =>
            work({ websiteCatalog: { getScan: async () => null } }),
        }) as any,
    });
    const response = await handler(new Request("https://app.example"), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
