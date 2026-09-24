/**
 * What the last delivery of a product-shot message does.
 *
 * Product-shot messages ride the listing queue, so they share its retry budget
 * (`maxRetries: 3` in cloudflare-runtime.config.json, and `message.attempts` is
 * 1-based, so delivery 4 is the last). The consumer answered
 * `{retryAfterSeconds}` for every failure including that one, which moves the
 * message to `wukong-listing-dlq-*` -- a queue with no consumer. The attempt
 * row was then left `queued` with no error code and no audit event: the review
 * panel polled it every three seconds indefinitely, and the only action it
 * offered ("Retry queue") led straight back to the same disappearance.
 *
 * The rule these cases pin: the last delivery records a terminal state, but
 * only for an attempt that never reached a provider. Anything that might have
 * been charged keeps its message rather than being written off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), run: vi.fn() }));
vi.mock("./cloudflare-runtime.js", () => ({
  createProductShotRuntime: mocks.create,
}));
vi.mock("./product-shot-pipeline.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./product-shot-pipeline.js")>()),
  runProductShot: mocks.run,
}));

import {
  consumeProductShotMessage,
  PRODUCT_SHOT_MAX_ATTEMPTS,
} from "./product-shot-consumer.js";
import { ProductShotBudgetError } from "./product-shot-pipeline.js";

const job = {
  kind: "product_shot",
  workspaceId: "ws",
  draftId: "10000000-0000-4000-8000-000000000001",
  attemptId: "10000000-0000-4000-8000-000000000002",
};

const lastDelivery = {
  attempt: PRODUCT_SHOT_MAX_ATTEMPTS,
  maxAttempts: PRODUCT_SHOT_MAX_ATTEMPTS,
};

afterEach(() => {
  vi.restoreAllMocks();
  mocks.create.mockReset();
  mocks.run.mockReset();
});

/** A runtime whose repository answers `outcome` and records what it was asked. */
function runtime(outcome: "ended" | "skipped" | Error) {
  const finishUndispatched = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const close = vi.fn(async () => {});
  mocks.create.mockReturnValue({
    dependencies: {
      forWorkspace: async (
        _workspaceId: string,
        work: (repositories: unknown) => Promise<unknown>,
      ) => work({ productShots: { finishUndispatched } }),
    },
    close,
  });
  return { finishUndispatched, close };
}

describe("the final delivery of a product shot message", () => {
  it("records a terminal state and acks instead of dead-lettering", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { finishUndispatched, close } = runtime("ended");
    mocks.run.mockRejectedValueOnce(new Error("provider unreachable"));

    expect(
      await consumeProductShotMessage(job, {} as never, lastDelivery),
    ).toBe("ack");

    expect(finishUndispatched).toHaveBeenCalledExactlyOnceWith({
      attemptId: job.attemptId,
      code: "never_dispatched",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("names an exhausted budget, because tomorrow it would have worked", async () => {
    const { finishUndispatched } = runtime("ended");
    mocks.run.mockRejectedValueOnce(new ProductShotBudgetError(43200));

    expect(
      await consumeProductShotMessage(job, {} as never, lastDelivery),
    ).toBe("ack");

    expect(finishUndispatched).toHaveBeenCalledWith({
      attemptId: job.attemptId,
      code: "budget_exhausted",
    });
  });

  it("keeps the message when the attempt was in fact dispatched", async () => {
    // `skipped` means the row is not `queued` any more, so another delivery
    // owns its outcome and may have been charged. Acking would erase the only
    // remaining record of this message.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { finishUndispatched } = runtime("skipped");
    mocks.run.mockRejectedValueOnce(new ProductShotBudgetError(43200));

    expect(
      await consumeProductShotMessage(job, {} as never, lastDelivery),
    ).toEqual({ retryAfterSeconds: 30 });

    expect(finishUndispatched).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("product_shot_consumer_unreconciled", {
      attemptId: job.attemptId,
      outcome: "skipped",
    });
  });

  it("keeps the message when the terminal write itself fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    runtime(new Error("database unreachable"));
    mocks.run.mockRejectedValueOnce(new Error("provider unreachable"));

    expect(
      await consumeProductShotMessage(job, {} as never, lastDelivery),
    ).toEqual({ retryAfterSeconds: 30 });

    expect(log).toHaveBeenCalledWith("product_shot_consumer_unreconciled", {
      attemptId: job.attemptId,
      outcome: "write_failed",
    });
  });

  it("cannot record anything when the runtime itself failed to open", async () => {
    // There is no database handle to write through. Dead-lettering is then the
    // honest outcome -- a DLQ replay can still recover it, and acking could not.
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.create.mockImplementationOnce(() => {
      throw new Error("hyperdrive unavailable");
    });

    expect(
      await consumeProductShotMessage(job, {} as never, lastDelivery),
    ).toEqual({ retryAfterSeconds: 30 });
  });
});

describe("deliveries before the last one", () => {
  it("still retry rather than ending the attempt early", async () => {
    // Four chances to succeed are worth having. Recording a failure on the
    // first transient error would waste the other three.
    const { finishUndispatched } = runtime("ended");
    mocks.run.mockRejectedValueOnce(new ProductShotBudgetError(600));

    expect(
      await consumeProductShotMessage(job, {} as never, {
        attempt: PRODUCT_SHOT_MAX_ATTEMPTS - 1,
        maxAttempts: PRODUCT_SHOT_MAX_ATTEMPTS,
      }),
    ).toEqual({ retryAfterSeconds: 600 });

    expect(finishUndispatched).not.toHaveBeenCalled();
  });

  it("defaults to the first delivery when no attempt is supplied", async () => {
    const { finishUndispatched } = runtime("ended");
    mocks.run.mockRejectedValueOnce(new ProductShotBudgetError(600));

    expect(await consumeProductShotMessage(job, {} as never)).toEqual({
      retryAfterSeconds: 600,
    });
    expect(finishUndispatched).not.toHaveBeenCalled();
  });
});
