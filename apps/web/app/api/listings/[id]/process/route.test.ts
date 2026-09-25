import { describe, expect, it, vi } from "vitest";

import { createProcessListingHandler } from "./route.js";

const listingId = "00000000-0000-4000-8000-000000000101";
const runId = "00000000-0000-4000-8000-000000000201";
const requestKey = "00000000-0000-4000-8000-000000000401";

function request(body: Record<string, unknown> = {}) {
  return new Request(`http://localhost/api/listings/${listingId}/process`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": requestKey,
    },
    body: JSON.stringify(body),
  });
}

function routeContext(id = listingId) {
  return { params: Promise.resolve({ id }) };
}

function harness(
  options: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    status?: string;
    publisherFails?: boolean;
  } = {},
) {
  vi.stubEnv("AI_PROVIDER", "fake");
  const listing = {
    id: listingId,
    status: options.status ?? "received",
    inputRevision: 1,
    activeVersionId: null,
    activeVersionSequence: 0,
  };
  const run = {
    id: runId,
    idempotencyKey: `listing:ws_opak:${listingId}:run:${runId}`,
    inputRevision: 1,
    baseVersionId: null,
    runAttempt: 1,
    executionState: "queued",
    activeVersionSequence: 0,
    requestDigest: "digest",
  };
  let replay: typeof run | null = null;
  const accepted: (typeof run)[] = [];
  const outbox = [
    {
      id: "outbox_1",
      listingId,
      dedupeKey: run.idempotencyKey,
      attempts: 0,
      payload: {
        schemaVersion: 2,
        workspaceId: "ws_opak",
        draftId: listingId,
        runId,
        inputRevision: 1,
        activeVersionSequence: 0,
      },
    },
  ];
  const markDispatched = vi.fn(async () => undefined);
  const markAttempted = vi.fn(async () => undefined);
  const repositories = {
    listings: {
      lockReviewState: vi.fn(async () => undefined),
      getById: vi.fn(async (id: string) => (id === listingId ? listing : null)),
      requireById: vi.fn(async () => listing),
    },
    listingInputs: {
      initialize: vi.fn(async () => ({ revision: 1, baseVersionId: null })),
      getCurrent: vi.fn(async () => ({
        revision: 1,
        baseVersionId: null,
        workingContent: {},
      })),
    },
    pipelineRuns: {
      findOperationRequest: vi.fn(async () => replay),
      acceptOperation: vi.fn(async (input: { requestDigest: string }) => {
        run.requestDigest = input.requestDigest;
        accepted.push(run);
        replay = run;
        return run;
      }),
    },
    dispatchOutbox: {
      record: vi.fn(async () => outbox),
      markDispatched,
      markAttempted,
    },
    audit: { write: vi.fn(async () => undefined) },
  };
  const enqueue = vi.fn(async () => {
    if (options.publisherFails) throw new Error("synthetic queue failure");
    return { id: run.idempotencyKey };
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
        work: (repos: typeof repositories) => Promise<T>,
      ) {
        expect(workspaceId).toBe("ws_opak");
        return work(repositories);
      },
    }),
    publisher: { enqueue },
  });
  return {
    handler,
    enqueue,
    accepted,
    repositories,
    markDispatched,
    markAttempted,
    listing,
  };
}

describe("POST /api/listings/[id]/process immutable acceptance", () => {
  it.each(["operator", "reviewer", "admin", "owner"] as const)(
    "accepts a queued operation for %s",
    async (role) => {
      const test = harness({ role });
      const response = await test.handler(
        request({ expectedInputRevision: 1, baseVersionId: null }),
        routeContext(),
      );

      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        processing: {
          runId,
          jobId: `listing:ws_opak:${listingId}:run:${runId}`,
          state: "queued",
          pollAfterMs: 3000,
        },
      });
      expect(test.accepted).toHaveLength(1);
      expect(test.markDispatched).toHaveBeenCalledWith(["outbox_1"]);
    },
  );

  it("keeps the accepted queued run and outbox when immediate send fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const test = harness({ publisherFails: true });

    const response = await test.handler(request(), routeContext());

    expect(response.status).toBe(202);
    expect((await response.json()).processing).toMatchObject({
      runId,
      state: "queued",
    });
    expect(test.accepted).toHaveLength(1);
    expect(test.markAttempted).toHaveBeenCalledWith(["outbox_1"]);
    expect(test.markDispatched).not.toHaveBeenCalled();
  });

  it("replays the same accepted run after the current input revision changes", async () => {
    const test = harness();
    const first = await test.handler(request(), routeContext());
    test.listing.inputRevision = 2;
    const second = await test.handler(request(), routeContext());

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await second.json()).processing.runId).toBe(runId);
    expect(test.accepted).toHaveLength(1);
    expect(test.enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects stale input revisions before accepting work", async () => {
    const test = harness();
    const response = await test.handler(
      request({ expectedInputRevision: 0 }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "input_revision_conflict",
    });
    expect(test.accepted).toHaveLength(0);
  });

  it("preserves role and workspace ownership guards", async () => {
    const viewer = harness({ role: "viewer" });
    expect((await viewer.handler(request(), routeContext())).status).toBe(403);
    expect(viewer.accepted).toHaveLength(0);

    const foreign = harness();
    const response = await foreign.handler(
      request(),
      routeContext("00000000-0000-4000-8000-000000000999"),
    );
    expect(response.status).toBe(404);
    expect(foreign.accepted).toHaveLength(0);
  });

  it("rejects malformed UUID-shaped IDs before entering the database", async () => {
    const test = harness();
    const response = await test.handler(
      request(),
      routeContext("-".repeat(36)),
    );

    expect(response.status).toBe(404);
    expect(test.repositories.listings.lockReviewState).not.toHaveBeenCalled();
  });

  it("does not accept new work while publishing", async () => {
    const test = harness({ status: "publishing" });
    const response = await test.handler(request(), routeContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "listing_not_retryable",
    });
    expect(test.accepted).toHaveLength(0);
  });
});
