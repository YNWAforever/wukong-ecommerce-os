import type { QueueMessage } from "@wukong/jobs";

import { handleIngress } from "./ingress.js";
import { handleQueue } from "./queue-consumer.js";
import type { WorkerEnv } from "./worker-env.js";

export default {
  fetch: (request, env, context) => handleIngress(request, env, context),
  queue: (batch, env, context) => handleQueue(batch, env, context),
} satisfies ExportedHandler<WorkerEnv, QueueMessage>;
