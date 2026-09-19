import { wineListingJobSchema } from "@wukong/jobs";
import { createWineQueueRuntime } from "./wine-queue-runtime.js";
import type { WineQueueRuntimeConfig } from "./wine-queue-runtime.js";
import type { WorkerEnv } from "./worker-env.js";
/** Unknown/started calls are terminal to automatic execution; DB/transports may safely redeliver. */
export async function consumeWineMessage(
  payload: unknown,
  env: WorkerEnv,
  config: WineQueueRuntimeConfig = {},
): Promise<"ack" | { retryAfterSeconds: number }> {
  const parsed = wineListingJobSchema.safeParse(payload);
  if (!parsed.success) return { retryAfterSeconds: 30 };
  let runtime: ReturnType<typeof createWineQueueRuntime> | undefined;
  try {
    runtime = createWineQueueRuntime(env, config);
    const outcome = await runtime.deliver(parsed.data);
    console.info(
      JSON.stringify({
        event: "wine.stage_delivery",
        stage: parsed.data.stage,
        status: outcome.status,
        ...("postCommitDiagnostic" in outcome && outcome.postCommitDiagnostic
          ? { diagnostic: outcome.postCommitDiagnostic.code }
          : {}),
      }),
    );
    return "ack";
  } catch {
    console.error(
      JSON.stringify({
        event: "wine.delivery_retry",
        stage: parsed.data.stage,
        code: "runtime_or_dispatch_failed",
      }),
    );
    return { retryAfterSeconds: 30 };
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}
