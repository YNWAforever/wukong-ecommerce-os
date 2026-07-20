import { consumeListingMessage as defaultConsumeListingMessage } from "./listing-consumer.js";
import type { ListingConsumerOutcome } from "./listing-consumer.js";
import type { WorkerEnv, WorkerQueueBatch } from "./worker-env.js";

const LISTING_QUEUE_NAMES = new Set([
  "wukong-listing-preview",
  "wukong-listing-production",
]);
const SHOPLINE_QUEUE_NAMES = new Set([
  "wukong-shopline-preview",
  "wukong-shopline-production",
]);
const PLACEHOLDER_RETRY_SECONDS = 30;

type QueueDependencies = {
  consumeListingMessage?: (
    payload: unknown,
    env: WorkerEnv,
  ) => Promise<ListingConsumerOutcome>;
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
    for (const message of batch.messages) {
      message.retry({ delaySeconds: PLACEHOLDER_RETRY_SECONDS });
    }
    return;
  }

  const consume =
    dependencies.consumeListingMessage ?? defaultConsumeListingMessage;
  for (const message of batch.messages) {
    const outcome = await consume(message.body, env);
    if (outcome === "ack") message.ack();
    else message.retry({ delaySeconds: outcome.retryAfterSeconds });
  }
}
