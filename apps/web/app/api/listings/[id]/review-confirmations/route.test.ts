import { describe, expect, it } from "vitest";

import { createReviewConfirmationsHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = {
  workspaceId: "ws_opak",
  actorId: "operator_1",
  role: "operator" as const,
};

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
    platformProduct?: {
      sourceImportId: string | null;
      contentDigest: string | null;
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
              async getReviewSnapshot(id: string) {
                calls.push(["getReviewSnapshot", id]);
                if (!snapshotExists) return null;
                return {
                  listing: { id },
                  activeVersion:
                    options.activeVersionId === null
                      ? null
                      : { id: options.activeVersionId ?? versionId },
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

  it("upserts a confirmation and returns the new revision", async () => {
    const { handler, calls } = makeHandler({
      platformProduct: { sourceImportId: "import_1", contentDigest: "digest_1" },
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
      },
    ]);
    expect(calls).toContainEqual([
      "audit",
      expect.objectContaining({
        workspaceId: "ws_opak",
        actorId: "operator_1",
        entityId: listingId,
        action: "review_confirmation.updated",
        metadata: { versionId, revision: 1 },
      }),
    ]);
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
