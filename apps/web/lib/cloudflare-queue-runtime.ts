import {
  PRODUCT_SHOT_INGRESS_PATH,
  productShotJobSchema,
  type ProductShotJob,
  LISTING_INGRESS_PATH,
  WEBSITE_INGRESS_PATH,
  websiteJobSchema,
  type WebsiteJob,
  SHOPLINE_INGRESS_PATH,
  listingJobSchema,
  shoplinePublishJobSchema,
  signQueueRequest,
  type ListingJob,
  type ShoplinePublishJob,
} from "@wukong/jobs";

export type CloudflareIngressClient = {
  enqueue(
    path: typeof PRODUCT_SHOT_INGRESS_PATH,
    payload: ProductShotJob,
  ): Promise<{ accepted: true }>;
  enqueue(
    path: typeof WEBSITE_INGRESS_PATH,
    payload: WebsiteJob,
  ): Promise<{ accepted: true }>;
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
  sleep?: (ms: number) => Promise<void>;
};

const RETRY_DELAY_MS = 750;

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

// Never log arbitrary exception text: it can contain URLs or credentials.
function reportIngressFailure(
  stage: "configuration" | "signing" | "transport",
  error: unknown,
) {
  const allowed = new Set([
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ERR_INVALID_URL",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "TimeoutError",
    "AbortError",
  ]);
  const failure = error instanceof Error ? error : null;
  const cause = failure?.cause;
  const candidates = [
    cause && typeof cause === "object" && "code" in cause ? cause.code : null,
    failure && "code" in failure ? failure.code : null,
    failure?.name,
  ];
  const code =
    candidates.find(
      (value): value is string =>
        typeof value === "string" && allowed.has(value),
    ) ?? "unknown";
  console.error(
    JSON.stringify({ event: "queue_ingress_failure", stage, code }),
  );
}

export function createCloudflareIngressClient(
  options: Options = {},
): CloudflareIngressClient {
  async function enqueue(
    path:
      | typeof LISTING_INGRESS_PATH
      | typeof SHOPLINE_INGRESS_PATH
      | typeof WEBSITE_INGRESS_PATH
      | typeof PRODUCT_SHOT_INGRESS_PATH,
    payload: ListingJob | ShoplinePublishJob | WebsiteJob | ProductShotJob,
  ): Promise<{ accepted: true }> {
    let stage: "configuration" | "signing" | "transport" = "configuration";
    try {
      const env = options.env ?? process.env;
      const ingressUrl = env.QUEUE_INGRESS_URL?.trim();
      const secret = env.QUEUE_INGRESS_SECRET?.trim();
      if (!ingressUrl || !secret) throw queueUnavailable("not_configured");
      const schema =
        path === PRODUCT_SHOT_INGRESS_PATH
          ? productShotJobSchema
          : path === LISTING_INGRESS_PATH
            ? listingJobSchema
            : path === SHOPLINE_INGRESS_PATH
              ? shoplinePublishJobSchema
              : path === WEBSITE_INGRESS_PATH
                ? websiteJobSchema
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

      stage = "signing";
      const timestamp = Math.floor((options.now ?? Date.now)() / 1_000);
      const signature = await signQueueRequest({
        secret,
        timestamp,
        path,
        body,
      });

      stage = "transport";
      const attemptFetch = () =>
        (options.fetch ?? globalThis.fetch)(new URL(path, ingressUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-wukong-timestamp": String(timestamp),
            "x-wukong-signature": signature,
          },
          body,
          signal: AbortSignal.timeout(5_000),
        });

      // The shared *.workers.dev route is subject to connection-level
      // throttling under bursty traffic from Vercel's shared egress IPs
      // (observed directly: identical requests spaced 5s apart always
      // succeed, tight bursts hard-timeout at the TCP level). One retry
      // after a short delay clears the transient case without masking a
      // genuinely broken ingress.
      let response: Response;
      try {
        response = await attemptFetch();
      } catch {
        await (
          options.sleep ??
          ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
        )(RETRY_DELAY_MS);
        try {
          response = await attemptFetch();
        } catch (error) {
          reportIngressFailure(stage, error);
          throw queueUnavailable("unreachable");
        }
      }
      if (response.status !== 202) throw queueUnavailable("rejected");

      return { accepted: true };
    } catch (error) {
      if (error instanceof QueueIngressError) throw error;
      reportIngressFailure(stage, error);
      throw queueUnavailable("unreachable");
    }
  }

  return { enqueue };
}
