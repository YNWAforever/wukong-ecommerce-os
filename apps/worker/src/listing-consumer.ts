import {
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
  UnsupportedAssetError,
} from "@wukong/ai";
import { LISTING_PROVIDER_REQUEST_TIMEOUT_MS } from "@wukong/ai";
import { PIPELINE_STEP_LEASE_MS } from "@wukong/db";
import { listingJobSchema } from "@wukong/jobs";

import { createCloudflareRuntime } from "./cloudflare-runtime.js";
import {
  PipelineStepBusyError,
  PipelineTimeoutError,
  runListingPipeline,
} from "./listing-pipeline.js";
import type { WorkerEnv } from "./worker-env.js";

export type ListingConsumerOutcome = "ack" | { retryAfterSeconds: number };

/**
 * Cloudflare delivers a message once and then retries `maxRetries` times
 * (cloudflare-runtime.config.json), and `message.attempts` is 1-based, so the
 * final delivery carries attempt 4. Mirrors SHOPLINE_MAX_ATTEMPTS.
 */
export const LISTING_MAX_ATTEMPTS = 4;

const RETRY_AFTER_SECONDS = 30;
export const LISTING_LEASE_MARGIN_MS = 60_000;

// Same shape of guard as the SHOPLINE consumer: a lease that expires while the
// provider call is still in flight lets a redelivery steal the step and pay for
// the same extraction twice.
if (
  PIPELINE_STEP_LEASE_MS <=
  LISTING_PROVIDER_REQUEST_TIMEOUT_MS + LISTING_LEASE_MARGIN_MS
) {
  throw new Error("listing pipeline lease budget is unsafe");
}

export type ListingAttempt = {
  attempt: number;
  maxAttempts: number;
};

function isTerminalProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderOutputError ||
    error instanceof ProviderRefusalError ||
    error instanceof UnsupportedAssetError
  );
}

function isTransientProviderError(error: unknown): boolean {
  return (
    error instanceof ProviderApiError || error instanceof PipelineTimeoutError
  );
}

export async function consumeListingMessage(
  payload: unknown,
  env: WorkerEnv,
  attempt: ListingAttempt = { attempt: 1, maxAttempts: LISTING_MAX_ATTEMPTS },
): Promise<ListingConsumerOutcome> {
  const parsed = listingJobSchema.safeParse(payload);
  if (!parsed.success) return "ack";

  let runtime;
  try {
    runtime = createCloudflareRuntime(env);
  } catch {
    return { retryAfterSeconds: RETRY_AFTER_SECONDS };
  }

  try {
    await runListingPipeline(parsed.data, runtime.dependencies, {
      attempt: attempt.attempt,
      maxAttempts: attempt.maxAttempts,
      isTerminalError: isTerminalProviderError,
    });
    return "ack";
  } catch (error) {
    if (isTerminalProviderError(error)) return "ack";
    if (error instanceof PipelineStepBusyError) {
      // Another delivery owns the step. Coming back before its lease goes stale
      // can only fail the same way, so wait it out rather than spending the
      // remaining deliveries on guaranteed no-ops.
      return {
        retryAfterSeconds: error.retryAfterSeconds(
          Date.now(),
          RETRY_AFTER_SECONDS,
        ),
      };
    }
    if (isTransientProviderError(error)) {
      return { retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
    return { retryAfterSeconds: RETRY_AFTER_SECONDS };
  } finally {
    try {
      await runtime.close();
    } catch {
      // Cleanup must not override the already-classified queue outcome.
    }
  }
}
