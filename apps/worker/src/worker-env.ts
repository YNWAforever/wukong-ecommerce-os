import type {
  Hyperdrive,
  Queue,
  MessageBatch,
} from "@cloudflare/workers-types";
import type {
  ListingJob,
  WebsiteJob,
  QueueMessage,
  ShoplinePublishJob,
} from "@wukong/jobs";

export type WorkerEnv = {
  HYPERDRIVE: Hyperdrive;
  LISTING_QUEUE: Queue<ListingJob | WebsiteJob>;
  SHOPLINE_QUEUE: Queue<ShoplinePublishJob>;
  QUEUE_INGRESS_SECRET?: string;
  BUILD_SHA?: string;
  WEBSITE_FETCH_BASE_URL?: string;
  SHOPLINE_ADAPTER?: "disabled" | "mock" | "real";
  SHOPLINE_PUBLISH_ENABLED?: "true" | "false";
  SHOPLINE_TOKEN_ENCRYPTION_KEY?: string;
  AI_PROVIDER?: "openai" | "fake";
  OPENAI_API_KEY?: string;
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_FORCE_PATH_STYLE?: "true" | "false";
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
};

export type WorkerQueueBatch = MessageBatch<QueueMessage>;
