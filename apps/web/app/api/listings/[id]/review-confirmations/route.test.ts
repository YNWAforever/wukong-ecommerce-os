import { createHash } from "node:crypto";

import type { FieldEvidence, ReviewableListing } from "@wukong/core";
import { describe, expect, it } from "vitest";

import { CONFIRMATION_FIELD_KEYS } from "../../../../../lib/review-confirmation-keys";

import { createReviewConfirmationsHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = {
  workspaceId: "ws_opak",
  actorId: "operator_1",
  role: "operator" as const,
};

const content: ReviewableListing = {
  sku: "OPAK-001",
  producer: "Opak",
  productType: "wine",
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
  title: { en: "Opak Riesling", "zh-Hant": "opak-riesling-zh" },
  description: { en: "Dry wine", "zh-Hant": "dry-wine-zh" },
  seo: {
    title: { en: "Opak Riesling", "zh-Hant": "opak-riesling-zh" },
    description: { en: "Dry wine", "zh-Hant": "dry-wine-zh" },
  },
  tags: ["wine"],
  imageAssetIds: [],
};

const sha = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function request(body: Record<string, unknown>) {
  return new Request(
    `http://localhost/api/listings/${listingId}/review-confirmations`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function routeContext(id: string = listingId) {
  return { params: Promise.resolve({ id }) };
}

function makeHandler(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin";
    activeVersionId?: string | null;
    snapshotExists?: boolean;
    invalidation?: "unchanged" | "reopened" | "publishing" | "stale";
    evidence?: FieldEvidence[];
    currentRevision?: number | null;
    versionSourceImportId?: string | null;
    versionRowDigest?: string | null;
    platformProduct?: {
      origin?: "import" | "created";
      sourceImportId: string | null;
      contentDigest: string | null;
      rawRow?: Record<string, string | null> | null;
    } | null;
  } = {},
) {
  const calls: unknown[] = [];
  const platformProduct =
    options.platformProduct === undefined ? null : options.platformProduct;
  const snapshotExists = options.snapshotExists ?? true;
  const handler = createReviewConfirmationsHandler({
    sessionContext: {
      async resolve() {
        return { ...context, role: options.role ?? "operator" };
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
              async lockReviewState() {},
              async invalidateApprovalForConfirmationChange(
                id: string,
                observedVersionId: string,
              ) {
                calls.push([
                  "invalidateApprovalForConfirmationChange",
                  id,
                  observedVersionId,
                ]);
                return options.invalidation ?? "unchanged";
              },
              async getReviewSnapshot(id: string) {
                calls.push(["getReviewSnapshot", id]);
                if (!snapshotExists) return null;
                return {
                  listing: { id },
                  activeVersion:
                    options.activeVersionId === null
                      ? null
                      : {
                          id: options.activeVersionId ?? versionId,
                          content,
                          sourceImportId:
                            options.versionSourceImportId !== undefined
                              ? options.versionSourceImportId
                              : platformProduct?.origin === "import"
                                ? platformProduct.sourceImportId
                                : null,
                          sourceRowDigest:
                            options.versionRowDigest !== undefined
                              ? options.versionRowDigest
                              : platformProduct?.origin === "import"
                                ? platformProduct.contentDigest
                                : null,
                        },
                  evidence: options.evidence ?? [],
                };
              },
            },
            platformProducts: {
              async getByListingId(id: string) {
                calls.push(["getByListingId", id]);
                return platformProduct;
              },
            },
            reviewConfirmations: {
              async getByVersionId() {
                return options.currentRevision === undefined ||
                  options.currentRevision === null
                  ? null
                  : { revision: options.currentRevision };
              },
              async upsert(input: any) {
                calls.push(["upsert", input]);
                return {
                  id: "confirmation_1",
                  listingId,
                  versionId: input.versionId,
                  fieldConfirmations: input.fieldConfirmations,
                  negativeConfirmations: input.negativeConfirmations,
                  revision: 1,
                  sourceImportId: input.sourceImportId,
                  rowDigest: input.rowDigest,
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
  });
  return { handler, calls };
}

function upsertInput(calls: unknown[]) {
  const call = calls.find(
    (entry): entry is ["upsert", { fieldRecords: Record<string, any> }] =>
      Array.isArray(entry) && entry[0] === "upsert",
  );
  return call?.[1];
}

describe("PATCH /api/listings/[id]/review-confirmations", () => {
  it("rejects a viewer before opening a workspace transaction", async () => {
    const { handler, calls } = makeHandler({ role: "viewer" });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: { no_medical_claims: true },
      }),
      routeContext(),
    );

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects a non-boolean confirmation value", async () => {
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: "yes" },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  });

  it("refuses a request that tries to supply its own field records", async () => {
    // The records are derived server-side. A strict, unchanged request schema
    // is what makes that true rather than merely intended.
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { nameZh: true },
        negativeConfirmations: {},
        fieldRecords: {
          nameZh: {
            afterDigest: "a".repeat(64),
            before: null,
            evidenceDigest: null,
          },
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(calls).toEqual([]);
  });

  it("upserts a confirmation and returns the new revision", async () => {
    const { handler, calls } = makeHandler({
      platformProduct: {
        origin: "import",
        sourceImportId: "import_1",
        contentDigest: "digest_1",
      },
    });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true, description: false },
        negativeConfirmations: { no_medical_claims: true },
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      revision: 1,
      fieldConfirmations: { title: true, description: false },
      negativeConfirmations: { no_medical_claims: true },
    });
    expect(calls).toContainEqual([
      "upsert",
      {
        listingId,
        versionId,
        fieldConfirmations: { title: true, description: false },
        negativeConfirmations: { no_medical_claims: true },
        sourceImportId: "import_1",
        rowDigest: "digest_1",
        fieldRecords: expect.objectContaining({
          nameZh: expect.anything(),
          seoKeywords: expect.anything(),
        }),
      },
    ]);
    // No imported row and no evidence: every field says so.
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        workspaceId: "ws_opak",
        actorId: "operator_1",
        entityId: listingId,
        action: "review_confirmation.updated",
        metadata: {
          versionId,
          revision: 1,
          fieldsWithImportedCell: 0,
          fieldsWithoutEvidence: 8,
        },
      }),
    ]);
  });

  it("rejects a checklist for a version created before the current import", async () => {
    const { handler, calls } = makeHandler({
      platformProduct: {
        origin: "import",
        sourceImportId: "import_new",
        contentDigest: "digest_new",
      },
      versionSourceImportId: "import_old",
      versionRowDigest: "digest_old",
    });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "source_version_stale",
    });
    expect(upsertInput(calls)).toBeUndefined();
  });

  it("records each field against the imported row and the evidence", async () => {
    const { handler, calls } = makeHandler({
      platformProduct: {
        origin: "import",
        sourceImportId: "import_1",
        contentDigest: "digest_1",
        rawRow: { nameZh: "opak-riesling-zh", summaryEn: "" },
      },
      evidence: [
        {
          field: "title.zh-Hant",
          sourceAssetId: "note",
          page: null,
          excerpt: "Opak",
          confidence: 0.9,
        },
      ],
    });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { nameZh: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    const records = upsertInput(calls)?.fieldRecords;
    expect(records?.nameZh).toEqual({
      afterDigest: sha("opak-riesling-zh"),
      before: { column: "nameZh", digest: sha("opak-riesling-zh") },
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(records?.summaryEn).toEqual({
      afterDigest: sha("Dry wine"),
      before: null,
      evidenceDigest: null,
    });
    // The response shape is unchanged: the record is evidence, not UI state.
    expect(await response.json()).not.toHaveProperty("fieldRecords");
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        metadata: {
          versionId,
          revision: 1,
          fieldsWithImportedCell: 1,
          fieldsWithoutEvidence: 7,
        },
      }),
    ]);
  });

  it("reopens current approval before updating its confirmation ledger", async () => {
    const { handler, calls } = makeHandler({ invalidation: "reopened" });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: false },
        negativeConfirmations: {},
      }),
      routeContext(),
    );
    expect(response.status).toBe(200);
    expect(calls).toContainEqual([
      "invalidateApprovalForConfirmationChange",
      listingId,
      versionId,
    ]);
  });

  it("maps a version that becomes stale after the snapshot to 409", async () => {
    const { handler, calls } = makeHandler({ invalidation: "stale" });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: false },
        negativeConfirmations: {},
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_version" });
    expect(
      calls.some((call) => Array.isArray(call) && call[0] === "upsert"),
    ).toBe(false);
  });

  it("fails closed without updating confirmations while publishing", async () => {
    const { handler, calls } = makeHandler({ invalidation: "publishing" });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: false },
        negativeConfirmations: {},
      }),
      routeContext(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "listing_publishing" });
    expect(
      calls.some((call) => Array.isArray(call) && call[0] === "upsert"),
    ).toBe(false);
  });

  it("populates null sourceImportId/rowDigest for a create-origin listing with no platform product link", async () => {
    const { handler, calls } = makeHandler({ platformProduct: null });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(calls).toContainEqual([
      "upsert",
      expect.objectContaining({
        sourceImportId: null,
        rowDigest: null,
      }),
    ]);
    const records = upsertInput(calls)?.fieldRecords;
    // Every confirmation key gets a record even with no imported row. Without
    // checking the key set, an absent or partial fieldRecords would pass.
    expect(Object.keys(records ?? {}).sort()).toEqual(
      [...CONFIRMATION_FIELD_KEYS].sort(),
    );
    for (const key of CONFIRMATION_FIELD_KEYS) {
      expect(records?.[key]).toEqual({
        afterDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        before: null,
        evidenceDigest: null,
      });
    }
  });

  it("rejects a versionId that isn't the listing's current active version", async () => {
    const superseded = "00000000-0000-4000-8000-000000000299";
    const { handler, calls } = makeHandler({
      activeVersionId: "00000000-0000-4000-8000-000000000301",
    });
    const response = await handler(
      request({
        versionId: superseded,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_version" });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["upsert", expect.anything()]),
    );
  });

  it("rejects a versionId that belongs to a completely different listing", async () => {
    const otherListingsVersionId = "11111111-1111-4111-8111-111111111111";
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId: otherListingsVersionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "stale_version" });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["upsert", expect.anything()]),
    );
  });

  it("returns 404 (not 500) for a listing that no longer exists", async () => {
    const { handler, calls } = makeHandler({ snapshotExists: false });
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext(),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "listing_not_found" });
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["upsert", expect.anything()]),
    );
  });

  it("returns 404 (not 500) for a malformed listing id, without touching the database", async () => {
    const { handler, calls } = makeHandler();
    const response = await handler(
      request({
        versionId,
        fieldConfirmations: { title: true },
        negativeConfirmations: {},
      }),
      routeContext("not-a-listing-id"),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "listing_not_found" });
    expect(calls).toEqual([]);
  });
});

it("rejects a competing confirmation revision before invalidating approval", async () => {
  const { handler, calls } = makeHandler({ currentRevision: 2 });
  const response = await handler(
    request({
      versionId,
      expectedRevision: 1,
      fieldConfirmations: { title: true },
      negativeConfirmations: {},
    }),
    routeContext(),
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "confirmation_revision_conflict",
  });
  expect(upsertInput(calls)).toBeUndefined();
  expect(
    calls.some((c: any) => c[0] === "invalidateApprovalForConfirmationChange"),
  ).toBe(false);
});
