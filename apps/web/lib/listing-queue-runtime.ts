import {
  LISTING_INGRESS_PATH,
  listingRunKey,
  type ListingJob,
} from "@wukong/jobs";

import {
  createCloudflareIngressClient,
  QueueIngressError,
  type CloudflareIngressClient,
} from "./cloudflare-queue-runtime";

export function listingApplicationJobId(input: ListingJob): string {
  // Shared with the Worker so both sides derive byte-identical keys.
  return listingRunKey(input);
}

export type ListingPublisher = {
  enqueue(input: ListingJob): Promise<{ id: string }>;
};

type Options = {
  env?: Readonly<Record<string, string | undefined>>;
  ingressClient?: CloudflareIngressClient;
};

export function createListingPublisher(
  options: Options = {},
): ListingPublisher {
  const ingressClient =
    options.ingressClient ??
    createCloudflareIngressClient({ env: options.env });

  return {
    async enqueue(input) {
      try {
        await ingressClient.enqueue(LISTING_INGRESS_PATH, input);
      } catch (error) {
        // Keep the reason the client already determined. Replacing it here
        // flattened every ingress failure into one indistinguishable word.
        throw error instanceof QueueIngressError
          ? error
          : new QueueIngressError("unreachable");
      }

      return {
        id: listingApplicationJobId(input),
      };
    },
  };
}

export const listingPublisher = createListingPublisher();
