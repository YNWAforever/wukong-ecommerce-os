import { describe, expect, it, vi } from "vitest";

import { createListingViewHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";

const baseWorkspaceProfile = {
  name: "Opak Cellar",
  currency: "HKD" as const,
  locales: ["en", "zh-Hant"] as const,
  tone: "clear",
  claimPolicy: [] as string[],
  requiredFields: [] as string[],
  brandBackgroundColor: null as string | null,
};

function handlerFor(
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner",
  hasConnection = false,
  overrides: {
    sourceAssets?: { listForListing: (id: string) => Promise<any[]> };
    workspaces?: { requireProfile: () => Promise<any> };
    assetStore?: { createReadUrl: (...args: any[]) => Promise<any> };
  } = {},
) {
  return createListingViewHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
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
              async getReviewSnapshot() {
                return {
                  listing: { id: listingId, status: "in_review" },
                  activeVersion: {
                    id: "version_1",
                    content: { sku: "OPAK-1" },
                  },
                  evidence: [],
                  flags: [],
                };
              },
            },
            publishJobs: {
              async getByIdempotencyKey() {
                return null;
              },
            },
            shoplineConnections: {
              async getDefault() {
                return hasConnection ? { id: "connection_1" } : null;
              },
            },
            sourceAssets: overrides.sourceAssets ?? {
              async listForListing() {
                return [];
              },
            },
            workspaces: overrides.workspaces ?? {
              async requireProfile() {
                return baseWorkspaceProfile;
              },
            },
          });
        },
      }) as never,
    getAssetStore: () =>
      (overrides.assetStore ?? {
        async createReadUrl() {
          throw new Error("createReadUrl should not have been called");
        },
      }) as never,
  });
}

describe("GET /api/listings/[id]", () => {
  it.each([
    [
      "viewer",
      {
        canProcess: false,
        canEdit: false,
        canResolveFlags: false,
        canApprove: false,
        canDeliver: false,
      },
    ],
    [
      "operator",
      {
        canProcess: true,
        canEdit: true,
        canResolveFlags: true,
        canApprove: false,
        canDeliver: false,
      },
    ],
    [
      "reviewer",
      {
        canProcess: true,
        canEdit: true,
        canResolveFlags: true,
        canApprove: true,
        canDeliver: true,
      },
    ],
    [
      "admin",
      {
        canProcess: true,
        canEdit: true,
        canResolveFlags: true,
        canApprove: true,
        canDeliver: true,
      },
    ],
    [
      "owner",
      {
        canProcess: true,
        canEdit: true,
        canResolveFlags: true,
        canApprove: true,
        canDeliver: true,
      },
    ],
  ] as const)(
    "returns server-derived permissions for %s",
    async (role, permissions) => {
      const response = await handlerFor(role)(new Request("http://localhost"), {
        params: Promise.resolve({ id: listingId }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ permissions });
    },
  );
});

it("derives connected status from the workspace SHOPLINE connection", async () => {
  const response = await handlerFor("reviewer", true)(
    new Request("http://localhost"),
    { params: Promise.resolve({ id: listingId }) },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ connection: "connected" });
});

it("returns null productShot when no cutout asset exists for the listing", async () => {
  const createReadUrl = vi.fn();
  const response = await handlerFor("reviewer", false, {
    sourceAssets: {
      async listForListing() {
        return [
          {
            id: "asset_1",
            kind: "image/jpeg",
            metadata: {},
            storageKey: "ws/x/sources/1/photo.jpg",
          },
        ];
      },
    },
    assetStore: { createReadUrl },
  })(new Request("http://localhost"), {
    params: Promise.resolve({ id: listingId }),
  });

  const body = await response.json();
  expect(body.productShot).toBeNull();
  expect(createReadUrl).not.toHaveBeenCalled();
});

it("resolves a preview URL and the workspace brand color when a cutout exists", async () => {
  const createReadUrl = vi.fn(async () => ({
    url: "https://assets.example/preview.png",
    expiresAt: new Date("2026-01-01T00:05:00.000Z"),
  }));
  const response = await handlerFor("reviewer", false, {
    sourceAssets: {
      async listForListing() {
        return [
          {
            id: "asset_shot_1",
            kind: "image/png",
            metadata: { role: "product_shot_cutout", listingId },
            storageKey: "ws/ws_opak/sources/x/product-shot-cutout.png",
          },
        ];
      },
    },
    assetStore: { createReadUrl },
    workspaces: {
      async requireProfile() {
        return {
          name: "Opak Cellar",
          currency: "HKD",
          locales: ["en", "zh-Hant"],
          tone: "clear",
          claimPolicy: [],
          requiredFields: [],
          brandBackgroundColor: "#112233",
        };
      },
    },
  })(new Request("http://localhost"), {
    params: Promise.resolve({ id: listingId }),
  });

  const body = await response.json();
  expect(body.productShot).toEqual({
    previewUrl: "https://assets.example/preview.png",
    brandBackgroundColor: "#112233",
  });
  expect(createReadUrl).toHaveBeenCalledWith(
    "ws_opak",
    "ws/ws_opak/sources/x/product-shot-cutout.png",
    expect.objectContaining({ expiresInMs: expect.any(Number) }),
  );
});
