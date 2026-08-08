import {
  consumeListingMessage as defaultConsumeListingMessage,
  LISTING_MAX_ATTEMPTS,
} from "./listing-consumer.js";
import type { ListingConsumerOutcome } from "./listing-consumer.js";
import {
  consumeShoplineMessage as defaultConsumeShoplineMessage,
  SHOPLINE_MAX_ATTEMPTS,
  type ShoplineConsumerOutcome,
} from "./shopline-consumer.js";
import type { WorkerEnv, WorkerQueueBatch } from "./worker-env.js";

const LISTING_QUEUE_NAMES = new Set([
  "wukong-listing-preview",
  "wukong-listing-production",
]);
const SHOPLINE_QUEUE_NAMES = new Set([
  "wukong-shopline-preview",
  "wukong-shopline-production",
]);

type ShoplineAttempt = {
  attempt: number;
  maxAttempts: number;
};

type ListingAttempt = {
  attempt: number;
  maxAttempts: number;
};

type QueueDependencies = {
  consumeListingMessage?: (
    payload: unknown,
    env: WorkerEnv,
    attempt: ListingAttempt,
  ) => Promise<ListingConsumerOutcome>;
  consumeShoplineMessage?: (
    payload: unknown,
    env: WorkerEnv,
    attempt: ShoplineAttempt,
  ) => Promise<ShoplineConsumerOutcome>;
};

export async function handleQueue(
  batch: WorkerQueueBatch,
  env: WorkerEnv,
  context?: ExecutionContext,
  dependencies: QueueDependencies = {},
): Promise<void> {
  void context;
  const isListingQueue = LISTING_QUEUE_NAMES.has(batch.queue);
  const isShoplineQueue = SHOPLINE_QUEUE_NAMES.has(batch.queue);
  if (!isListingQueue && !isShoplineQueue) {
    throw new Error("unknown queue name");
  }

  if (isShoplineQueue) {
    const consume =
      dependencies.consumeShoplineMessage ?? defaultConsumeShoplineMessage;
    for (const message of batch.messages) {
      const outcome = await consume(message.body, env, {
        attempt: message.attempts,
        maxAttempts: SHOPLINE_MAX_ATTEMPTS,
      });
      if (outcome === "ack") message.ack();
      else message.retry({ delaySeconds: outcome.retryAfterSeconds });
    }
    return;
  }

  const consume =
    dependencies.consumeListingMessage ?? defaultConsumeListingMessage;
  for (const message of batch.messages) {
    const outcome = await consume(message.body, env, {
      attempt: message.attempts,
      maxAttempts: LISTING_MAX_ATTEMPTS,
    });
    if (outcome === "ack") message.ack();
    else message.retry({ delaySeconds: outcome.retryAfterSeconds });
  }
}
