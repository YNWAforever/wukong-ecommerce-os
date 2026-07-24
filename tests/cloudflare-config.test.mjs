import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  parseSecretNames,
  verifyExactSecretNames,
} from "../scripts/verify-cloudflare-secrets.mjs";

const root = new URL("../", import.meta.url);
const readJson = (path) =>
  JSON.parse(readFileSync(new URL(path, root), "utf8"));

const expected = {
  preview: {
    worker: "wukong-runtime-preview",
    listingQueue: "wukong-listing-preview",
    listingDlq: "wukong-listing-dlq-preview",
    shoplineQueue: "wukong-shopline-preview",
    shoplineDlq: "wukong-shopline-dlq-preview",
    r2Bucket: "wukong-opak-preview-assets",
  },
  production: {
    worker: "wukong-runtime-production",
    listingQueue: "wukong-listing-production",
    listingDlq: "wukong-listing-dlq-production",
    shoplineQueue: "wukong-shopline-production",
    shoplineDlq: "wukong-shopline-dlq-production",
    r2Bucket: "wukong-opak-prod-assets",
  },
};

const requiredSecrets = [
  "QUEUE_INGRESS_SECRET",
  "OPENAI_API_KEY",
  "SHOPLINE_TOKEN_ENCRYPTION_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
];

const safeRendererInputs = {
  CLOUDFLARE_ENV: "preview",
  CLOUDFLARE_HYPERDRIVE_ID: "hyperdrive-preview-id",
  BUILD_SHA: "0123456789abcdef0123456789abcdef01234567",
  AI_PROVIDER: "fake",
  OPENAI_LISTING_MODEL: "gpt-5-mini",
  S3_BUCKET: "wukong-opak-preview-assets",
  S3_ENDPOINT: "https://preview.r2.cloudflarestorage.com",
  S3_REGION: "auto",
  S3_FORCE_PATH_STYLE: "false",
};

const render = (overrides = {}) =>
  spawnSync(process.execPath, ["scripts/render-cloudflare-config.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ...safeRendererInputs,
      ...overrides,
    },
  });

test("keeps exact isolated queue and DLQ resource names", () => {
  const source = readJson("cloudflare-runtime.config.json");
  assert.deepEqual(source.environments, expected);
  assert.deepEqual(source.requiredSecrets, requiredSecrets);
  assert.deepEqual(source.consumer, {
    maxBatchSize: 1,
    maxBatchTimeout: 5,
    maxRetries: 3,
    retryDelay: 30,
    maxConcurrency: 1,
  });
});

test("renders deterministic non-secret Wrangler config", () => {
  const output = new URL(".wrangler/wrangler.generated.jsonc", root);
  rmSync(output, { force: true });
  const result = render({
    SHOPLINE_ADAPTER: "real",
    SHOPLINE_PUBLISH_ENABLED: "true",
    SECRET_VALUE_MARKER: "must-never-be-rendered",
  });
  assert.equal(result.status, 0, result.stderr);
  const config = readJson(".wrangler/wrangler.generated.jsonc");
  assert.deepEqual(config, {
    name: expected.preview.worker,
    main: "apps/worker/src/cloudflare.ts",
    compatibility_date: "2026-07-19",
    compatibility_flags: ["nodejs_compat"],
    keep_vars: true,
    limits: { cpu_ms: 240000 },
    observability: { enabled: true },
    secrets: { required: requiredSecrets },
    vars: {
      BUILD_SHA: safeRendererInputs.BUILD_SHA,
      AI_PROVIDER: "fake",
      OPENAI_LISTING_MODEL: "gpt-5-mini",
      SHOPLINE_ADAPTER: "mock",
      SHOPLINE_PUBLISH_ENABLED: "false",
      S3_BUCKET: "wukong-opak-preview-assets",
      S3_ENDPOINT: "https://preview.r2.cloudflarestorage.com",
      S3_REGION: "auto",
      S3_FORCE_PATH_STYLE: "false",
    },
    hyperdrive: [{ binding: "HYPERDRIVE", id: "hyperdrive-preview-id" }],
    queues: {
      producers: [
        { binding: "LISTING_QUEUE", queue: expected.preview.listingQueue },
        { binding: "SHOPLINE_QUEUE", queue: expected.preview.shoplineQueue },
      ],
      consumers: [
        {
          queue: expected.preview.listingQueue,
          max_batch_size: 1,
          max_batch_timeout: 5,
          max_retries: 3,
          retry_delay: 30,
          max_concurrency: 1,
          dead_letter_queue: expected.preview.listingDlq,
        },
        {
          queue: expected.preview.shoplineQueue,
          max_batch_size: 1,
          max_batch_timeout: 5,
          max_retries: 3,
          retry_delay: 30,
          max_concurrency: 1,
          dead_letter_queue: expected.preview.shoplineDlq,
        },
      ],
    },
  });
  const rendered = readFileSync(output, "utf8");
  assert.doesNotMatch(
    rendered,
    /must-never-be-rendered|connectionString|database_url/i,
  );
});

