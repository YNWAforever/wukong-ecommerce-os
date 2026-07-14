import { startListingPipelineWorker } from "./runtime.js";

const runtime = await startListingPipelineWorker();
let closing = false;

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`listing worker stopping (${signal})`);
  await runtime.close();
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

console.log("listing worker started");