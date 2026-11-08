import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  accept: "ok" as "ok" | "blocked" | "conflict",
  enqueueFails: false,
  enqueued: [] as unknown[],
  attempts: [] as string[],
}));

vi.mock("./wine-enrichment-service", () => ({
  prepareWineAdmission: async () => ({}),
  recoverableWineAdmission: () => false,
}));
vi.mock("./listing-recovery-readiness", () => ({
  requireListingRecovery: async () => undefined,
}));
vi.mock("./listing-operation-service", async () => {
  const { ApiError } = await import("./route-support");
  return {
    acceptListingOperation: async () => {
      if (state.accept === "conflict") throw new Error("unexpected conflict");
      if (state.accept === "blocked")
        throw new ApiError(
          403,
          "ai_configuration_required",
          "AI configuration required.",
        );
      return {
        processing: {
          runId: "run-1",
          jobId: "job-1",
          state: "queued",
          pollAfterMs: 1000,
        },
        outbox: [
          {
            id: "out-1",
            listingId: "listing-created",
            dedupeKey: "listing:ws_test:listing-created:0",
            payload: { workspaceId: "ws_test", runId: "run-1" },
            attempts: 0,
          },
        ],
        run: {
          id: "run-1",
          idempotencyKey: "listing:ws_test:listing-created:0",
          inputRevision: 1,
          baseVersionId: null,
          runAttempt: 1,
          executionState: "queued",
          activeVersionSequence: 1,
        },
      };
    },
  };
});
// The dispatch helper parses outbox rows with the reviewed job schemas; this
// test only needs the parse boundary, not the real job shape.
vi.mock("@wukong/jobs", () => ({
  listingJobSchema: { or: () => ({ parse: (value: unknown) => value }) },
  wineListingJobSchema: { or: () => ({ parse: (value: unknown) => value }) },
}));

import {
  createListingIntake,
  type ListingIntakeDeps,
} from "./listing-intake-service";

const ASSET_A = "11111111-1111-4111-8111-111111111111";
const ASSET_B = "22222222-2222-4222-8222-222222222222";

type FakeState = {
  listings: Array<{
    id: string;
    status: string;
    target: string;
    note: string | null;
  }>;
  assets: Map<string, { id: string; kind: string; listingId: string | null }>;
  audits: Array<{ action: string; metadata?: Record<string, unknown> }>;
  dispatched: string[][];
  attempted: string[][];
  recorded: unknown[];
};

function fixture(
  input: {
    role?: "viewer" | "operator" | "reviewer" | "admin" | "owner";
    assets?: Map<
      string,
      { id: string; kind: string; listingId: string | null }
    >;
    failGetDatabase?: boolean;
  } = {},
) {
  const fake: FakeState = {
    listings: [],
    assets:
      input.assets ??
      new Map([
        [ASSET_A, { id: ASSET_A, kind: "image/png", listingId: null }],
        [ASSET_B, { id: ASSET_B, kind: "image/jpeg", listingId: null }],
      ]),
    audits: [],
    dispatched: [],
    attempted: [],
    recorded: [],
  };
  const repositories = {
    pipelineRuns: {
      lockCreateRequests: async () => undefined,
      findCreateRequest: async () => null,
      recordCreateRequest: async (...args: unknown[]) => {
        fake.recorded.push(args);
      },
    },
    sourceAssets: {
      getByIds: async (ids: string[]) =>
        ids.flatMap((id) => {
          const asset = fake.assets.get(id);
          return asset ? [asset] : [];
        }),
      attachToListing: async (listingId: string, ids: string[]) => {
        for (const id of ids) {
          const asset = fake.assets.get(id);
          if (asset) asset.listingId = listingId;
        }
      },
    },
    listings: {
      getById: async (id: string) =>
        fake.listings.find((listing) => listing.id === id) ?? null,
      create: async (inputValue: { target: string; note: string | null }) => {
        const listing = {
          id: "listing-created",
          status: "received",
          target: inputValue.target,
          note: inputValue.note,
        };
        fake.listings.push(listing);
        return listing;
      },
    },
    listingInputs: {
      initialize: async () => ({ revision: 1, baseVersionId: null }),
    },
    audit: {
      write: async (event: {
        action: string;
        metadata?: Record<string, unknown>;
      }) => {
        fake.audits.push(event);
      },
    },
    dispatchOutbox: {
      markDispatched: async (ids: string[]) => {
        fake.dispatched.push(ids);
      },
      markAttempted: async (ids: string[]) => {
        fake.attempted.push(ids);
      },
    },
  };
  const deps: ListingIntakeDeps = {
    getDatabase: () => {
      if (input.failGetDatabase) throw new Error("database must not be read");
      return {
        forWorkspace: async (
          _workspaceId: string,
          work: (repos: unknown) => unknown,
        ) => work(repositories),
      } as never;
    },
    publisher: {
      enqueue: async (job: unknown) => {
        if (state.enqueueFails) throw new Error("queue unavailable");
        state.enqueued.push(job);
        return { id: "job-1" };
      },
    },
  };
  const context = {
    workspaceId: "ws_test",
    actorId: "actor_ops",
    role: input.role ?? "operator",
  } as const;
  return { fake, deps, context };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    sourceAssetIds: [ASSET_A, ASSET_B],
    note: "Draft these bottles",
    processingMode: "ai" as const,
    ...overrides,
  };
}

