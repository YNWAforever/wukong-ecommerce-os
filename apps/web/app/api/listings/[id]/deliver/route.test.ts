import { describe, expect, it } from "vitest";

import { createDeliverListingHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const versionId = "00000000-0000-4000-8000-000000000201";
const context = { workspaceId: "ws_opak", actorId: "reviewer_1", role: "reviewer" as const };

function routeContext() {
  return { params: Promise.resolve({ id: listingId }) };
}

function makeHandler(status: "in_review" | "approved", connection: "connected" | "disconnected" = "connected") {
  const calls: unknown[] = [];
  const handler = createDeliverListingHandler({
    sessionContext: { async resolve() { return context; } },
    delivery: {
      async deliver(input: any) {
        calls.push(input);
        if (status !== "approved") return { kind: "approval_required" as const };
        if (connection === "disconnected") return { kind: "disconnected" as const, csvFallback: { method: "csv", path: `/api/listings/${listingId}/deliver` } };
        return input.method === "csv"
          ? { kind: "csv" as const, versionId, body: "sku,price\r\nOPAK-001,288\r\n", specVersion: "shopline-csv-v1" }
          : { kind: "queued" as const, jobId: "job_1", versionId };
      },
    },
  });
  return { handler, calls };
}

describe("POST /api/listings/[id]/deliver", () => {
  it("returns 409 for CSV before approval", async () => {
    const { handler } = makeHandler("in_review");
    const response = await handler(new Request("http://localhost", { method: "POST", body: JSON.stringify({ method: "csv" }) }), routeContext());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "approval_required" });
  });

  it("returns disconnected API delivery with explicit CSV fallback metadata", async () => {
    const { handler } = makeHandler("approved", "disconnected");
    const response = await handler(new Request("http://localhost", { method: "POST", body: JSON.stringify({ method: "shopline_api" }) }), routeContext());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "shopline_disconnected", csvFallback: { method: "csv" } });
  });

  it("returns deterministic UTF-8 CRLF CSV content for an approved listing", async () => {
    const { handler, calls } = makeHandler("approved");
    const response = await handler(new Request("http://localhost", { method: "POST", body: JSON.stringify({ method: "csv" }) }), routeContext());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await response.text()).toContain("\r\n");
    expect(calls).toContainEqual(expect.objectContaining({ workspaceId: "ws_opak", draftId: listingId, method: "csv" }));
  });

  it("queues API delivery without calling a remote connector", async () => {
    const { handler } = makeHandler("approved");
    const response = await handler(new Request("http://localhost", { method: "POST", body: JSON.stringify({ method: "shopline_api" }) }), routeContext());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "queued", jobId: "job_1" });
  });
});
