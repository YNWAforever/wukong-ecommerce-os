import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

import { listingPipelineJobId, type ListingPipelineInput } from "./listing-pipeline.js";

export const LISTING_QUEUE = "listing-pipeline";

export type ListingQueuePayload = Readonly<{
  workspaceId: string;
  draftId: string;
  activeVersionSequence: number;
}>;

export type ListingQueuePort = {
  add(
    name: string,
    data: ListingQueuePayload,
    options: JobsOptions,
  ): Promise<{ id?: string }>;
};

export function bullmqListingJobId(input: ListingPipelineInput): string {
  return Buffer.from(listingPipelineJobId(input), "utf8").toString("base64url");
}

export function createListingQueue(connection: ConnectionOptions): Queue<ListingQueuePayload> {
  return new Queue<ListingQueuePayload>(LISTING_QUEUE, { connection });
}

export async function enqueueListingPipeline(
  input: ListingPipelineInput,
  dependencies: { queue: ListingQueuePort },
): Promise<{ id?: string }> {
  const data: ListingQueuePayload = {
    workspaceId: input.workspaceId,
    draftId: input.draftId,
    activeVersionSequence: input.activeVersionSequence,
  };
  return dependencies.queue.add(LISTING_QUEUE, data, {
    jobId: bullmqListingJobId(input),
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  });
}
