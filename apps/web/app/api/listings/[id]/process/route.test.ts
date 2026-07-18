import { describe, expect, it, vi } from "vitest";

import { createProcessListingHandler } from "./route.js";

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
  pipelineState?: string | null;
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
            async getState() {
              return options.pipelineState ?? null;
            },
          },
        });
      },
    }),
    publisher: { enqueue },
  });

  return { handler, enqueue, listing };
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

  it("rejects viewers", async () => {
    const { handler, enqueue } = handlerFor({ role: "viewer" });

    expect((await handler(request, context())).status).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(["processing", "needs_info", "in_review", "failed", "approved"])(
    "rejects non-received status %s",
    async (status) => {
      const { handler, enqueue } = handlerFor({ status });

      expect((await handler(request, context())).status).toBe(409);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it("rejects a received listing with no finalized assets", async () => {
    const { handler, enqueue } = handlerFor({ status: "received", assets: 0 });

    expect((await handler(request, context())).status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
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
