/** Local-only test entry: real HTTP ingress/Queues/runtime; paid transport goes to a deterministic loopback fixture. */
import { handleIngress } from "../../apps/worker/src/ingress.js";
import { handleQueue } from "../../apps/worker/src/queue-consumer.js";
import { handleScheduled } from "../../apps/worker/src/sweeper.js";
import { consumeWineMessage } from "../../apps/worker/src/wine-consumer.js";
import type { WorkerEnv } from "../../apps/worker/src/worker-env.js";
import type { QueueMessage } from "@wukong/jobs";
const deliveries: Array<{ runId: unknown; stage: unknown; result: unknown }> =
  [];
const localTransport: typeof fetch = async (input, init) => {
  const original = new Request(input, init);
  const url = new URL(original.url);
  const callback = url.origin === "https://callback.test";
  if (!callback && !["api.tavily.com", "opencode.ai"].includes(url.hostname))
    throw new Error("Unexpected synthetic provider origin");
  const headers = new Headers(original.headers);
  if (!callback) headers.set("x-wine-synthetic-original-url", original.url);
  const response = await fetch(
    callback
      ? `http://127.0.0.1:49219${url.pathname}`
      : "http://127.0.0.1:49221/provider",
    {
      method: original.method,
      headers,
      redirect: "manual",
      body: await original.arrayBuffer(),
      signal: original.signal,
    },
  );
  // Synthetic transport preserves bounded HTTP body/status, without pretending the loopback URL is the provider endpoint.
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
};
export default {
  fetch: async (request, env, context) => {
    if (new URL(request.url).pathname === "/__test/deliveries")
      return Response.json(deliveries);
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
      consumeWineMessage: async (payload, bindings) => {
        const result = await consumeWineMessage(payload, bindings, {
          transport: { fetch: localTransport },
          acquisitionFetch: localTransport,
        });
        const message = payload as { runId: unknown; stage: unknown };
        deliveries.push({ runId: message.runId, stage: message.stage, result });
        return result;
      },
    }),
  scheduled: handleScheduled,
} satisfies ExportedHandler<WorkerEnv, QueueMessage>;
