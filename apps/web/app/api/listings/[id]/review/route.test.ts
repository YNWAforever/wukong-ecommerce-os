import { describe, expect, it, vi } from "vitest";

import { createReviewListingHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const baseVersionId = "00000000-0000-4000-8000-0000000002a1";

const localized = { en: "Demo Estate Riesling", "zh-Hant": "Demo Estate 麗絲玲" };

/**
 * A draft an operator can genuinely produce from a photographed label: the
 * producer, origin, vintage, volume and ABV are all readable off the bottle,
 * and the merchant's own SKU, price and stock are not.
 */
function draftContent(overrides: Record<string, unknown> = {}) {
  return {
    sku: null,
    producer: "Demo Estate",
    productType: "wine",
    country: "Germany",
    region: "Mosel",
    vintage: 2024,
    grapeVarieties: ["Riesling"],
    volumeMl: 750,
    abvPercent: 12.5,
    packQuantity: 1,
    priceHkd: null,
    stockQuantity: null,
    criticScores: [],
    awards: [],
    title: localized,
    description: localized,
    seo: { title: localized, description: localized },
    tags: ["Riesling"],
    imageAssetIds: ["asset_1"],
    ...overrides,
  };
}

function handlerFor(role = "operator") {
  const editReview = vi.fn(
    async (..._args: unknown[]) => ({ id: "version_2", sequence: 2 }),
  );
  const handler = createReviewListingHandler({
    sessionContext: {
      async resolve() {
        return { workspaceId: "ws_opak", actorId: "user_1", role };
      },
    } as never,
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
                    id: baseVersionId,
                    sequence: 1,
                    content: draftContent(),
                  },
                  evidence: [],
                  flags: [],
                };
              },
              editReview,
            },
            audit: { async write() {} },
          });
        },
      }) as never,
  });
  return { handler, editReview };
}

function save(body: unknown) {
  return new Request("http://localhost", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/listings/[id]/review", () => {
  it("saves a draft whose SKU, price and stock are still unknown", async () => {
    // The whole point of F10. canonicalListingSchema re-tightens these three to
    // non-null, so the entire payload used to be rejected for the two fields
    // the operator does not have yet -- losing the nine they do.
    const { handler, editReview } = handlerFor();

    const response = await handler(
      save({ baseVersionId, listing: draftContent() }),
      { params: Promise.resolve({ id: listingId }) },
    );

    expect(response.status).toBe(200);
    expect(editReview).toHaveBeenCalledOnce();
    const saved = editReview.mock.calls.at(0)?.at(2) as
      | Record<string, unknown>
      | undefined;
    expect(saved).toBeDefined();
    expect(saved!.producer).toBe("Demo Estate");
    expect(saved!.volumeMl).toBe(750);
    // Absent stays absent. Nothing is invented to satisfy the schema.
    expect(saved!.sku).toBeNull();
    expect(saved!.priceHkd).toBeNull();
    expect(saved!.stockQuantity).toBeNull();
  });

  it("still saves a fully complete draft", async () => {
    const { handler, editReview } = handlerFor();

    const response = await handler(
      save({
        baseVersionId,
        listing: draftContent({
          sku: "OPAK-1",
          priceHkd: 288,
          stockQuantity: 6,
        }),
      }),
      { params: Promise.resolve({ id: listingId }) },
    );

    expect(response.status).toBe(200);
    const saved = editReview.mock.calls.at(0)?.at(2) as
      | Record<string, unknown>
      | undefined;
    expect(saved).toBeDefined();
    expect(saved!.sku).toBe("OPAK-1");
    expect(saved!.priceHkd).toBe(288);
  });

  it("still requires the bilingual copy a reviewer reads", async () => {
    // Relaxing the commercial facts must not relax the content itself: title,
    // description, SEO, tags and images stay required.
    const { handler, editReview } = handlerFor();

    const response = await handler(
      save({ baseVersionId, listing: draftContent({ title: undefined }) }),
      { params: Promise.resolve({ id: listingId }) },
    );

    expect(response.status).toBe(400);
    expect(editReview).not.toHaveBeenCalled();
  });

  it("rejects a value that is wrong rather than merely absent", async () => {
    const { handler, editReview } = handlerFor();

    const response = await handler(
      save({ baseVersionId, listing: draftContent({ volumeMl: -750 }) }),
      { params: Promise.resolve({ id: listingId }) },
    );

    expect(response.status).toBe(400);
    expect(editReview).not.toHaveBeenCalled();
  });

  it("refuses a save aimed at a version that is no longer active", async () => {
    const { handler, editReview } = handlerFor();

    const response = await handler(
      save({
        baseVersionId: "00000000-0000-4000-8000-0000000009f9",
        listing: draftContent(),
      }),
      { params: Promise.resolve({ id: listingId }) },
    );

    expect(response.status).toBe(409);
    expect(editReview).not.toHaveBeenCalled();
  });

  it("refuses a viewer", async () => {
    const { handler, editReview } = handlerFor("viewer");

    const response = await handler(
      save({ baseVersionId, listing: draftContent() }),
      { params: Promise.resolve({ id: listingId }) },
    );

    expect(response.status).toBe(403);
    expect(editReview).not.toHaveBeenCalled();
  });
});
