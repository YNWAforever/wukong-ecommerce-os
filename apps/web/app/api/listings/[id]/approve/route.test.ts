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

import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "../../../../../lib/review-confirmation-keys";

import { createApproveListingHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = {
  workspaceId: "ws_opak",
  actorId: "reviewer_1",
  role: "reviewer" as const,
};

const fullFieldConfirmations: Record<string, boolean> = Object.fromEntries(
  CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
);
const fullNegativeConfirmations: Record<string, boolean> = Object.fromEntries(
  CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
);

type ReviewConfirmationFixture = {
  revision: number;
  fieldConfirmations: Record<string, boolean>;
  negativeConfirmations: Record<string, boolean>;
  sourceImportId: string | null;
  rowDigest: string | null;
} | null;

const fullyConfirmed: ReviewConfirmationFixture = {
  revision: 0,
  fieldConfirmations: fullFieldConfirmations,
  negativeConfirmations: fullNegativeConfirmations,
  sourceImportId: null,
  rowDigest: null,
};

const request = (
  body: Record<string, unknown> = {
    requestedStatus: "published",
    workspaceId: "ws_other",
    actorId: "attacker",
    expectedVersionId: versionId,
    confirmationLedgerRevision: 0,
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
  confirmation?: ReviewConfirmationFixture;
  platformProduct?: {
    origin: "import" | "created";
    sourceImportId: string | null;
    contentDigest: string | null;
  } | null;
}) {
  const calls: unknown[] = [];
  const confirmation =
    options.confirmation === undefined ? fullyConfirmed : options.confirmation;
  const platformProduct =
    options.platformProduct === undefined ? null : options.platformProduct;
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
            reviewConfirmations: {
              async getByVersionId(id: string) {
                calls.push(["reviewConfirmations.getByVersionId", id]);
                return confirmation;
              },
            },
            platformProducts: {
              async getByListingId(id: string) {
                calls.push(["platformProducts.getByListingId", id]);
                return platformProduct;
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
              reviewConfirmations: {
                async getByVersionId() {
                  return fullyConfirmed;
                },
              },
              platformProducts: {
                async getByListingId() {
                  return null;
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
      request({
        background: "white",
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
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
              reviewConfirmations: {
                async getByVersionId() {
                  return fullyConfirmed;
                },
              },
              platformProducts: {
                async getByListingId() {
                  return null;
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
      request({
        background: "brand",
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
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
              reviewConfirmations: {
                async getByVersionId() {
                  return fullyConfirmed;
                },
              },
              platformProducts: {
                async getByListingId() {
                  return null;
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
      request({
        background: "white",
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
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

  it("rejects a body missing expectedVersionId with 400", async () => {
    const { handler, calls } = makeHandler({});
    const response = await handler(
      request({ confirmationLedgerRevision: 0 }),
      routeContext(),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("rejects a body missing confirmationLedgerRevision with 400", async () => {
    const { handler, calls } = makeHandler({});
    const response = await handler(
      request({ expectedVersionId: versionId }),
      routeContext(),
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("returns 409 version_conflict when expectedVersionId does not match the snapshot's active version", async () => {
    const { handler, calls } = makeHandler({});
    const response = await handler(
      request({
        expectedVersionId: "00000000-0000-4000-8000-000000000999",
        confirmationLedgerRevision: 0,
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "version_conflict" });
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        action: "listing.review_conflict",
        entityId: listingId,
        metadata: { reason: "version_conflict" },
      }),
    ]);
  });

  it("returns 409 confirmation_ledger_stale when confirmationLedgerRevision does not match the ledger's current revision", async () => {
    const { handler, calls } = makeHandler({
      confirmation: { ...fullyConfirmed!, revision: 5 },
    });
    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "confirmation_ledger_stale",
    });
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        action: "listing.review_conflict",
        entityId: listingId,
        metadata: { reason: "confirmation_ledger_stale" },
      }),
    ]);
  });

  it("returns 422 confirmation_incomplete when the confirmation checklist is not fully checked", async () => {
    const { handler } = makeHandler({
      confirmation: {
        revision: 0,
        fieldConfirmations: {},
        negativeConfirmations: {},
        sourceImportId: null,
        rowDigest: null,
      },
    });
    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
      routeContext(),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "confirmation_incomplete",
    });
  });

  it("returns 400 source_freshness_required for an import-origin listing approved without sourceImportId/expectedRowDigest", async () => {
    const { handler } = makeHandler({
      platformProduct: {
        origin: "import",
        sourceImportId: "import_1",
        contentDigest: "digest_1",
      },
    });
    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
      routeContext(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "source_freshness_required",
    });
  });

  it("returns 409 with the freshness failure reason as the error code when an import-origin listing's row digest no longer matches", async () => {
    const { handler, calls } = makeHandler({
      platformProduct: {
        origin: "import",
        sourceImportId: "import_1",
        contentDigest: "digest_1",
      },
    });
    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
        sourceImportId: "import_1",
        expectedRowDigest: "stale_digest",
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "row_digest_mismatch",
    });
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        action: "listing.review_conflict",
        entityId: listingId,
        metadata: { reason: "row_digest_mismatch" },
      }),
    ]);
  });

  it("approves a create-origin listing (no platform_products link) without requiring sourceImportId/expectedRowDigest", async () => {
    const { handler, calls } = makeHandler({ platformProduct: null });
    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
      routeContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listingId,
      versionId,
      status: "approved",
    });
    expect(calls).toContainEqual([
      "platformProducts.getByListingId",
      listingId,
    ]);
  });

  it("approves a create-origin listing with a 'created'-origin platform_products link without requiring sourceImportId/expectedRowDigest", async () => {
    // A listing created directly in Wukong (never imported) still gets a
    // `platform_products` row after its first publish -- see
    // `apps/worker/src/publish-product.ts` -- but with `origin: "created"`
    // and both `sourceImportId`/`contentDigest` null. The client can never
    // populate the freshness fields for such a listing, so the gate must not
    // require them just because *a* link exists.
    const { handler, calls } = makeHandler({
      platformProduct: {
        origin: "created",
        sourceImportId: null,
        contentDigest: null,
      },
    });
    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
      routeContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      listingId,
      versionId,
      status: "approved",
    });
    expect(calls).toContainEqual([
      "platformProducts.getByListingId",
      listingId,
    ]);
  });

  it("rejects with 409 version_conflict instead of silently approving a different version when the active version changes between phase 0's checks and the approval transaction", async () => {
    // Simulates the race: phase 0's `forWorkspace` call reads and validates
    // the listing at `versionId` (the version the reviewer's confirmation
    // checklist was filled out against). Before phase 3's own `forWorkspace`
    // call runs, a concurrent `PUT /api/listings/[id]/review` promotes a new
    // version -- `raceVersionId` -- to active. `approveOne` must reject
    // rather than approve `raceVersionId`, which has no confirmation-ledger
    // row and was never freshness-checked.
    const raceVersionId = "00000000-0000-4000-8000-000000000777";
    const calls: unknown[] = [];
    let snapshotCallCount = 0;
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
                async getReviewSnapshot(id: string) {
                  snapshotCallCount += 1;
                  const activeId =
                    snapshotCallCount === 1 ? versionId : raceVersionId;
                  calls.push(["getReviewSnapshot", id, activeId]);
                  return {
                    listing: {
                      id,
                      target: "shopline",
                      status: "in_review",
                    },
                    activeVersion: {
                      id: activeId,
                      sequence: snapshotCallCount === 1 ? 3 : 4,
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
                  calls.push(["approve-should-not-be-called", id, version]);
                },
              },
              reviewConfirmations: {
                async getByVersionId() {
                  return fullyConfirmed;
                },
              },
              platformProducts: {
                async getByListingId() {
                  return null;
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
      approve: async () => {
        calls.push(["domainApprove-should-not-be-called"]);
        return { versionId: raceVersionId, status: "approved" as const };
      },
    });

    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "version_conflict" });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["approve-should-not-be-called"]),
    );
    expect(calls).not.toContainEqual(["domainApprove-should-not-be-called"]);
    expect(snapshotCallCount).toBe(2);
  });

  it("rejects with 409 confirmation_ledger_stale instead of silently approving when the checklist changes on the SAME version between phase 0's checks and the approval transaction", async () => {
    // Simulates the narrower race: the active version never changes (stays
    // `versionId` the whole time), so the `expectedVersionId` re-check alone
    // would pass. A second reviewer PATCHes
    // /api/listings/[id]/review-confirmations for that same version, which
    // bumps the ledger's revision without ever calling `appendVersion`.
    // `approveOne` must re-read the ledger itself and reject the stale
    // revision, rather than trusting phase 0's earlier read.
    const calls: unknown[] = [];
    let confirmationCallCount = 0;
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
                async getReviewSnapshot(id: string) {
                  return {
                    listing: {
                      id,
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
                  calls.push(["approve-should-not-be-called", id, version]);
                },
              },
              reviewConfirmations: {
                async getByVersionId(id: string) {
                  confirmationCallCount += 1;
                  const revision = confirmationCallCount === 1 ? 2 : 3;
                  calls.push([
                    "reviewConfirmations.getByVersionId",
                    id,
                    revision,
                  ]);
                  return { ...fullyConfirmed!, revision };
                },
              },
              platformProducts: {
                async getByListingId() {
                  return null;
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
      approve: async () => {
        calls.push(["domainApprove-should-not-be-called"]);
        return { versionId, status: "approved" as const };
      },
    });

    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 2,
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "confirmation_ledger_stale",
    });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["approve-should-not-be-called"]),
    );
    expect(calls).not.toContainEqual(["domainApprove-should-not-be-called"]);
    expect(confirmationCallCount).toBe(2);
  });

  it("rejects with 409 and the freshness failure reason instead of silently approving when an import-origin listing's content digest changes on the SAME version between phase 0's checks and the approval transaction", async () => {
    // Simulates the narrower race: the active version never changes (stays
    // `versionId` the whole time), so the `expectedVersionId` re-check alone
    // would pass. A concurrent catalog re-import updates the linked
    // `platform_products` row's `contentDigest` via `upsertMany`'s
    // `onConflictDoUpdate`, again without ever calling `appendVersion`.
    // `approveOne` must re-read the link and re-run the freshness check
    // itself, rather than trusting phase 0's earlier read.
    const calls: unknown[] = [];
    let linkCallCount = 0;
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
                async getReviewSnapshot(id: string) {
                  return {
                    listing: {
                      id,
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
                  calls.push(["approve-should-not-be-called", id, version]);
                },
              },
              reviewConfirmations: {
                async getByVersionId() {
                  return fullyConfirmed;
                },
              },
              platformProducts: {
                async getByListingId(id: string) {
                  linkCallCount += 1;
                  const contentDigest =
                    linkCallCount === 1 ? "digest_1" : "digest_2";
                  calls.push([
                    "platformProducts.getByListingId",
                    id,
                    contentDigest,
                  ]);
                  return {
                    origin: "import" as const,
                    sourceImportId: "import_1",
                    contentDigest,
                  };
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
      approve: async () => {
        calls.push(["domainApprove-should-not-be-called"]);
        return { versionId, status: "approved" as const };
      },
    });

    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
        sourceImportId: "import_1",
        expectedRowDigest: "digest_1",
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "row_digest_mismatch",
    });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["approve-should-not-be-called"]),
    );
    expect(calls).not.toContainEqual(["domainApprove-should-not-be-called"]);
    expect(linkCallCount).toBe(2);
  });

  it("rejects with 400 source_freshness_required instead of silently approving when a create-origin listing's platform_products link flips to import-origin between phase 0's checks and the approval transaction", async () => {
    // Simulates the gate-applicability race: phase 0 sees no link at all (a
    // create-origin listing, same as a listing that was never published), so
    // it correctly does not require sourceImportId/expectedRowDigest and the
    // client never sends them. Before phase 3 runs, a concurrent catalog
    // re-import matches this listing's platform_products row (same
    // connection/remote-product id) and flips it to `origin: "import"` with
    // a real digest -- again without ever calling `appendVersion`, so the
    // active version never changes. `approveOne` must re-derive that the
    // gate now applies and reject for missing freshness fields, rather than
    // trusting that `deps.sourceImportId === undefined` means the gate still
    // doesn't apply.
    const calls: unknown[] = [];
    let linkCallCount = 0;
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
                async getReviewSnapshot(id: string) {
                  return {
                    listing: {
                      id,
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
                  calls.push(["approve-should-not-be-called", id, version]);
                },
              },
              reviewConfirmations: {
                async getByVersionId() {
                  return fullyConfirmed;
                },
              },
              platformProducts: {
                async getByListingId(id: string) {
                  linkCallCount += 1;
                  calls.push([
                    "platformProducts.getByListingId",
                    id,
                    linkCallCount,
                  ]);
                  if (linkCallCount === 1) return null;
                  return {
                    origin: "import" as const,
                    sourceImportId: "import_1",
                    contentDigest: "digest_1",
                  };
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
      approve: async () => {
        calls.push(["domainApprove-should-not-be-called"]);
        return { versionId, status: "approved" as const };
      },
    });

    const response = await handler(
      request({
        expectedVersionId: versionId,
        confirmationLedgerRevision: 0,
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "source_freshness_required",
    });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["approve-should-not-be-called"]),
    );
    expect(calls).not.toContainEqual(["domainApprove-should-not-be-called"]);
    expect(linkCallCount).toBe(2);
  });
});
