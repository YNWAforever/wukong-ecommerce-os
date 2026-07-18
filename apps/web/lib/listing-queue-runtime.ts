import { Redis } from "ioredis";
import {
  createListingQueue,
  enqueueListingPipeline,
  type ListingJobInput,
  type ListingQueuePort,
} from "@wukong/jobs";

export type ListingPublisher = {
  enqueue(input: ListingJobInput): Promise<{ id: string }>;
};

type Options = {
  env?: Readonly<Record<string, string | undefined>>;
  redisFactory?: (url: string) => Redis;
  queueFactory?: (connection: Redis) => ListingQueuePort;
};

export function createListingPublisher(options: Options = {}): ListingPublisher {
  let queue: ListingQueuePort | undefined;

  return {
    async enqueue(input) {
      const url = (options.env ?? process.env).REDIS_URL?.trim();
      if (!url) throw new Error("REDIS_URL is required");

      if (!queue) {
        const redis = (
          options.redisFactory ??
          ((value) => new Redis(value, { maxRetriesPerRequest: null }))
        )(url);
        queue = (
          options.queueFactory ??
          ((connection) => createListingQueue(connection as never))
        )(redis);
      }

      const job = await enqueueListingPipeline(input, { queue });
      if (!job.id) throw new Error("listing queue did not return a job id");
      return { id: job.id };
    },
  };
}

export const listingPublisher = createListingPublisher();
