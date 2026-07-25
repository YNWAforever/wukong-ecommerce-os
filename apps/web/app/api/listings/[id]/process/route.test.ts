import { describe, expect, it, vi } from "vitest";

import { createProcessListingHandler } from "./route.js";
import { listingApplicationJobId } from "../../../../../lib/listing-queue-runtime.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const foreignListingId = "00000000-0000-4000-8000-000000000999";
const request = new Request(
  `http://localhost/api/listings/${listingId}/process`,
  {
    method: "POST",
  },
);

type HandlerOptions = {
  role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
  status?: string;
  assets?: number;
  pipelineState?: "started" | "succeeded" | "failed" | null;
  enqueueError?: boolean;
};

function handlerFor(options: HandlerOptions = {}) {
  const listing = {
    id: listingId,
    status: options.status ?? "received",
    activeVersionSequence: 0,
  };
  const enqueue = vi.fn(async () => {
    if (options.enqueueError) throw new Error("Redis unavailable");
    return { id: "job_1" };
  });
  const pipelineRunKeys: string[] = [];
  const reopenedKeys: string[] = [];

  const handler = createProcessListingHandler({
    sessionContext: {
      async resolve() {
        return {
          workspaceId: "ws_opak",
          actorId: "user_1",
          role: options.role ?? "operator",
        };
      },
    },
    getDatabase: () => ({
      async forWorkspace<T>(
        workspaceId: string,
        work: (repositories: any) => Promise<T>,
      ) {
        expect(workspaceId).toBe("ws_opak");
        return work({
          listings: {
            async getById(id: string) {
              return id === listingId ? listing : null;
            },
            async requireById(id: string) {
              if (id !== listingId) throw new Error("listing not found");
              return listing;
            },
          },
          sourceAssets: {
            async listForListing(id: string) {
              if (id !== listingId) return [];
              return Array.from(
                { length: options.assets ?? 1 },
                (_, index) => ({
                  id: `asset_${index + 1}`,
                }),
              );
            },
          },
          pipelineRuns: {
            async getState(key: string) {
              pipelineRunKeys.push(key);
              // Shape matches the repository, which returns a run record.
              return options.pipelineState
                ? { status: options.pipelineState }
                : null;
            },
            async reopenFailed(key: string) {
              reopenedKeys.push(key);
              return true;
            },
          },
        });
      },
    }),
    publisher: { enqueue },
  });

  return { handler, enqueue, listing, pipelineRunKeys, reopenedKeys };
}

function context(id = listingId) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/listings/[id]/process", () => {
  it.each(["operator", "reviewer", "admin", "owner"] as const)(
    "allows %s to repair a received listing",
    async (role) => {
      const { handler } = handlerFor({ role, status: "received", assets: 1 });

      const response = await handler(request, context());

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        processing: { state: "queued", jobId: "job_1" },
      });
    },
  );

  it("uses the publisher application ID to deduplicate a manual retry", async () => {
    const { handler, enqueue, pipelineRunKeys } = handlerFor();

    await handler(request, context());

    const input = {
      workspaceId: "ws_opak",
      draftId: listingId,
      activeVersionSequence: 0,
    };
    const applicationJobId = listingApplicationJobId(input);
    expect(applicationJobId).toBe(
      "listing:ws_opak:00000000-0000-4000-8000-000000000101:0",
    );
    expect(pipelineRunKeys).toEqual([applicationJobId]);
    expect(enqueue).toHaveBeenCalledWith(input);
  });

  it("rejects viewers", async () => {
    const { handler, enqueue } = handlerFor({ role: "viewer" });

    expect((await handler(request, context())).status).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // `needs_info` and `failed` are deliberately absent: the workflow state
  // machine allows processing to start from both, and refusing them left a
  // failed listing with no operator-reachable recovery.
  it.each([
    "processing",
    "in_review",
    "approved",
    "publishing",
    "published",
    "reopened",
  ])("rejects status %s that cannot start processing", async (status) => {
    const { handler, enqueue } = handlerFor({ status });

    expect((await handler(request, context())).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rejects a received listing with no finalized assets", async () => {
    const { handler, enqueue } = handlerFor({ status: "received", assets: 0 });

    expect((await handler(request, context())).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-drives a listing the pipeline gave up on", async () => {
    // Before this, a failed listing was unreachable: the status guard rejected
    // anything but `received`, and the run-state guard rejected any existing
    // run. Recovery meant an engineer replaying the dead-letter queue by hand.
    const { handler, enqueue, reopenedKeys } = handlerFor({
      status: "failed",
      pipelineState: "failed",
    });

    const response = await handler(request, context());

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(reopenedKeys).toHaveLength(1);
  });

  it("re-drives a listing that stopped for missing information", async () => {
    const { handler, enqueue } = handlerFor({ status: "needs_info" });

    expect((await handler(request, context())).status).toBe(202);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("still refuses a listing that is already past processing", async () => {
    const { handler, enqueue } = handlerFor({ status: "in_review" });

    expect((await handler(request, context())).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not reopen a run that is still in flight", async () => {
    const { handler, reopenedKeys } = handlerFor({
      status: "failed",
      pipelineState: "started",
    });

    expect((await handler(request, context())).status).toBe(409);
    expect(reopenedKeys).toHaveLength(0);
  });

  it("rejects an existing pipeline run", async () => {
    const { handler, enqueue } = handlerFor({ pipelineState: "started" });

    expect((await handler(request, context())).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns 503 without changing the listing when Redis is unavailable", async () => {
    const { handler, listing } = handlerFor({ enqueueError: true });

    expect((await handler(request, context())).status).toBe(503);
    expect(listing.status).toBe("received");
  });

  it("returns 404 for a foreign listing without enqueueing", async () => {
    const { handler, enqueue } = handlerFor();

    expect((await handler(request, context(foreignListingId))).status).toBe(
      404,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
