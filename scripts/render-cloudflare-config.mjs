import {
  listingProviderSecretNames,
  validateOpenRouterListingModel,
  productShotSecretNames,
} from "./listing-provider-config.mjs";

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
if (!new Set(["fake", "openai", "openrouter"]).has(aiProvider)) {
  throw new Error("AI_PROVIDER is invalid");
}
const listingModel =
  aiProvider === "openrouter"
    ? {
        OPENROUTER_LISTING_MODEL: validateOpenRouterListingModel(
          requiredInput("OPENROUTER_LISTING_MODEL"),
        ),
      }
    : {
        OPENAI_LISTING_MODEL: safeToken(
          "OPENAI_LISTING_MODEL",
          requiredInput("OPENAI_LISTING_MODEL"),
          /^[A-Za-z0-9._:-]{1,128}$/,
        ),
      };
const s3Bucket = requiredInput("S3_BUCKET");
if (s3Bucket !== selected.r2Bucket) {
  throw new Error("S3_BUCKET does not match the selected environment");
}
const s3Endpoint = requiredInput("S3_ENDPOINT");
if (
  !/^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com\/?$/.test(s3Endpoint)
) {
  throw new Error("S3_ENDPOINT must be a Cloudflare R2 S3 API root");
}
const s3Region = requiredInput("S3_REGION");
if (s3Region !== "auto") throw new Error("S3_REGION must be auto");
const s3ForcePathStyle = requiredInput("S3_FORCE_PATH_STYLE");
if (s3ForcePathStyle !== "false") {
  throw new Error("S3_FORCE_PATH_STYLE must be false");
}

const websiteFetchBaseUrl = process.env.WEBSITE_FETCH_BASE_URL?.trim();
if (websiteFetchBaseUrl) {
  const url = new URL(websiteFetchBaseUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("WEBSITE_FETCH_BASE_URL must be a trusted HTTPS origin");
  }
}
const productShotProvider =
  process.env.PRODUCT_SHOT_PROVIDER?.trim() || source.productShot.provider;
const secretNames = productShotSecretNames(
  listingProviderSecretNames(source.requiredSecrets, aiProvider),
  productShotProvider,
);
const shotBudget =
  process.env.PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY?.trim();
if (
  (shotBudget || productShotProvider === "photoroom") &&
  (!Number.isSafeInteger(Number(shotBudget)) ||
    Number(shotBudget) <= 0 ||
    Number(shotBudget) > 2_147_483_647)
)
  throw new Error(
    "PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY must be an integer from 1 to 2147483647",
  );
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
  secrets: { required: secretNames },
  vars: {
    ...(websiteFetchBaseUrl
      ? { WEBSITE_FETCH_BASE_URL: websiteFetchBaseUrl }
      : {}),
    PRODUCT_SHOT_PROVIDER: productShotProvider,
    ...(shotBudget
      ? { PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY: shotBudget }
      : {}),
    BUILD_SHA: buildSha,
    AI_PROVIDER: aiProvider,
    ...listingModel,
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
  triggers: { crons: [source.sweeper.cron] },
};

const outputDirectory = new URL(".wrangler/", root);
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  fileURLToPath(new URL("wrangler.generated.jsonc", outputDirectory)),
  `${JSON.stringify(wrangler, null, 2)}\n`,
  "utf8",
);
