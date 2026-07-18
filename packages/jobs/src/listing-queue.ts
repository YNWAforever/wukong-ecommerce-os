import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";
import { z } from "zod";

export const LISTING_QUEUE = "listing-pipeline";

export const listingJobSchema = z.object({
  workspaceId: z.string().trim().min(1).refine((value) => !value.includes(":"), { message: "workspaceId must not contain ':'" }),
  draftId: z.string().trim().min(1).refine((value) => !value.includes(":"), { message: "draftId must not contain ':'" }),
  activeVersionSequence: z.number().int().nonnegative(),
}).strict();

export type ListingJobInput = z.infer<typeof listingJobSchema>;
export type ListingQueuePayload = Readonly<ListingJobInput>;

export type ListingQueuePort = {
  add(
    name: string,
    data: ListingQueuePayload,
    options: JobsOptions,
  ): Promise<{ id?: string }>;
};

export function listingPipelineJobId(input: ListingJobInput): string {
  const parsed = listingJobSchema.parse(input);
  return `listing:${parsed.workspaceId}:${parsed.draftId}:${parsed.activeVersionSequence}`;
}

export function bullmqListingJobId(input: ListingJobInput): string {
  return Buffer.from(listingPipelineJobId(input), "utf8").toString("base64url");
}

export function createListingQueue(
  connection: ConnectionOptions,
): Queue<ListingQueuePayload> {
  return new Queue<ListingQueuePayload>(LISTING_QUEUE, { connection });
}

export async function enqueueListingPipeline(
  input: ListingJobInput,
  dependencies: { queue: ListingQueuePort },
): Promise<{ id?: string }> {
  const data = listingJobSchema.parse(input);
  return dependencies.queue.add(LISTING_QUEUE, data, {
    jobId: bullmqListingJobId(data),
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
  });
}
