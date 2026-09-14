import {
  consumeProductShotMessage as defaultConsumeProductShotMessage,
  PRODUCT_SHOT_MAX_ATTEMPTS,
  type ProductShotAttempt,
} from "./product-shot-consumer.js";
import {
  consumeWebsiteMessage as defaultConsumeWebsiteMessage,
  type WebsiteConsumerOutcome,
} from "./website-consumer.js";
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
  consumeProductShotMessage?: (
    payload: unknown,
    env: WorkerEnv,
    attempt: ProductShotAttempt,
  ) => Promise<"ack" | { retryAfterSeconds: number }>;
  consumeWebsiteMessage?: (
    payload: unknown,
    env: WorkerEnv,
  ) => Promise<WebsiteConsumerOutcome>;
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
    if (
      typeof message.body === "object" &&
      message.body !== null &&
      "kind" in message.body &&
      message.body.kind === "product_shot"
    ) {
      // Product-shot messages ride the listing queue, so they share its retry
      // budget. The consumer needs to know which delivery this is: the last one
      // has to record a terminal state, because the listing DLQ has no consumer
      // and the attempt row would otherwise stay `queued` for ever.
      const outcome = await (
        dependencies.consumeProductShotMessage ??
        defaultConsumeProductShotMessage
      )(message.body, env, {
        attempt: message.attempts,
        maxAttempts: PRODUCT_SHOT_MAX_ATTEMPTS,
      });
      if (outcome === "ack") message.ack();
      else message.retry({ delaySeconds: outcome.retryAfterSeconds });
      continue;
    }
    const website =
      typeof message.body === "object" &&
      message.body !== null &&
      "kind" in message.body;
    const outcome = website
      ? await (
          dependencies.consumeWebsiteMessage ?? defaultConsumeWebsiteMessage
        )(message.body, env)
      : await consume(message.body, env, {
          attempt: message.attempts,
          maxAttempts: LISTING_MAX_ATTEMPTS,
        });
    if (outcome === "ack") message.ack();
    else message.retry({ delaySeconds: outcome.retryAfterSeconds });
  }
}
