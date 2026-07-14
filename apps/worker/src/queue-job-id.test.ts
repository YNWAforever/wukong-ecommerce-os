import { describe, expect, it } from "vitest";

import { bullmqListingJobId } from "./queue.js";
import { listingPipelineJobId } from "./listing-pipeline.js";

describe("BullMQ job ID transport mapping", () => {
  it("preserves the exact canonical idempotency key while mapping it collision-free to BullMQ", () => {
    const first = { workspaceId: "ws_opak", draftId: "draft_1", activeVersionSequence: 4 };
    const second = { workspaceId: "ws_opak", draftId: "draft_2", activeVersionSequence: 4 };
    const canonical = listingPipelineJobId(first);
    const encoded = bullmqListingJobId(first);

    expect(canonical).toBe("listing:ws_opak:draft_1:4");
    expect(encoded).not.toContain(":");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe(canonical);
    expect(bullmqListingJobId(second)).not.toBe(encoded);
    expect(bullmqListingJobId(first)).toBe(encoded);
  });
});
