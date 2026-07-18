import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(
  readFileSync(new URL("../railway.json", import.meta.url), "utf8"),
);
const worker = JSON.parse(
  readFileSync(new URL("../apps/worker/package.json", import.meta.url), "utf8"),
);

const expectedWatchPatterns = [
  "apps/worker/**",
  "packages/ai/**",
  "packages/assets/**",
  "packages/core/**",
  "packages/db/**",
  "packages/jobs/**",
  "packages/shopline/**",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "turbo.json",
  "railway.json",
];

test("runs only the compiled private worker with bounded restart recovery", () => {
  assert.equal(config.build.builder, "RAILPACK");
  assert.match(
    config.build.buildCommand,
    /pnpm --filter @wukong\/worker\.\.\. build/,
  );
  assert.equal(
    config.deploy.startCommand,
    "pnpm --filter @wukong/worker start:production",
  );
  assert.equal(config.deploy.restartPolicyType, "ON_FAILURE");
  assert.equal(config.deploy.restartPolicyMaxRetries, 10);
  assert.equal(config.deploy.drainingSeconds, "30");
  assert.deepEqual(config.build.watchPatterns, expectedWatchPatterns);
  assert.equal(worker.scripts["start:production"], "node dist/cli.js");
  assert.equal(config.deploy.preDeployCommand, undefined);
  assert.equal(config.deploy.healthcheckPath, undefined);
});

test("documents production resource ownership, release order, and rollback", () => {
  const runbook = readFileSync(
    new URL("../docs/runbooks/production-ai-runtime.md", import.meta.url),
    "utf8",
  );
  const environment = readFileSync(
    new URL("../.env.example", import.meta.url),
    "utf8",
  );
  const readiness = readFileSync(
    new URL("../docs/runbooks/production-readiness.md", import.meta.url),
    "utf8",
  );

  for (const heading of [
    "## Cost decision",
    "## Resource names",
    "## R2 CORS policy",
    "## Variable ownership",
    "## Migration and deployment order",
    "## Verification",
    "## Rollback",
    "## Official references",
  ]) {
    assert.match(runbook, new RegExp(`^${heading}$`, "m"));
  }

  for (const name of [
    "DATABASE_URL",
    "REDIS_URL",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
    "AI_PROVIDER",
    "OPENAI_API_KEY",
    "OPENAI_LISTING_MODEL",
  ]) {
    assert.match(environment, new RegExp(`^${name}=`, "m"));
  }

  assert.match(runbook, /wukong-opak-prod-assets/);
  assert.match(runbook, /wukong-listing-queue-prod/);
  assert.match(runbook, /wukong-ecommerce-os/);
  assert.match(runbook, /listing-worker/);
  assert.match(runbook, /DATABASE_ADMIN_URL.*release-only/);
  assert.match(runbook, /listing\.enqueue_accepted/);
  assert.match(readiness, /production-ai-runtime\.md/);
});
