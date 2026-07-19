import { afterEach, describe, expect, it, vi } from "vitest";

import { createListingHandler } from "./route.js";

const assetId = "00000000-0000-4000-8000-000000000001";
const listingId = "listing_1";

type Enqueue = (input: {
  workspaceId: string;
  draftId: string;
  activeVersionSequence: number;
}) => Promise<{ id: string }>;

const sessionContext = {
  async resolve() {
    return {
      workspaceId: "ws_opak",
      actorId: "user_1",
      role: "operator",
    } as const;
  },
};

function requestForListing() {
  return new Request("http://localhost/api/listings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceAssetIds: [assetId], note: "intake" }),
  });
}

function harness(enqueue: Enqueue) {
  const mutations: string[] = [];
  let transactionCommitted = false;
  const repositories = {
    sourceAssets: {
      async getByIds() {
        return [{ id: assetId, kind: "image/png", listingId: null }];
      },
      async attachToListing() {
        mutations.push("attach");
      },
    },
    listings: {
      async create() {
        mutations.push("create");
        return { id: listingId, status: "received", target: "shopline" };
      },
    },
    audit: {
      async write() {
        mutations.push("audit");
      },
    },
  };
  const enqueueAfterCommit = vi.fn(async (input: Parameters<Enqueue>[0]) => {
    expect(transactionCommitted).toBe(true);
    return enqueue(input);
  });
  const handler = createListingHandler({
    sessionContext,
    getAssetStore: () => {
      throw new Error("unused");
    },
    getDatabase: () =>
      ({
        async forWorkspace<T>(
          workspaceId: string,
          work: (repos: typeof repositories) => Promise<T>,
        ) {
          expect(workspaceId).toBe("ws_opak");
          const result = await work(repositories);
          transactionCommitted = true;
          return result;
        },
      }) as never,
    publisher: { enqueue: enqueueAfterCommit },
  });

  return { handler, mutations, enqueue: enqueueAfterCommit };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/listings creation handoff", () => {
  it("publishes listing identity after commit and returns the job ID", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const test = harness(vi.fn(async () => ({ id: "job_1" })));

    const response = await test.handler(requestForListing());

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      listing: { id: listingId, status: "received", target: "shopline" },
      processing: { state: "queued", jobId: "job_1", errorCode: null },
    });
    expect(test.enqueue).toHaveBeenCalledWith({
      workspaceId: "ws_opak",
      draftId: listingId,
      activeVersionSequence: 0,
    });
  });

  it("returns the committed listing with a safe retry outcome when enqueue fails", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const enqueue = vi.fn<Enqueue>();
    enqueue.mockRejectedValueOnce(new Error("connect timeout"));
    const test = harness(enqueue);

    const response = await test.handler(requestForListing());

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      listing: { id: listingId, status: "received" },
      processing: {
        state: "retry_required",
        jobId: null,
        errorCode: "queue_unavailable",
      },
    });
    expect(test.mutations).toEqual(["create", "attach", "audit"]);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls.flat().join(" ")).toContain("queue_unavailable");
    expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
      "connect timeout",
    );
  });
});
