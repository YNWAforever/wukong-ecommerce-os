import { describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getAssetStore: vi.fn(),
}));

vi.mock("../../../../../lib/intake-runtime", () => runtimeMocks);

import { createDeliverListingHandler, defaultDelivery } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = {
  workspaceId: "ws_opak",
  actorId: "reviewer_1",
  role: "reviewer" as const,
};

function routeContext() {
  return { params: Promise.resolve({ id: listingId }) };
}

function makeHandler(
  status: "in_review" | "approved",
  connection: "connected" | "disconnected" = "connected",
) {
  const calls: unknown[] = [];
  const handler = createDeliverListingHandler({
    sessionContext: {
      async resolve() {
        return context;
      },
    },
    delivery: {
      async deliver(input: any) {
        calls.push(input);
        if (status !== "approved")
          return { kind: "approval_required" as const };
        if (connection === "disconnected")
          return {
            kind: "disconnected" as const,
            csvFallback: {
              method: "csv",
              path: `/api/listings/${listingId}/deliver`,
            },
          };
        return input.method === "csv"
          ? {
              kind: "csv" as const,
              versionId,
              body: "sku,price\r\nOPAK-001,288\r\n",
              specVersion: "shopline-csv-v1",
            }
          : { kind: "queued" as const, jobId: "job_1", versionId };
      },
    },
  });
  return { handler, calls };
}

describe("POST /api/listings/[id]/deliver", () => {
  it("returns 409 for CSV before approval", async () => {
    const { handler } = makeHandler("in_review");
    const response = await handler(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ method: "csv" }),
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "approval_required" });
  });

  it("returns disconnected API delivery with explicit CSV fallback metadata", async () => {
    const { handler } = makeHandler("approved", "disconnected");
    const response = await handler(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ method: "shopline_api" }),
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "shopline_disconnected",
      csvFallback: { method: "csv" },
    });
  });

  it("returns deterministic UTF-8 CRLF CSV content for an approved listing", async () => {
    const { handler, calls } = makeHandler("approved");
    const response = await handler(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ method: "csv" }),
      }),
      routeContext(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(await response.text()).toContain("\r\n");
    expect(calls).toContainEqual(
      expect.objectContaining({
        workspaceId: "ws_opak",
        draftId: listingId,
        method: "csv",
      }),
    );
  });

  it("queues API delivery without calling a remote connector", async () => {
    const { handler } = makeHandler("approved");
    const response = await handler(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ method: "shopline_api" }),
      }),
      routeContext(),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "queued",
      jobId: "job_1",
    });
  });

  it("uses the default runtime to resolve owned listing images", async () => {
    const listingContent = {
      sku: "OPAK-001",
      producer: "Opak",
      productType: "wine" as const,
      country: "Germany",
      region: "Mosel",
      vintage: 2024,
      grapeVarieties: ["Riesling"],
      volumeMl: 750,
      abvPercent: 12.5,
      packQuantity: 1,
      priceHkd: 288,
      stockQuantity: null,
      criticScores: [],
      awards: [],
      title: { en: "Opak Riesling", "zh-Hant": "Opak Riesling" },
      description: { en: "Dry wine", "zh-Hant": "Dry wine" },
      seo: {
        title: { en: "Opak Riesling", "zh-Hant": "Opak Riesling" },
        description: { en: "Dry wine", "zh-Hant": "Dry wine" },
      },
      tags: ["wine"],
      imageAssetIds: ["asset_b", "asset_a"],
    };
    const sourceAssets = {
      getByIds: vi.fn(async () => [
        {
          id: "asset_a",
          workspaceId: "ws_opak",
          listingId,
          kind: "image/png",
          storageKey: "ws/ws_opak/sources/asset-a/a.png",
        },
        {
          id: "asset_b",
          workspaceId: "ws_opak",
          listingId,
          kind: "image/webp",
          storageKey: "ws/ws_opak/sources/asset-b/b.webp",
        },
      ]),
    };
    const repositories = {
      listings: {
        async requireForPublish() {
          return {
            id: listingId,
            target: "shopline" as const,
            status: "approved" as const,
            activeVersion: {
              id: versionId,
              sequence: 1,
              content: listingContent,
            },
            flags: [],
          };
        },
      },
      sourceAssets,
      shoplineConnections: {
        async getDefault() {
          return null;
        },
      },
      audit: { async write() {} },
      publishJobs: {
        async ensure() {
          throw new Error("must not enqueue CSV delivery");
        },
        async getByIdempotencyKey() {
          return null;
        },
      },
    };
    const database = {
      forWorkspace: vi.fn(
        async (
          _workspaceId: string,
          work: (value: typeof repositories) => Promise<unknown>,
        ) => work(repositories),
      ),
    };
    const createReadUrl = vi.fn(
      async (_workspaceId: string, storageKey: string) => ({
        url: `https://signed.example/${encodeURIComponent(storageKey)}`,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    );
    runtimeMocks.getDatabase.mockReturnValue(database);
    runtimeMocks.getAssetStore.mockReturnValue({ createReadUrl });

    const result = await defaultDelivery().deliver({
      workspaceId: "ws_opak",
      actorId: "reviewer_1",
      draftId: listingId,
      method: "csv",
    });

    expect(result.kind).toBe("csv");
    expect(database.forWorkspace).toHaveBeenCalledWith(
      "ws_opak",
      expect.any(Function),
    );
    expect(sourceAssets.getByIds).toHaveBeenCalledWith(["asset_b", "asset_a"]);
    expect(createReadUrl.mock.calls).toEqual([
      ["ws_opak", "ws/ws_opak/sources/asset-b/b.webp"],
      ["ws_opak", "ws/ws_opak/sources/asset-a/a.png"],
    ]);
  });
});
