import type { Database } from "@wukong/db";

import { createWorkerDatabase } from "./cloudflare-runtime.js";
import type { WorkerEnv, WorkerQueueBatch } from "./worker-env.js";

type QueueDependencies = {
  createDatabase?: (env: WorkerEnv) => Database;
  consume?: (
    batch: WorkerQueueBatch,
    env: WorkerEnv,
    context: ExecutionContext | undefined,
    database: Database,
  ) => Promise<void>;
};

async function holdForConsumerImplementation(
  batch: WorkerQueueBatch,
): Promise<void> {
  for (const message of batch.messages) message.retry();
}

export async function handleQueue(
  batch: WorkerQueueBatch,
  env: WorkerEnv,
  context?: ExecutionContext,
  dependencies: QueueDependencies = {},
): Promise<void> {
  const database = (dependencies.createDatabase ?? createWorkerDatabase)(env);
  try {
    await (dependencies.consume ?? holdForConsumerImplementation)(
      batch,
      env,
      context,
      database,
    );
  } finally {
    await database.close();
  }
}
