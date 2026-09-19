/** Local-only test entry: real HTTP ingress/Queues/runtime; paid transport goes to a deterministic loopback fixture. */
import { handleIngress } from "../../apps/worker/src/ingress.js";
import { handleQueue } from "../../apps/worker/src/queue-consumer.js";
import { handleScheduled } from "../../apps/worker/src/sweeper.js";
import { consumeWineMessage } from "../../apps/worker/src/wine-consumer.js";
import type { WorkerEnv } from "../../apps/worker/src/worker-env.js";
import type { QueueMessage } from "@wukong/jobs";
const localTransport: typeof fetch = async (input, init) => {
  const original = new Request(input, init);
  const response = await fetch("http://127.0.0.1:49221", {
    method: original.method,
    headers: original.headers,
    body: await original.arrayBuffer(),
    signal: original.signal,
  });
  // Synthetic transport preserves bounded HTTP body/status, without pretending the loopback URL is the provider endpoint.
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
};
export default {
  fetch: async (request, env, context) => {
    if (new URL(request.url).pathname === "/__test/redirect-policy") {
      try {
        await fetch("http://127.0.0.1:49221", { redirect: "error" });
        return Response.json({ rejected: false });
      } catch (error) {
        return Response.json({
          rejected: true,
          message: error instanceof Error ? error.message : "unknown",
        });
      }
    }
    return handleIngress(request, env, context);
  },
  queue: (batch, env, context) =>
    handleQueue(batch, env, context, {
      consumeWineMessage: (payload, bindings) =>
        consumeWineMessage(payload, bindings, {
          transport: { fetch: localTransport },
          acquisitionFetch: localTransport,
        }),
    }),
  scheduled: handleScheduled,
} satisfies ExportedHandler<WorkerEnv, QueueMessage>;
