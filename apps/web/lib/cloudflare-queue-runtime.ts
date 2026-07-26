import {
  LISTING_INGRESS_PATH,
  SHOPLINE_INGRESS_PATH,
  listingJobSchema,
  shoplinePublishJobSchema,
  signQueueRequest,
} from "@wukong/jobs";

export type CloudflareIngressClient = {
  enqueue(path: string, payload: unknown): Promise<{ accepted: true }>;
};

type Options = {
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
};

export type QueueIngressReason =
  | "not_configured"
  | "unsupported_path"
  | "invalid_payload"
  | "rejected"
  | "unreachable";

// The message stays "queue_unavailable" so nothing about the ingress reaches a
// caller. The reason exists for the operator: without it, an unset variable, a
// refused signature and an unreachable Worker are the same single word.
export class QueueIngressError extends Error {
  constructor(readonly reason: QueueIngressReason) {
    super("queue_unavailable");
    this.name = "QueueIngressError";
  }
}

function queueUnavailable(reason: QueueIngressReason): QueueIngressError {
  return new QueueIngressError(reason);
}

export function createCloudflareIngressClient(
  options: Options = {},
): CloudflareIngressClient {
  return {
    async enqueue(path, payload) {
      try {
        const env = options.env ?? process.env;
        const ingressUrl = env.QUEUE_INGRESS_URL?.trim();
        const secret = env.QUEUE_INGRESS_SECRET?.trim();
        if (!ingressUrl || !secret) throw queueUnavailable("not_configured");
        const schema =
          path === LISTING_INGRESS_PATH
            ? listingJobSchema
            : path === SHOPLINE_INGRESS_PATH
              ? shoplinePublishJobSchema
              : null;
        if (!schema) throw queueUnavailable("unsupported_path");

        let body: string;
        try {
          body = JSON.stringify(schema.parse(payload));
        } catch {
          // Separated from the transport below. Reporting a rejected payload
          // as unreachable would send an operator to inspect the network.
          throw queueUnavailable("invalid_payload");
        }

        const timestamp = Math.floor((options.now ?? Date.now)() / 1_000);
        const signature = await signQueueRequest({
          secret,
          timestamp,
          path,
          body,
        });

        let response: Response;
        try {
          response = await (options.fetch ?? globalThis.fetch)(
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
        } catch {
          throw queueUnavailable("unreachable");
        }
        if (response.status !== 202) throw queueUnavailable("rejected");

        return { accepted: true };
      } catch (error) {
        if (error instanceof QueueIngressError) throw error;
        throw queueUnavailable("unreachable");
      }
    },
  };
}
