import { describe, expect, it } from "vitest";

import { getListingActivity } from "./listing-activity-service";

describe("getListingActivity", () => {
  it("merges audit events, batch membership, and export-manifest membership, sorted newest first", async () => {
    const listingId = "listing_1";
    const repositories = {
      audit: {
        findRelatedToListing: async () => [
          {
            id: "audit_1",
            actorId: "user_1",
            entityId: listingId,
            action: "listing.approved",
            metadata: {},
            createdAt: new Date("2026-09-01T10:00:00Z"),
          },
        ],
      },
      enrichmentBatches: {
        listBatchesForListing: async () => [
          {
            batchId: "batch_1",
            label: "Batch A",
            status: "completed" as const,
            createdAt: new Date("2026-09-02T10:00:00Z"),
          },
        ],
      },
      exportAttempts: {
        listContainingListing: async () => [
          {
            id: "export_1",
            outcome: "included" as const,
            artifactStatus: "failed" as const,
            provenanceComplete: true,
            reason: undefined,
            createdAt: new Date("2026-09-01T15:00:00Z"),
          },
        ],
      },
    };

    const activity = await getListingActivity(repositories, listingId);

    expect(activity.map((entry) => entry.kind)).toEqual([
      "batch",
      "export",
      "audit",
    ]);
    expect(activity[0]).toMatchObject({ kind: "batch", id: "batch_1" });
    expect(activity[1]).toMatchObject({
      kind: "export",
      id: "export_1",
      artifactStatus: "failed",
      provenanceComplete: true,
    });
    expect(activity[2]).toMatchObject({ kind: "audit", id: "audit_1" });
  });
});
