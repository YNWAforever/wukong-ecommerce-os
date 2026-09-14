import { productShotJobSchema } from "@wukong/jobs";
import { createProductShotRuntime } from "./cloudflare-runtime.js";
import {
  runProductShot,
  ProductShotBusyError,
  ProductShotBudgetError,
} from "./product-shot-pipeline.js";
import type { WorkerEnv } from "./worker-env.js";

/**
 * Cloudflare delivers a message once and then retries `maxRetries` times
 * (cloudflare-runtime.config.json), and `message.attempts` is 1-based, so the
 * final delivery carries attempt 4. Mirrors LISTING_MAX_ATTEMPTS.
 */
export const PRODUCT_SHOT_MAX_ATTEMPTS = 4;

const RETRY_AFTER_SECONDS = 30;

export type ProductShotAttempt = {
  attempt: number;
  maxAttempts: number;
};

/**
 * Runs one product-shot job, and makes sure the last delivery leaves a mark.
 *
 * This consumer used to answer `{retryAfterSeconds}` for every failure,
 * including the final delivery. Product-shot messages ride the listing queue,
 * so that last retry moves them to `wukong-listing-dlq-*` -- which has no
 * consumer. The attempt row then stayed `queued` with no error code and no
 * audit event, the review panel polled it every three seconds for ever, and
 * its only offered action ("Retry queue") led back to the same disappearance.
 *
 * On the final delivery it now records a terminal state instead, but only
 * through `finishUndispatched`, which refuses any attempt that reached a
 * provider. A possible charge must never be written off as a costless failure.
 */
export async function consumeProductShotMessage(
  payload: unknown,
  env: WorkerEnv,
  attempt: ProductShotAttempt = {
    attempt: 1,
    maxAttempts: PRODUCT_SHOT_MAX_ATTEMPTS,
  },
): Promise<"ack" | { retryAfterSeconds: number }> {
  const parsed = productShotJobSchema.safeParse(payload);
  if (!parsed.success) return "ack";
  const job = parsed.data;
  const finalDelivery = attempt.attempt >= attempt.maxAttempts;
  let runtime;
  try {
    runtime = createProductShotRuntime(env);
    await runProductShot(job, runtime.dependencies);
    return "ack";
  } catch (error) {
    const waiting =
      error instanceof ProductShotBusyError ||
      error instanceof ProductShotBudgetError;
    if (!waiting) {
      console.error("product_shot_consumer_failure", {
        category: runtime
          ? "processing_failed"
          : "runtime_initialization_failed",
        attemptId: job.attemptId,
      });
    }
    if (!finalDelivery) {
      return {
        retryAfterSeconds: waiting
          ? error.retryAfterSeconds
          : RETRY_AFTER_SECONDS,
      };
    }
    // Runtime initialization is what failed, so there is no database handle to
    // record through. Dead-lettering is then the honest outcome: the message
    // stays recoverable by a DLQ replay, which acking would prevent.
    if (!runtime) return { retryAfterSeconds: RETRY_AFTER_SECONDS };
    const outcome = await runtime.dependencies
      .forWorkspace(job.workspaceId, (repositories) =>
        repositories.productShots.finishUndispatched({
          attemptId: job.attemptId,
          code:
            error instanceof ProductShotBudgetError
              ? "budget_exhausted"
              : "never_dispatched",
        }),
      )
      .catch(() => null);
    if (outcome !== "ended") {
      // Either the write failed, or the attempt had in fact been dispatched and
      // still owns its outcome. Both keep the message rather than losing it.
      console.error("product_shot_consumer_unreconciled", {
        attemptId: job.attemptId,
        outcome: outcome ?? "write_failed",
      });
      return { retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
    return "ack";
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}
