import { productShotJobSchema } from "@wukong/jobs";
import { createProductShotRuntime } from "./cloudflare-runtime.js";
import {
  runProductShot,
  ProductShotBusyError,
  ProductShotBudgetError,
} from "./product-shot-pipeline.js";
import type { WorkerEnv } from "./worker-env.js";
export async function consumeProductShotMessage(
  payload: unknown,
  env: WorkerEnv,
): Promise<"ack" | { retryAfterSeconds: number }> {
  const parsed = productShotJobSchema.safeParse(payload);
  if (!parsed.success) return "ack";
  let runtime;
  try {
    runtime = createProductShotRuntime(env);
    await runProductShot(parsed.data, runtime.dependencies);
    return "ack";
  } catch (error) {
    if (
      error instanceof ProductShotBusyError ||
      error instanceof ProductShotBudgetError
    )
      return { retryAfterSeconds: error.retryAfterSeconds };
    console.error("product_shot_consumer_failure", {
      category: runtime ? "processing_failed" : "runtime_initialization_failed",
      attemptId: parsed.data.attemptId,
    });
    return { retryAfterSeconds: 30 };
  } finally {
    await runtime?.close().catch(() => undefined);
  }
}
