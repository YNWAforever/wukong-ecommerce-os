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
  pipelineResultStatus?: "in_review" | "needs_info" | null;
  existingRunCount?: number;
  enqueueError?: boolean;
  unexpectedError?: boolean;
  shotRequest?: (input: {
    workspaceId: string;
    listingId: string;
    actorId: string;
  }) => Promise<{ state: string }>;
};

// What createListingPublisher actually throws: every ingress failure leaves it
// as a QueueIngressError carrying the reason.
function queueIngressError(reason: string): Error {
  const error = new Error("queue_unavailable");
  error.name = "QueueIngressError";
  return Object.assign(error, { reason });
}

function handlerFor(options: HandlerOptions = {}) {
  const listing = {
    id: listingId,
    status: options.status ?? "received",
    activeVersionSequence: 0,
  };
  const enqueue = vi.fn(async () => {
    if (options.unexpectedError) throw new TypeError("publisher exploded");
    if (options.enqueueError) throw queueIngressError("not_configured");
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
                ? {
                    status: options.pipelineState,
                    resultStatus: options.pipelineResultStatus ?? null,
                  }
                : null;
            },
            async countRuns() {
              return options.existingRunCount ?? 1;
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
    requestProductShot: options.shotRequest,
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

  it("returns 503 without changing the listing when the queue is unavailable", async () => {
    const { handler, listing } = handlerFor({ enqueueError: true });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handler(request, context());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: "queue_unavailable",
        message: "The processing queue is unavailable.",
      });
      // The reason has to survive the route. Rethrowing a generic ApiError here
      // discarded it, so the log could not distinguish an unset variable from
      // an unreachable Worker.
      expect(logged.mock.calls.map(([line]) => String(line))).toContain(
        JSON.stringify({
          event: "route_error",
          outcome: "failure",
          reason: "queue_unavailable",
          queueReason: "not_configured",
        }),
      );
      expect(listing.status).toBe("received");
    } finally {
      logged.mockRestore();
    }
  });

  it("does not label an unrelated fault a queue problem", async () => {
    const { handler, listing } = handlerFor({ unexpectedError: true });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await handler(request, context());
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        code: "internal_error",
        message: "The request could not be completed.",
      });
      expect(listing.status).toBe("received");
    } finally {
      logged.mockRestore();
    }
  });

  it("returns 404 for a foreign listing without enqueueing", async () => {
    const { handler, enqueue } = handlerFor();

    expect((await handler(request, context(foreignListingId))).status).toBe(
      404,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});

it("enqueues selected-source work even when text queueing fails", async () => {
  const shotRequest = vi.fn(async () => ({ state: "queued" }));
  const { handler } = handlerFor({ enqueueError: true, shotRequest });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await handler(request, context())).status).toBe(503);
    expect(shotRequest).toHaveBeenCalledWith({
      workspaceId: "ws_opak",
      listingId,
      actorId: "user_1",
    });
  } finally {
    logged.mockRestore();
  }
});
it("keeps text processing independent when image setup or enqueue fails", async () => {
  const shotRequest = vi.fn(async () => {
    throw new Error("queue_unavailable");
  });
  const { handler, enqueue } = handlerFor({ shotRequest });
  const result = await handler(request, context());
  expect(result.status).toBe(202);
  expect(enqueue).toHaveBeenCalledOnce();
  expect(await result.json()).toMatchObject({
    productShot: { state: "request_failed" },
  });
});

describe("re-running a listing that asked for more information", () => {
  it("enqueues a numbered new run instead of answering 409", async () => {
    // The needs_info run appended no version, so activeVersionSequence never
    // moved and the derived key still resolves to that completed run. Without
    // its own attempt number the operator could supply everything that was
    // missing and nothing would happen.
    const { handler, enqueue } = handlerFor({
      status: "needs_info",
      pipelineState: "succeeded",
      pipelineResultStatus: "needs_info",
      existingRunCount: 1,
    });

    const response = await handler(new Request("http://localhost"), {
      params: Promise.resolve({ id: listingId }),
    });

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: listingId, runAttempt: 1 }),
    );
  });

  it("numbers each further re-run from the runs already recorded", async () => {
    const { handler, enqueue } = handlerFor({
      status: "needs_info",
      pipelineState: "succeeded",
      pipelineResultStatus: "needs_info",
      existingRunCount: 3,
    });

    await handler(new Request("http://localhost"), {
      params: Promise.resolve({ id: listingId }),
    });

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ runAttempt: 3 }),
    );
  });

  it("does not reopen the completed run", async () => {
    // reopenFailed is for a failed run. A needs_info run succeeded, and
    // rewinding it would discard the extraction the screen reads back.
    const { handler, reopenedKeys } = handlerFor({
      status: "needs_info",
      pipelineState: "succeeded",
      pipelineResultStatus: "needs_info",
    });

    await handler(new Request("http://localhost"), {
      params: Promise.resolve({ id: listingId }),
    });

    expect(reopenedKeys).toEqual([]);
  });

  it("still refuses a run that is already in review", async () => {
    const { handler, enqueue } = handlerFor({
      status: "in_review",
      pipelineState: "succeeded",
      pipelineResultStatus: "in_review",
    });

    const response = await handler(new Request("http://localhost"), {
      params: Promise.resolve({ id: listingId }),
    });

    expect(response.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("still refuses a run a delivery is currently working on", async () => {
    const { handler, enqueue } = handlerFor({
      status: "needs_info",
      pipelineState: "started",
      pipelineResultStatus: null,
    });

    const response = await handler(new Request("http://localhost"), {
      params: Promise.resolve({ id: listingId }),
    });

    expect(response.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("a duplicate request must not buy a second run", () => {
  it("refuses while the newest run is still in flight", async () => {
    // Attempt 1 was started by an earlier click whose response was lost. A
    // second click must not enqueue attempt 2 and pay for the same extraction
    // twice.
    const { handler, enqueue } = handlerFor({
      status: "needs_info",
      pipelineState: "started",
      pipelineResultStatus: null,
      existingRunCount: 2,
    });

    const response = await handler(new Request("http://localhost"), {
      params: Promise.resolve({ id: listingId }),
    });

    expect(response.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("re-enqueues the same key when nothing is recorded yet", async () => {
    // Enqueued, but no delivery has claimed it, so no run row exists. Sending
    // the same key again is a no-op the pipeline deduplicates.
    const { handler, enqueue } = handlerFor({
      status: "received",
      pipelineState: null,
      existingRunCount: 0,
    });

    await handler(new Request("http://localhost"), {
      params: Promise.resolve({ id: listingId }),
    });

    const sent = enqueue.mock.calls.at(0)?.at(0) as
      Record<string, unknown> | undefined;
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty("runAttempt");
  });

  it("never puts runAttempt 0 on the wire", async () => {
    // A Worker deployed before the field existed parses strictly and would ack
    // an unrecognized key away, silently dropping the job.
    const { handler, enqueue } = handlerFor({
      status: "failed",
      pipelineState: "failed",
      existingRunCount: 1,
    });

    await handler(new Request("http://localhost"), {
      params: Promise.resolve({ id: listingId }),
    });

    const sent = enqueue.mock.calls.at(0)?.at(0) as
      Record<string, unknown> | undefined;
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty("runAttempt");
  });
});