test("production always renders SHOPLINE disabled and publishing false", () => {
  const result = render({
    CLOUDFLARE_ENV: "production",
    CLOUDFLARE_HYPERDRIVE_ID: "hyperdrive-production-id",
    AI_PROVIDER: "openai",
    S3_BUCKET: "wukong-opak-prod-assets",
    S3_ENDPOINT: "https://production.r2.cloudflarestorage.com",
    SHOPLINE_ADAPTER: "real",
    SHOPLINE_PUBLISH_ENABLED: "true",
  });
  assert.equal(result.status, 0, result.stderr);
  const config = readJson(".wrangler/wrangler.generated.jsonc");
  assert.equal(config.name, expected.production.worker);
  assert.equal(config.vars.SHOPLINE_ADAPTER, "disabled");
  assert.equal(config.vars.SHOPLINE_PUBLISH_ENABLED, "false");
  assert.equal(config.vars.AI_PROVIDER, "openai");
});

test("requires every safe renderer input and rejects unsafe values", () => {
  for (const key of Object.keys(safeRendererInputs)) {
    const result = render({ [key]: "" });
    assert.notEqual(result.status, 0);
  }
  for (const overrides of [
    { CLOUDFLARE_ENV: "staging" },
    { AI_PROVIDER: "unknown" },
    { S3_FORCE_PATH_STYLE: "yes" },
  ]) {
    assert.notEqual(render(overrides).status, 0);
  }
});

test("secret preflight rejects missing, unexpected, and malformed names", () => {
  const configured = requiredSecrets.map((name) => ({
    name,
    type: "secret_text",
  }));
  const names = parseSecretNames(JSON.stringify(configured));
  assert.deepEqual(names, requiredSecrets);
  assert.doesNotThrow(() => verifyExactSecretNames(requiredSecrets, names));
  assert.throws(
    () => verifyExactSecretNames(requiredSecrets, names.slice(1)),
    /missing: QUEUE_INGRESS_SECRET/,
  );
  assert.throws(
    () =>
      verifyExactSecretNames(requiredSecrets, [...names, "UNEXPECTED_SECRET"]),
    /unexpected: UNEXPECTED_SECRET/,
  );
  assert.throws(() => parseSecretNames('{"name":"not-an-array"}'), /invalid/);
});

test("removes the Railway and Redis/BullMQ runtime surface", () => {
  assert.equal(existsSync(new URL("railway.json", root)), false);
  assert.equal(
    existsSync(new URL("tests/railway-config.test.mjs", root)),
    false,
  );
  const worker = readJson("apps/worker/package.json");
  assert.equal(worker.dependencies?.bullmq, undefined);
  assert.equal(worker.dependencies?.ioredis, undefined);
  assert.match(worker.devDependencies.wrangler, /^\d+\.\d+\.\d+$/);
  assert.match(
    worker.devDependencies["@cloudflare/workers-types"],
    /^\d+\.\d{8}\.\d+$/,
  );
  const rootPackage = readJson("package.json");
  assert.equal(
    rootPackage.scripts.test,
    "node --test tests/ci-workflow.test.mjs tests/cloudflare-config.test.mjs && turbo run test",
  );
});
