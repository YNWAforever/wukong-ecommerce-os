import {
  ProviderApiError,
  ProviderOutputError,
  ProviderRefusalError,
  UnsupportedAssetError,
} from "@wukong/ai";
import { listingJobSchema } from "@wukong/jobs";

import { createCloudflareRuntime } from "./cloudflare-runtime.js";
import {
  PipelineTimeoutError,
  runListingPipeline,
} from "./listing-pipeline.js";
import type { WorkerEnv } from "./worker-env.js";

export type ListingConsumerOutcome = "ack" | { retryAfterSeconds: number };

const RETRY_AFTER_SECONDS = 30;

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
      attempt: 1,
      maxAttempts: 3,
      isTerminalError: isTerminalProviderError,
    });
    return "ack";
  } catch (error) {
    if (isTerminalProviderError(error)) return "ack";
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
