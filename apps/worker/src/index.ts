import { Worker, type ConnectionOptions, type Processor, type WorkerOptions } from "bullmq";
import {
  LISTING_QUEUE,
  type ListingQueuePayload,
} from "@wukong/jobs";

import { runListingPipeline, type PipelineDependencies } from "./listing-pipeline.js";

export function createListingPipelineProcessor(
  dependencies: PipelineDependencies,
): Processor<ListingQueuePayload, Awaited<ReturnType<typeof runListingPipeline>>> {
  return async (job) => runListingPipeline(job.data, dependencies, { attempt: job.attemptsMade + 1, maxAttempts: typeof job.opts.attempts === "number" ? job.opts.attempts : 3 });
}

export function createListingPipelineWorker(
  connection: ConnectionOptions,
  dependencies: PipelineDependencies,
  options: Omit<WorkerOptions, "connection"> = {},
): Worker<ListingQueuePayload> {
  return new Worker(
    LISTING_QUEUE,
    createListingPipelineProcessor(dependencies),
    { ...options, connection },
  );
}

export {
  LISTING_QUEUE,
  bullmqListingJobId,
  createListingQueue,
  enqueueListingPipeline,
  listingPipelineJobId,
  type ListingQueuePayload,
  type ListingQueuePort,
} from "@wukong/jobs";
export {
  PipelineTimeoutError,
  runListingPipeline,
  type ListingPipelineInput,
  type PipelineDependencies,
  type PipelineResult,
} from "./listing-pipeline.js";

export { startListingPipelineWorker, type ListingWorkerRuntime, type ListingWorkerRuntimeConfig } from "./runtime.js";
export {
  PublishDeliveryError,
  publishApprovedProduct,
  type PublishDependencies,
  type PublishErrorCode,
  type PublishJobRecord,
  type PublishListingSnapshot,
  type PublishProductInput,
  type PublishRepositories,
  type PublishResult,
} from "./publish-product.js";
