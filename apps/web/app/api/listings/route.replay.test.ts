/**
 * Creating the same listing twice.
 *
 * `route.create.test.ts` fixes its asset at `listingId: null`, so it only ever
 * exercises a fresh create. The interesting case is the one an operator
 * actually hits: the create succeeded, the response was lost, and they clicked
 * again. Assets are single-use, so the second attempt used to be refused with
 * `409 source_asset_already_used` -- and the listing it had just made was
 * stranded, reachable only by someone who knew to go looking for it.
 */
import { describe, expect, it, vi } from "vitest";

import { createListingHandler } from "./route.js";

const assetA = "00000000-0000-4000-8000-000000000001";
const assetB = "00000000-0000-4000-8000-000000000002";
const listingId = "00000000-0000-4000-8000-0000000000aa";
const otherListingId = "00000000-0000-4000-8000-0000000000bb";

const sessionContext = {
  async resolve() {
    return {
      workspaceId: "ws_opak",
      actorId: "user_1",
      role: "operator",
    } as const;
  },
};

function post(sourceAssetIds: string[], note = "intake") {
  return new Request("http://localhost/api/listings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceAssetIds, note }),
  });
}

function harness(
  assets: Array<{ id: string; kind: string; listingId: string | null }>,
  existing: { id: string; note: string | null } | null = null,
) {
  const mutations: string[] = [];
  const repositories = {
    sourceAssets: {
      async getByIds() {
        return assets;
      },
      async attachToListing() {
        mutations.push("attach");
      },
    },
    listings: {
      async create() {
        mutations.push("create");
        return { id: listingId, status: "received", target: "shopline" };
      },
      async getById(id: string) {
        return existing && existing.id === id
          ? { ...existing, status: "received", target: "shopline" }
          : null;
      },
    },
    audit: {
      async write() {
        mutations.push("audit");
      },
    },
  };
  const enqueue = vi.fn(async () => ({ id: "job_1" }));
  const handler = createListingHandler({
    sessionContext,
    getAssetStore: () => {
      throw new Error("unused");
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          _workspaceId: string,
          work: (repos: typeof repositories) => Promise<T>,
        ) {
          return work(repositories);
        },
      }) as never,
    publisher: { enqueue },
  });
  return { handler, mutations, enqueue };
}

describe("POST /api/listings replayed after a lost response", () => {
  it("returns the listing the first attempt created", async () => {
    const { handler, mutations } = harness(
      [
        { id: assetA, kind: "image/png", listingId },
        { id: assetB, kind: "image/png", listingId },
      ],
      { id: listingId, note: "intake" },
    );

    const response = await handler(post([assetA, assetB]));

    expect(response.status).toBe(201);
    expect((await response.json()).listing.id).toBe(listingId);
    // No second listing, and no second attach or audit event for one.
    expect(mutations).toEqual([]);
  });

  it("re-enqueues, because the first attempt's enqueue may have failed", async () => {
    // The create route keeps the draft and returns 201 even when the queue is
    // unreachable, so a replay is the operator's only way back to a listing
    // that was never queued. Enqueue is keyed, so a duplicate is a no-op.
    const { handler, enqueue } = harness(
      [{ id: assetA, kind: "image/png", listingId }],
      { id: listingId, note: "intake" },
    );

    await handler(post([assetA]));

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: listingId }),
    );
  });

  it("treats a blank note as the absent note the first attempt stored", async () => {
    const { handler } = harness(
      [{ id: assetA, kind: "image/png", listingId }],
      { id: listingId, note: null },
    );

    const response = await handler(post([assetA], "   "));

    expect(response.status).toBe(201);
  });
});

describe("POST /api/listings still refuses a genuine conflict", () => {
  it("refuses when the assets belong to different listings", async () => {
    const { handler, mutations } = harness(
      [
        { id: assetA, kind: "image/png", listingId },
        { id: assetB, kind: "image/png", listingId: otherListingId },
      ],
      { id: listingId, note: "intake" },
    );

    const response = await handler(post([assetA, assetB]));

    expect(response.status).toBe(409);
    expect(mutations).toEqual([]);
  });

  it("refuses when only some of the assets are already claimed", async () => {
    // A half-overlap is not a replay of anything -- the operator is building a
    // different listing out of a file that already belongs to one.
    const { handler } = harness(
      [
        { id: assetA, kind: "image/png", listingId },
        { id: assetB, kind: "image/png", listingId: null },
      ],
      { id: listingId, note: "intake" },
    );

    expect((await handler(post([assetA, assetB]))).status).toBe(409);
  });

  it("refuses when the same assets arrive with a different note", async () => {
    // Same key, different payload. Returning the stored listing would silently
    // discard what the operator just typed.
    const { handler } = harness(
      [{ id: assetA, kind: "image/png", listingId }],
      { id: listingId, note: "intake" },
    );

    expect((await handler(post([assetA], "something else"))).status).toBe(409);
  });

  it("refuses when the owning listing no longer exists", async () => {
    const { handler } = harness(
      [{ id: assetA, kind: "image/png", listingId }],
      null,
    );

    expect((await handler(post([assetA]))).status).toBe(409);
  });
});
