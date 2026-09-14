import { describe, expect, it, vi } from "vitest";

import { handleScheduled } from "./sweeper.js";
import type { WorkerEnv } from "./worker-env.js";

function env(send = vi.fn(async () => undefined)): WorkerEnv {
  return {
    HYPERDRIVE: { connectionString: "opaque-connection-string" } as never,
    LISTING_QUEUE: { send } as never,
    SHOPLINE_QUEUE: { send: vi.fn() } as never,
  } as WorkerEnv;
}

const job = {
  workspaceId: "ws_opak",
  draftId: "00000000-0000-4000-8000-000000000001",
  activeVersionSequence: 0,
};

function makeDatabase(jobs: unknown[]) {
  return {
    findStuckListingJobs: vi.fn(async () => jobs),
    findStuckWebsiteScans: vi.fn(async () => []),
    findUndispatchedListingJobs: vi.fn(async () => [] as unknown[]),
    close: vi.fn(async () => undefined),
  };
}

/** A database whose outbox owes the given rows, with the marks recorded. */
function makeOutboxDatabase(rows: unknown[]) {
  const markDispatched = vi.fn(async () => undefined);
  const markAttempted = vi.fn(async () => undefined);
  const database = {
    ...makeDatabase([]),
    findUndispatchedListingJobs: vi.fn(async () => rows),
    forWorkspace: async (_workspaceId: string, work: any) =>
      work({ dispatchOutbox: { markDispatched, markAttempted } }),
  };
  return { database, markDispatched, markAttempted };
}

describe("handleScheduled", () => {
  it("re-enqueues every stuck job through the listing queue binding", async () => {
    const send = vi.fn(async () => undefined);
    const database = makeDatabase([job]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(database.findStuckListingJobs).toHaveBeenCalledWith({
      olderThanSeconds: 300,
      maxRows: 20,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(job);
    expect(database.close).toHaveBeenCalled();
  });

  it("skips a row that does not parse as a ListingJob", async () => {
    const send = vi.fn(async () => undefined);
    const database = makeDatabase([
      {
        workspaceId: "ws:bad",
        draftId: "not-a-uuid",
        activeVersionSequence: -1,
      },
      job,
    ]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(job);
  });

  it("catches a send failure, logs it, and still closes the database", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const send = vi.fn(async () => {
      throw new Error("queue send failed");
    });
    const database = makeDatabase([job]);

    await expect(
      handleScheduled(undefined as never, env(send), undefined as never, {
        createDatabase: () => database as never,
      }),
    ).resolves.toBeUndefined();

    expect(database.close).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("sweeper.requeue_failed"),
    );

    consoleError.mockRestore();
  });

  it("keeps processing the rest of the batch when one job's send fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const okJob = {
      workspaceId: "ws_other",
      draftId: "00000000-0000-4000-8000-000000000002",
      activeVersionSequence: 1,
    };
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("queue send failed"))
      .mockResolvedValueOnce(undefined);
    const database = makeDatabase([job, okJob]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, job);
    expect(send).toHaveBeenNthCalledWith(2, okJob);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("sweeper.requeue_failed"),
    );
    expect(consoleInfo).toHaveBeenCalledWith(
      JSON.stringify({ event: "sweeper.completed", requeued: 1, failed: 1 }),
    );

    consoleError.mockRestore();
    consoleInfo.mockRestore();
  });

  it("does nothing when no jobs are stuck", async () => {
    const send = vi.fn(async () => undefined);
    const database = makeDatabase([]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(send).not.toHaveBeenCalled();
    expect(database.close).toHaveBeenCalled();
  });
});

it("reconciles the oldest bounded website scan identities on the existing queue", async () => {
  const send = vi.fn();
  const recordDispatch = vi.fn();
  const websiteJob = { workspaceId: "ws", scanId: job.draftId, revision: 2 };
  const database = {
    ...makeDatabase([]),
    findStuckWebsiteScans: vi.fn(async () => [websiteJob]),
    forWorkspace: async (ws: string, work: any) => {
      expect(ws).toBe("ws");
      return work({ websiteCatalog: { recordDispatch } });
    },
  };
  await handleScheduled(undefined as never, env(send), undefined as never, {
    createDatabase: () => database as never,
  });
  expect(database.findStuckWebsiteScans).toHaveBeenCalledWith({ maxRows: 10 });
  expect(send).toHaveBeenCalledWith({ kind: "website_scan", ...websiteJob });
  expect(recordDispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      scanId: websiteJob.scanId,
      revision: 2,
      status: "sent",
    }),
  );
});
it("records failed website recovery dispatch for the next bounded sweep", async () => {
  const send = vi.fn(async () => {
    throw new Error("unavailable");
  });
  const recordDispatch = vi.fn();
  const database = {
    ...makeDatabase([]),
    findStuckWebsiteScans: vi.fn(async () => [
      { workspaceId: "ws", scanId: job.draftId, revision: 0 },
    ]),
    forWorkspace: async (_ws: string, work: any) =>
      work({ websiteCatalog: { recordDispatch } }),
  };
  await handleScheduled(undefined as never, env(send), undefined as never, {
    createDatabase: () => database as never,
  });
  expect(recordDispatch).toHaveBeenCalledWith(
    expect.objectContaining({ status: "failed" }),
  );
  expect(database.close).toHaveBeenCalledOnce();
});

