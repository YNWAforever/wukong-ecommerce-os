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

function routeContext() {
  return { params: Promise.resolve({ id: listingId }) };
}

function makeHandler(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin";
    platformProduct?: {
      sourceImportId: string | null;
      contentDigest: string | null;
    } | null;
  } = {},
) {
  const calls: unknown[] = [];
  const platformProduct =
    options.platformProduct === undefined ? null : options.platformProduct;
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
});
