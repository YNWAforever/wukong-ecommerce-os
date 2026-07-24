import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = JSON.parse(
  readFileSync(new URL("cloudflare-runtime.config.json", root), "utf8"),
);

const requiredInput = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const safeToken = (name, value, pattern) => {
  if (!pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
};

const environment = requiredInput("CLOUDFLARE_ENV");
const selected = source.environments[environment];
if (!selected) throw new Error("unsupported CLOUDFLARE_ENV");

const hyperdriveId = safeToken(
  "CLOUDFLARE_HYPERDRIVE_ID",
  requiredInput("CLOUDFLARE_HYPERDRIVE_ID"),
  /^[A-Za-z0-9_-]{1,128}$/,
);
const buildSha = safeToken(
  "BUILD_SHA",
  requiredInput("BUILD_SHA"),
  /^[A-Za-z0-9._-]{7,128}$/,
);
const aiProvider = requiredInput("AI_PROVIDER");
if (!new Set(["fake", "openai"]).has(aiProvider)) {
  throw new Error("AI_PROVIDER is invalid");
}
const openAiListingModel = safeToken(
  "OPENAI_LISTING_MODEL",
  requiredInput("OPENAI_LISTING_MODEL"),
  /^[A-Za-z0-9._:-]{1,128}$/,
);
const s3Bucket = requiredInput("S3_BUCKET");
if (s3Bucket !== selected.r2Bucket) {
  throw new Error("S3_BUCKET does not match the selected environment");
}
const s3Endpoint = requiredInput("S3_ENDPOINT");
const endpoint = new URL(s3Endpoint);
if (
  endpoint.protocol !== "https:" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
) {
  throw new Error("S3_ENDPOINT must be a credential-free HTTPS URL");
}
const s3Region = requiredInput("S3_REGION");
if (s3Region !== "auto") throw new Error("S3_REGION must be auto");
const s3ForcePathStyle = requiredInput("S3_FORCE_PATH_STYLE");
if (s3ForcePathStyle !== "false") {
  throw new Error("S3_FORCE_PATH_STYLE must be false");
}

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
  keep_vars: true,
  limits: { cpu_ms: 240000 },
  observability: { enabled: true },
  secrets: { required: source.requiredSecrets },
  vars: {
    BUILD_SHA: buildSha,
    AI_PROVIDER: aiProvider,
    OPENAI_LISTING_MODEL: openAiListingModel,
    SHOPLINE_ADAPTER: environment === "preview" ? "mock" : "disabled",
    SHOPLINE_PUBLISH_ENABLED: "false",
    S3_BUCKET: s3Bucket,
    S3_ENDPOINT: s3Endpoint,
    S3_REGION: s3Region,
    S3_FORCE_PATH_STYLE: s3ForcePathStyle,
  },
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