describe("createListingIntake", () => {
  it("refuses a non-operator before reading the database", async () => {
    const { deps, context } = fixture({
      role: "viewer",
      failGetDatabase: true,
    });
    await expect(
      createListingIntake(deps, { context, body: body(), requestKey: null }),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
  });

  it("creates the listing, attaches owned assets and reports the enqueued job", async () => {
    state.enqueueFails = false;
    state.enqueued = [];
    const { fake, deps, context } = fixture();

    const result = await createListingIntake(deps, {
      context,
      body: body(),
      requestKey: null,
    });

    expect(result.listing).toMatchObject({
      id: "listing-created",
      status: "received",
    });
    expect(result.processing?.runId).toBe("run-1");
    expect(result.queueState).toBe("enqueued");
    expect(result.replayed).toBe(false);
    expect(fake.listings).toHaveLength(1);
    expect(fake.assets.get(ASSET_A)?.listingId).toBe("listing-created");
    expect(fake.dispatched).toEqual([["out-1"]]);
    expect(fake.audits.map((audit) => audit.action)).toContain(
      "listing.created",
    );
  });

  it("keeps the persisted listing and reports queue_unavailable when enqueue fails", async () => {
    state.enqueueFails = true;
    state.enqueued = [];
    const { fake, deps, context } = fixture();

    const result = await createListingIntake(deps, {
      context,
      body: body(),
      requestKey: null,
    });

    state.enqueueFails = false;
    expect(result.listing.id).toBe("listing-created");
    expect(fake.listings).toHaveLength(1);
    expect(result.queueState).toBe("queue_unavailable");
    expect(fake.dispatched).toEqual([]);
    expect(fake.attempted).toEqual([["out-1"]]);
  });

  it("returns queue_unavailable when admission is recoverably blocked (no processing started)", async () => {
    state.accept = "blocked";
    const { deps, context } = fixture();
    const result = await createListingIntake(deps, {
      context,
      body: body(),
      requestKey: null,
    });
    state.accept = "ok";
    expect(result.processing).toBeNull();
    expect(result.processingBlocked?.code).toBe("ai_configuration_required");
    expect(result.queueState).toBe("queue_unavailable");
  });

  it("refuses foreign or missing source assets with the same 404", async () => {
    const { fake, deps, context } = fixture();
    await expect(
      createListingIntake(deps, {
        context,
        body: body({
          sourceAssetIds: ["33333333-3333-4333-8333-333333333333"],
        }),
        requestKey: null,
      }),
    ).rejects.toMatchObject({ status: 404, code: "source_assets_not_found" });
    expect(fake.listings).toHaveLength(0);
  });

  it("re-enqueues and reports a reused listing for an asset set that already created one", async () => {
    state.enqueueFails = false;
    state.enqueued = [];
    const { fake, deps, context } = fixture();
    await createListingIntake(deps, {
      context,
      body: body(),
      requestKey: null,
    });
    const enqueuedAfterFirst = state.enqueued.length;
    const result = await createListingIntake(deps, {
      context,
      body: body(),
      requestKey: null,
    });
    expect(result.replayed).toBe(false);
    expect(result.reusedExisting).toBe(true);
    expect(result.queueState).toBe("enqueued");
    // Original intake behaviour: a reused asset set re-enqueues, because the
    // first attempt's enqueue may have failed.
    expect(state.enqueued.length).toBe(enqueuedAfterFirst + 1);
    expect(fake.listings).toHaveLength(1);
  });
});
