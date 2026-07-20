import { createDatabase, type Database } from "@wukong/db";

import type { WorkerEnv } from "./worker-env.js";

export function createWorkerDatabase(env: WorkerEnv): Database {
  const connectionString = env.HYPERDRIVE?.connectionString;
  if (!connectionString?.trim()) {
    throw new Error("HYPERDRIVE binding is required");
  }
  return createDatabase(connectionString, { maxConnections: 5 });
}

export function workerHealth(env: WorkerEnv) {
  return {
    buildSha: env.BUILD_SHA?.trim() || "unknown",
    adapterMode: env.SHOPLINE_ADAPTER === "mock" ? "mock" : "disabled",
    bindings: {
      hyperdrive: Boolean(env.HYPERDRIVE?.connectionString),
      listingQueue: typeof env.LISTING_QUEUE?.send === "function",
      shoplineQueue: typeof env.SHOPLINE_QUEUE?.send === "function",
      ingressSecret: Boolean(env.QUEUE_INGRESS_SECRET?.trim()),
    },
  } as const;
}
