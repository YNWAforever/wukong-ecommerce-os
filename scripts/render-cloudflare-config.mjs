import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = JSON.parse(
  readFileSync(new URL("cloudflare-runtime.config.json", root), "utf8"),
);

const environment = process.env.CLOUDFLARE_ENV?.trim();
const hyperdriveId = process.env.CLOUDFLARE_HYPERDRIVE_ID?.trim();
if (!environment) throw new Error("CLOUDFLARE_ENV is required");
if (!hyperdriveId) throw new Error("CLOUDFLARE_HYPERDRIVE_ID is required");

const selected = source.environments[environment];
if (!selected) throw new Error("unsupported CLOUDFLARE_ENV");
const policy = source.consumer;
const consumer = (queue, deadLetterQueue) => ({
  queue,
  max_batch_size: policy.maxBatchSize,
  max_batch_timeout: policy.maxBatchTimeout,
  max_retries: policy.maxRetries,
  retry_delay: policy.retryDelay,
  max_concurrency: policy.maxConcurrency,
  dead_letter_queue: deadLetterQueue,
});

const wrangler = {
  name: selected.worker,
  main: "apps/worker/src/cloudflare.ts",
  compatibility_date: "2026-07-19",
  compatibility_flags: ["nodejs_compat"],
  limits: { cpu_ms: 240000 },
  observability: { enabled: true },
  hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdriveId }],
  queues: {
    producers: [
      { binding: "LISTING_QUEUE", queue: selected.listingQueue },
      { binding: "SHOPLINE_QUEUE", queue: selected.shoplineQueue },
    ],
    consumers: [
      consumer(selected.listingQueue, selected.listingDlq),
      consumer(selected.shoplineQueue, selected.shoplineDlq),
    ],
  },
};

const outputDirectory = new URL(".wrangler/", root);
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  fileURLToPath(new URL("wrangler.generated.jsonc", outputDirectory)),
  `${JSON.stringify(wrangler, null, 2)}\n`,
  "utf8",
);