/**
 * Work recorded in the outbox that nobody will ever advance again.
 *
 * The outbox heals only inside `advanceBatch`, and `advanceBatch` runs only
 * when an operator presses Advance on that one batch. A workspace whose batches
 * have all reached `completed` or `budget_exhausted` never re-reads its own
 * outbox, so a row stranded by a request that died stays owed for ever. The
 * cron is the only thing that runs without being asked.
 */
describe("outbox recovery", () => {
  const owed = {
    workspaceId: "ws_opak",
    outboxId: "3f1f7a52-0d8e-4a52-9a1a-3a2b1c0d9e88",
    payload: job,
  };

  it("sends work nobody advanced and confirms it in the same tick", async () => {
    const send = vi.fn(async () => undefined);
    const { database, markDispatched, markAttempted } = makeOutboxDatabase([
      owed,
    ]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(database.findUndispatchedListingJobs).toHaveBeenCalledWith({
      // Longer than the web app's own 60s grace window, so the cron cannot
      // re-send messages an advance is still in the middle of sending.
      olderThanSeconds: 300,
      maxRows: 20,
      maxAttempts: 5,
    });
    expect(send).toHaveBeenCalledWith(job);
    expect(markDispatched).toHaveBeenCalledWith([owed.outboxId]);
    expect(markAttempted).not.toHaveBeenCalled();
  });

  it("counts a failed send as an attempt rather than confirming it", async () => {
    // Confirming an unsent row would lose the work permanently: nothing else
    // reads the outbox, so a row marked dispatched is never looked at again.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const send = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const { database, markDispatched, markAttempted } = makeOutboxDatabase([
      owed,
    ]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(markDispatched).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith([owed.outboxId]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("outbox_sweeper.send_failed"),
    );

    consoleError.mockRestore();
  });

  it("refuses a payload addressed to a different workspace than its row", async () => {
    // Workspace scoping is the security boundary. A row whose stored payload
    // names another tenant must never be put on the queue, whatever wrote it.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const send = vi.fn(async () => undefined);
    const { database, markDispatched, markAttempted } = makeOutboxDatabase([
      { ...owed, payload: { ...job, workspaceId: "ws_someone_else" } },
    ]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(send).not.toHaveBeenCalled();
    expect(markDispatched).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith([owed.outboxId]);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("outbox_sweeper.unusable"),
    );

    consoleError.mockRestore();
  });

  it("counts an unparsable payload so it can reach the attempt cap", async () => {
    // Skipping it silently, as the draft sweeper does, would leave a row the
    // queue can never accept being retried every five minutes for ever: the
    // attempt count only rises if something records the attempt.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const send = vi.fn(async () => undefined);
    const { database, markAttempted } = makeOutboxDatabase([
      { ...owed, payload: { draftId: "not-a-uuid" } },
    ]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(send).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith([owed.outboxId]);

    consoleError.mockRestore();
  });

  it("marks each workspace through its own scope", async () => {
    // One tick spans tenants. Marking them together would need a cross-tenant
    // write, which RLS forbids and which no repository offers.
    const send = vi.fn(async () => undefined);
    const scopes: string[] = [];
    const markDispatched = vi.fn(async () => undefined);
    const database = {
      ...makeDatabase([]),
      findUndispatchedListingJobs: vi.fn(async () => [
        owed,
        {
          workspaceId: "ws_other",
          outboxId: "9c2a8d41-55b1-4f0e-9d3c-11aa22bb33cc",
          payload: { ...job, workspaceId: "ws_other" },
        },
      ]),
      forWorkspace: async (workspaceId: string, work: any) => {
        scopes.push(workspaceId);
        return work({
          dispatchOutbox: { markDispatched, markAttempted: vi.fn() },
        });
      },
    };

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(scopes).toEqual(["ws_opak", "ws_other"]);
  });

  it("reports its own totals without disturbing the draft sweeper's", async () => {
    const consoleInfo = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const send = vi.fn(async () => undefined);
    const { database } = makeOutboxDatabase([owed]);

    await handleScheduled(undefined as never, env(send), undefined as never, {
      createDatabase: () => database as never,
    });

    expect(consoleInfo).toHaveBeenCalledWith(
      JSON.stringify({
        event: "outbox_sweeper.completed",
        requeued: 1,
        failed: 0,
      }),
    );
    expect(consoleInfo).toHaveBeenCalledWith(
      JSON.stringify({ event: "sweeper.completed", requeued: 0, failed: 0 }),
    );

    consoleInfo.mockRestore();
  });
});
