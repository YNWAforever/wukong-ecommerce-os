import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@wukong/assets/product-shot-flatten", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@wukong/assets/product-shot-flatten")
    >();
  return {
    ...actual,
    flattenProductShot: vi.fn(async () => new Uint8Array([9, 9, 9])),
  };
});

import { flattenProductShot } from "@wukong/assets/product-shot-flatten";

import { createApproveListingHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = {
  workspaceId: "ws_opak",
  actorId: "reviewer_1",
  role: "reviewer" as const,
};

const request = (
  body: Record<string, unknown> = {
    requestedStatus: "published",
    workspaceId: "ws_other",
    actorId: "attacker",
  },
) =>
  new Request(`http://localhost/api/listings/${listingId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function routeContext() {
  return { params: Promise.resolve({ id: listingId }) };
}

function makeHandler(options: {
  role?: "viewer" | "operator" | "reviewer" | "admin";
  status?: "in_review" | "approved" | "published" | "reopened";
  flags?: Array<{
    id: string;
    field: string;
    rule: "health_claim";
    severity: "blocking";
    status: "open" | "resolved";
    resolutionReason: string | null;
  }>;
}) {
  const calls: unknown[] = [];
  const handler = createApproveListingHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "reviewer" };
      },
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repos: any) => Promise<T>,
        ) {
          return work({
            listings: {
              async getReviewSnapshot(id: string) {
                calls.push(["getReviewSnapshot", id]);
                return {
                  listing: {
                    id,
                    target: "shopline",
                    status: options.status ?? "in_review",
                  },
                  activeVersion: {
                    id: versionId,
                    sequence: 3,
                    content: { sku: "OPAK-001", imageAssetIds: [] },
                  },
                  evidence: [],
                  flags: options.flags ?? [],
                };
              },
              async approve(
                id: string,
                version: string,
                auditContext: unknown,
                _audit: unknown,
              ) {
                calls.push(["approve", id, version, auditContext]);
              },
            },
            audit: {
              async write(event: unknown) {
                calls.push(["audit", event]);
              },
            },
          });
        },
      }) as never,
    approve: async (
      version: string,
      flags: any[],
      auditContext: any,
      audit: any,
    ) => {
      calls.push(["domainApprove", version, flags, auditContext]);
      const open = flags.some(
        (flag) => flag.severity === "blocking" && flag.status === "open",
      );
      if (open)
        throw new Error(
          "Blocking compliance flags must be resolved before approval",
        );
      await audit.write({
        ...auditContext,
        action: "listing.approved",
        metadata: { versionId: version },
      });
      return { versionId: version, status: "approved" as const };
    },
  });
  return { handler, calls };
}

describe("POST /api/listings/[id]/approve", () => {
  beforeEach(() => {
    vi.mocked(flattenProductShot).mockClear();
  });

  it("rejects a viewer before loading any listing", async () => {
    const { handler, calls } = makeHandler({ role: "viewer" });
    const response = await handler(request(), routeContext());
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("returns 422 for an unresolved blocking flag", async () => {
    const { handler } = makeHandler({
      flags: [
        {
          id: "flag_1",
          field: "description",
          rule: "health_claim",
          severity: "blocking",
          status: "open",
          resolutionReason: null,
        },
      ],
    });
    const response = await handler(request(), routeContext());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "blocking_flags" });
  });

  it("approves the server-resolved active version and ignores requested identity/status", async () => {
    const { handler, calls } = makeHandler({});
    const response = await handler(request(), routeContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listingId,
      versionId,
      status: "approved",
    });
    expect(calls).toContainEqual([
      "domainApprove",
      versionId,
      [],
      expect.objectContaining({
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
        entityId: listingId,
      }),
    ]);
    expect(calls).toContainEqual([
      "approve",
      listingId,
      versionId,
      expect.objectContaining({
        workspaceId: "ws_opak",
        actorId: "reviewer_1",
      }),
    ]);
  });

  it("flattens the cutout onto the chosen background and promotes the new version", async () => {
    const finalStorageKey = "ws/ws_opak/sources/final/product-shot-final.png";
    const cutoutBytes = new Uint8Array([1, 2, 3]);
    const flattenedBytes = new Uint8Array([9, 9, 9]);
    const calls: unknown[] = [];
    const handler = createApproveListingHandler({
      sessionContext: {
        async resolve() {
          return { ...context, role: "reviewer" };
        },
      },
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repos: any) => Promise<T>,
          ) {
            return work({
              listings: {
                async getReviewSnapshot() {
                  return {
                    listing: {
                      id: listingId,
                      target: "shopline",
                      status: "in_review",
                    },
                    activeVersion: {
                      id: versionId,
                      sequence: 3,
                      content: {
                        sku: "OPAK-001",
                        imageAssetIds: ["asset_raw_1"],
                      },
                    },
                    evidence: [
                      {
                        field: "sku",
                        sourceAssetId: "note",
                        page: null,
                        excerpt: "OPAK-001",
                        confidence: 1,
                      },
                    ],
                    flags: [],
                  };
                },
                async appendVersion(_id: string, content: any) {
                  calls.push(["appendVersion", content]);
                  return { id: "version_new_1", sequence: 4 };
                },
                async replaceEvidence(id: string, evidence: unknown[]) {
                  calls.push(["replaceEvidence", id, evidence]);
                },
                async replaceFlags(id: string, flags: unknown[]) {
                  calls.push(["replaceFlags", id, flags]);
                },
                async promoteAndApprove(
                  id: string,
                  baseVersionId: string,
                  newVersionId: string,
                ) {
                  calls.push([
                    "promoteAndApprove",
                    id,
                    baseVersionId,
                    newVersionId,
                  ]);
                },
                async approve() {
                  calls.push(["approve-should-not-be-called"]);
                },
              },
              sourceAssets: {
                async listForListing() {
                  return [
                    {
                      id: "asset_cutout_1",
                      kind: "image/png",
                      metadata: { role: "product_shot_cutout" },
                      storageKey: "ws/ws_opak/sources/cutout/x.png",
                    },
                  ];
                },
                async create(input: unknown) {
                  calls.push(["sourceAssets.create", input]);
                  return { id: "asset_final_1" };
                },
                async attachToListing(id: string, assetIds: string[]) {
                  calls.push(["attachToListing", id, assetIds]);
                },
              },
              workspaces: {
                async requireProfile() {
                  return { brandBackgroundColor: null };
                },
              },
              audit: {
                async write(event: unknown) {
                  calls.push(["audit", event]);
                },
              },
            });
          },
        }) as never,
      approve: async (
        version: string,
        flags: any[],
        auditContext: any,
        audit: any,
      ) => {
        await audit.write({
          ...auditContext,
          action: "listing.approved",
          metadata: { versionId: version },
        });
        return { versionId: version, status: "approved" as const };
      },
      assetStore: {
        async readObject() {
          return cutoutBytes;
        },
        async writeObject(_ws: string, key: string, body: Uint8Array) {
          calls.push(["writeObject", key, body]);
          return { size: body.byteLength, mimeType: "image/png" };
        },
        createAssetKey() {
          return finalStorageKey;
        },
      },
    } as never);

    const response = await handler(
      request({ background: "white" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(flattenProductShot).toHaveBeenCalledWith(cutoutBytes, "#ffffff");
    expect(calls).toContainEqual([
      "writeObject",
      finalStorageKey,
      flattenedBytes,
    ]);
    expect(calls).toContainEqual([
      "sourceAssets.create",
      expect.objectContaining({
        storageKey: finalStorageKey,
        kind: "image/png",
        metadata: { role: "product_shot_final", listingId },
      }),
    ]);
    expect(calls).toContainEqual([
      "attachToListing",
      listingId,
      ["asset_final_1"],
    ]);
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        action: "asset.product_shot_final_created",
        metadata: expect.objectContaining({
          assetId: "asset_final_1",
          storageKey: finalStorageKey,
        }),
      }),
    ]);
    expect(calls).toContainEqual([
      "appendVersion",
      expect.objectContaining({
        imageAssetIds: ["asset_raw_1", "asset_final_1"],
      }),
    ]);
    expect(calls).toContainEqual([
      "replaceEvidence",
      "version_new_1",
      expect.arrayContaining([expect.objectContaining({ field: "sku" })]),
    ]);
    expect(calls).toContainEqual(["replaceFlags", "version_new_1", []]);
    expect(calls).toContainEqual([
      "promoteAndApprove",
      listingId,
      versionId,
      "version_new_1",
    ]);
    expect(calls).not.toContainEqual(["approve-should-not-be-called"]);
  });

  it("replaces a prior product-shot-final asset instead of accumulating it when re-approved with a different background", async () => {
    const finalStorageKey = "ws/ws_opak/sources/final/product-shot-final-2.png";
    const calls: unknown[] = [];
    const handler = createApproveListingHandler({
      sessionContext: {
        async resolve() {
          return { ...context, role: "reviewer" };
        },
      },
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repos: any) => Promise<T>,
          ) {
            return work({
              listings: {
                async getReviewSnapshot() {
                  return {
                    listing: {
                      id: listingId,
                      target: "shopline",
                      status: "approved",
                    },
                    activeVersion: {
                      id: versionId,
                      sequence: 4,
                      content: {
                        sku: "OPAK-001",
                        imageAssetIds: ["asset_raw_1", "asset_final_old"],
                      },
                    },
                    evidence: [],
                    flags: [],
                  };
                },
                async appendVersion(_id: string, content: any) {
                  calls.push(["appendVersion", content]);
                  return { id: "version_new_2", sequence: 5 };
                },
                async replaceEvidence() {},
                async replaceFlags() {},
                async promoteAndApprove(
                  id: string,
                  baseVersionId: string,
                  newVersionId: string,
                ) {
                  calls.push([
                    "promoteAndApprove",
                    id,
                    baseVersionId,
                    newVersionId,
                  ]);
                },
                async approve() {
                  calls.push(["approve-should-not-be-called"]);
                },
              },
              sourceAssets: {
                async listForListing() {
                  return [
                    {
                      id: "asset_cutout_1",
                      kind: "image/png",
                      metadata: { role: "product_shot_cutout" },
                      storageKey: "ws/ws_opak/sources/cutout/x.png",
                    },
                    {
                      id: "asset_final_old",
                      kind: "image/png",
                      metadata: { role: "product_shot_final" },
                      storageKey: "ws/ws_opak/sources/final/old.png",
                    },
                  ];
                },
                async create(input: unknown) {
                  calls.push(["sourceAssets.create", input]);
                  return { id: "asset_final_new" };
                },
                async attachToListing(id: string, assetIds: string[]) {
                  calls.push(["attachToListing", id, assetIds]);
                },
              },
              workspaces: {
                async requireProfile() {
                  return { brandBackgroundColor: null };
                },
              },
              audit: {
                async write(event: unknown) {
                  calls.push(["audit", event]);
                },
              },
            });
          },
        }) as never,
      approve: async (
        version: string,
        flags: any[],
        auditContext: any,
        audit: any,
      ) => {
        await audit.write({
          ...auditContext,
          action: "listing.approved",
          metadata: { versionId: version },
        });
        return { versionId: version, status: "approved" as const };
      },
      assetStore: {
        async readObject() {
          return new Uint8Array([1, 2, 3]);
        },
        async writeObject(_ws: string, key: string, body: Uint8Array) {
          calls.push(["writeObject", key, body]);
          return { size: body.byteLength, mimeType: "image/png" };
        },
        createAssetKey() {
          return finalStorageKey;
        },
      },
    } as never);

    const response = await handler(
      request({ background: "brand" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(calls).toContainEqual([
      "appendVersion",
      expect.objectContaining({
        imageAssetIds: ["asset_raw_1", "asset_final_new"],
      }),
    ]);
    expect(calls).toContainEqual([
      "promoteAndApprove",
      listingId,
      versionId,
      "version_new_2",
    ]);
    expect(calls).not.toContainEqual(["approve-should-not-be-called"]);
  });

  it("approves the existing active version unchanged when a background is chosen but no cutout exists", async () => {
    const calls: unknown[] = [];
    const handler = createApproveListingHandler({
      sessionContext: {
        async resolve() {
          return { ...context, role: "reviewer" };
        },
      },
      getDatabase: () =>
        ({
          async forWorkspace<T>(
            _workspaceId: string,
            work: (repos: any) => Promise<T>,
          ) {
            return work({
              listings: {
                async getReviewSnapshot() {
                  return {
                    listing: {
                      id: listingId,
                      target: "shopline",
                      status: "in_review",
                    },
                    activeVersion: {
                      id: versionId,
                      sequence: 3,
                      content: { sku: "OPAK-001", imageAssetIds: [] },
                    },
                    evidence: [],
                    flags: [],
                  };
                },
                async approve(
                  id: string,
                  version: string,
                  auditContext: unknown,
                ) {
                  calls.push(["approve", id, version, auditContext]);
                },
              },
              sourceAssets: {
                async listForListing() {
                  calls.push(["listForListing"]);
                  return [];
                },
              },
              audit: {
                async write(event: unknown) {
                  calls.push(["audit", event]);
                },
              },
            });
          },
        }) as never,
      approve: async (
        version: string,
        flags: any[],
        auditContext: any,
        audit: any,
      ) => {
        await audit.write({
          ...auditContext,
          action: "listing.approved",
          metadata: { versionId: version },
        });
        return { versionId: version, status: "approved" as const };
      },
      assetStore: {
        async readObject() {
          throw new Error(
            "assetStore.readObject should not be called when no cutout exists",
          );
        },
        async writeObject() {
          throw new Error(
            "assetStore.writeObject should not be called when no cutout exists",
          );
        },
        createAssetKey() {
          throw new Error(
            "assetStore.createAssetKey should not be called when no cutout exists",
          );
        },
      },
    } as never);

    const response = await handler(
      request({ background: "white" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listingId,
      versionId,
      status: "approved",
    });
    expect(calls).toContainEqual(["listForListing"]);
    expect(calls).toContainEqual([
      "approve",
      listingId,
      versionId,
      expect.objectContaining({ workspaceId: "ws_opak" }),
    ]);
    expect(flattenProductShot).not.toHaveBeenCalled();
  });
});
