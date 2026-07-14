import { describe, expect, it } from "vitest";

import { createDeliverListingHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const ctx = { params: Promise.resolve({ id: listingId }) };
const request = (method = "csv") => new Request("http://localhost", {
  method: "POST",
  body: JSON.stringify({ method }),
});

describe("delivery route hardening", () => {
  it("rejects a viewer before invoking delivery", async () => {
    let called = false;
    const handler = createDeliverListingHandler({
      sessionContext: { async resolve() { return { workspaceId: "ws_opak", actorId: "viewer_1", role: "viewer" }; } },
      delivery: { async deliver() { called = true; return { kind: "approval_required" }; } },
    });
    const response = await handler(request(), ctx);
    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  it("maps a foreign valid UUID to 404", async () => {
    const handler = createDeliverListingHandler({
      sessionContext: { async resolve() { return { workspaceId: "ws_opak", actorId: "reviewer_1", role: "reviewer" }; } },
      delivery: { async deliver() { throw new Error("listing not found"); } },
    });
    const response = await handler(request(), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "listing_not_found" });
  });
});
