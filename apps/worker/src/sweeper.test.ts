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
    close: vi.fn(async () => undefined),
  };
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
