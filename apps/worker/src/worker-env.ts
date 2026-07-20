import type {
  ListingJob,
  QueueMessage,
  ShoplinePublishJob,
} from "@wukong/jobs";

export type WorkerEnv = {
  HYPERDRIVE: Hyperdrive;
  LISTING_QUEUE: Queue<ListingJob>;
  SHOPLINE_QUEUE: Queue<ShoplinePublishJob>;
  QUEUE_INGRESS_SECRET?: string;
  BUILD_SHA?: string;
  SHOPLINE_ADAPTER?: "disabled" | "mock";
};

export type WorkerQueueBatch = MessageBatch<QueueMessage>;
