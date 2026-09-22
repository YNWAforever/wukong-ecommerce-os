import { expect, it, vi } from "vitest";
import { dispatchListingOperation } from "./dispatch-listing-operation";
import { createListingPublisher } from "./listing-queue-runtime";
it("publishes accepted wine initial stage with its stage key and marks durable delivery", async () => {
  const job = {
    schemaVersion: 2 as const,
    flowVersion: "wine-enrichment-v1" as const,
    workspaceId: "ws",
    draftId: "10000000-0000-4000-8000-000000000001",
    runId: "10000000-0000-4000-8000-000000000002",
    inputRevision: 1,
    activeVersionSequence: 0,
    stage: "generation" as const,
  };
  const send = vi.fn(async () => ({ accepted: true as const })),
    markDispatched = vi.fn(async () => {}),
    markAttempted = vi.fn(async () => {});
  const publisher = createListingPublisher({
    ingressClient: { enqueue: send },
  });
  const accepted = {
    run: { id: job.runId },
    outbox: [{ id: "outbox", payload: job }],
  };
  await dispatchListingOperation(
    {
      forWorkspace: async (
        _ws: string,
        work: (repos: never) => Promise<unknown>,
      ) => work({ dispatchOutbox: { markDispatched, markAttempted } } as never),
    } as never,
    "ws",
    accepted as never,
    publisher,
  );
  expect(send).toHaveBeenCalledWith("/ingress/listings", job);
  expect(markDispatched).toHaveBeenCalledWith(["outbox"]);
  expect(markAttempted).not.toHaveBeenCalled();
  expect(await publisher.enqueue(job)).toEqual({
    id: `wine-run:${job.runId}:generation`,
  });
});
