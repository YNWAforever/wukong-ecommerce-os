import {
  LISTING_INGRESS_PATH,
  SHOPLINE_INGRESS_PATH,
  listingJobSchema,
  shoplinePublishJobSchema,
  signQueueRequest,
  type ListingJob,
  type ShoplinePublishJob,
} from "@wukong/jobs";

export type CloudflareIngressClient = {
  enqueue(
    path: typeof LISTING_INGRESS_PATH,
    payload: ListingJob,
  ): Promise<{ accepted: true }>;
  enqueue(
    path: typeof SHOPLINE_INGRESS_PATH,
    payload: ShoplinePublishJob,
  ): Promise<{ accepted: true }>;
};

type Options = {
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
};

export class QueueIngressError extends Error {
  constructor(message: "queue_unavailable") {
    super(message);
    this.name = "QueueIngressError";
  }
}

function queueUnavailable(): QueueIngressError {
  return new QueueIngressError("queue_unavailable");
}

export function createCloudflareIngressClient(
  options: Options = {},
): CloudflareIngressClient {
  async function enqueue(
    path: typeof LISTING_INGRESS_PATH | typeof SHOPLINE_INGRESS_PATH,
    payload: ListingJob | ShoplinePublishJob,
  ): Promise<{ accepted: true }> {
    try {
      const env = options.env ?? process.env;
      const ingressUrl = env.QUEUE_INGRESS_URL?.trim();
      const secret = env.QUEUE_INGRESS_SECRET?.trim();
      if (!ingressUrl || !secret) throw queueUnavailable();
      const schema =
        path === LISTING_INGRESS_PATH
          ? listingJobSchema
          : path === SHOPLINE_INGRESS_PATH
            ? shoplinePublishJobSchema
            : null;
      if (!schema) throw queueUnavailable();

      const body = JSON.stringify(schema.parse(payload));
      const timestamp = Math.floor((options.now ?? Date.now)() / 1_000);
      const signature = await signQueueRequest({
        secret,
        timestamp,
        path,
        body,
      });
      const response = await (options.fetch ?? globalThis.fetch)(
        new URL(path, ingressUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-wukong-timestamp": String(timestamp),
            "x-wukong-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.status !== 202) throw queueUnavailable();

      return { accepted: true };
    } catch (error) {
      if (error instanceof QueueIngressError) throw error;
      throw queueUnavailable();
    }
  }

  return {
    enqueue,
  };
}
