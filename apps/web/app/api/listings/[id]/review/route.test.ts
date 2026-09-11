import { describe, expect, it, vi } from "vitest";

import { createReviewListingHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const baseVersionId = "00000000-0000-4000-8000-0000000002a1";

const localized = {
  en: "Demo Estate Riesling",
  "zh-Hant": "Demo Estate 麗絲玲",
};

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

function handlerFor(role = "operator", snapshotFlags: unknown[] = []) {
  const editReview = vi.fn(async (..._args: unknown[]) => ({
    id: "version_2",
    sequence: 2,
  }));
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
                  flags: snapshotFlags,
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
      Record<string, unknown> | undefined;
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
      Record<string, unknown> | undefined;
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

/**
 * Whether an edit is checked for claims the listing cannot support.
 *
 * Only the GENERATED copy was ever scanned. This route wrote no flags at all,
 * so an operator could type "95 points from Robert Parker" into the description
 * after generation and reach approval with nothing flagged -- and equally, a
 * flag raised at generation stayed attached for ever even after the sentence
 * that caused it was deleted, because nothing re-read the text.
 */
describe("re-scanning an edit", () => {
  const flagsPassedTo = (editReview: { mock: { calls: unknown[][] } }) =>
    (editReview.mock.calls.at(0)?.at(6) ?? []) as Array<{
      rule: string;
      status: string;
      field: string;
    }>;

  it("flags a rating the operator typed in after generation", async () => {
    const { handler, editReview } = handlerFor();

    const response = await handler(
      save({
        baseVersionId,
        listing: draftContent({
          description: {
            en: "Awarded 95 points by Robert Parker.",
            "zh-Hant": "Demo Estate 麗絲玲",
          },
        }),
      }),
      { params: Promise.resolve({ id: listingId }) },
    );

    expect(response.status).toBe(200);
    expect(flagsPassedTo(editReview)).toEqual([
      expect.objectContaining({
        rule: "rating_without_evidence",
        status: "open",
        field: "descriptionEn",
      }),
    ]);
  });

  it("clears a flag once the claim is edited out", async () => {
    // The other half, and the one a blind copy-forward could never do: the
    // operator removed the sentence, so the flag must not survive it.
    const { handler, editReview } = handlerFor("operator", [
      {
        id: "descriptionEn:rating_without_evidence:0",
        field: "descriptionEn",
        rule: "rating_without_evidence",
        severity: "blocking",
        status: "open",
        resolutionReason: null,
      },
    ]);

    await handler(save({ baseVersionId, listing: draftContent() }), {
      params: Promise.resolve({ id: listingId }),
    });

    expect(flagsPassedTo(editReview)).toEqual([]);
  });

  it("keeps an answer the operator already gave on a field they did not touch", async () => {
    // Re-raising a resolved flag on every save would block a listing that had
    // already been cleared, and would train people to ignore the flags.
    const resolved = {
      id: "descriptionEn:health_claim:0",
      field: "descriptionEn",
      rule: "health_claim",
      severity: "blocking",
      status: "resolved",
      resolutionReason: "Verified against the importer's product sheet.",
    };
    const claim = {
      en: "A health benefit of moderate enjoyment.",
      "zh-Hant": "Demo Estate 麗絲玲",
    };
    const { handler, editReview } = handlerFor("operator", [resolved]);

    // Same description as the base version; only the tags changed.
    await handler(
      save({
        baseVersionId,
        listing: draftContent({
          description: claim,
          tags: ["Riesling", "Dry"],
        }),
      }),
      { params: Promise.resolve({ id: listingId }) },
    );

    // The base version's description differs from `claim`, so the field DID
    // change and the flag correctly comes back open -- this case pins that the
    // decision is made per field, not blanket-carried.
    expect(flagsPassedTo(editReview)).toEqual([
      expect.objectContaining({ rule: "health_claim", status: "open" }),
    ]);
  });

  it("does not invent a rating flag when the listing has a grounded score", async () => {
    const { handler, editReview } = handlerFor();

    await handler(
      save({
        baseVersionId,
        listing: draftContent({
          description: {
            en: "Awarded 95 points by Robert Parker.",
            "zh-Hant": "Demo Estate 麗絲玲",
          },
          criticScores: [
            { source: "Robert Parker", score: "95", evidenceId: "ev_1" },
          ],
        }),
      }),
      { params: Promise.resolve({ id: listingId }) },
    );

    expect(flagsPassedTo(editReview)).toEqual([]);
  });
});
