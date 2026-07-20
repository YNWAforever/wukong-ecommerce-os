import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
  },
  production: {
    worker: "wukong-runtime-production",
    listingQueue: "wukong-listing-production",
    listingDlq: "wukong-listing-dlq-production",
    shoplineQueue: "wukong-shopline-production",
    shoplineDlq: "wukong-shopline-dlq-production",
  },
};

test("keeps exact isolated queue and DLQ resource names", () => {
  const source = readJson("cloudflare-runtime.config.json");
  assert.deepEqual(source.environments, expected);
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
  const result = spawnSync(
    process.execPath,
    ["scripts/render-cloudflare-config.mjs"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        CLOUDFLARE_ENV: "preview",
        CLOUDFLARE_HYPERDRIVE_ID: "hyperdrive-preview-id",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const config = readJson(".wrangler/wrangler.generated.jsonc");
  assert.deepEqual(config, {
    name: expected.preview.worker,
    main: "apps/worker/src/cloudflare.ts",
    compatibility_date: "2026-07-19",
    compatibility_flags: ["nodejs_compat"],
    limits: { cpu_ms: 240000 },
    observability: { enabled: true },
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
    /secret|token|password|connectionString|database_url|api[_-]?key/i,
  );
});

test("requires only non-secret renderer inputs and rejects unknown environments", () => {
  for (const env of [
    { CLOUDFLARE_HYPERDRIVE_ID: "id" },
    { CLOUDFLARE_ENV: "preview" },
    { CLOUDFLARE_ENV: "staging", CLOUDFLARE_HYPERDRIVE_ID: "id" },
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/render-cloudflare-config.mjs"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ...env,
        },
      },
    );
    assert.notEqual(result.status, 0);
  }
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
