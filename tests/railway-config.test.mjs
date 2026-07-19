import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readText(relativePath) {
  return readFileSync(
    new URL(relativePath, import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
}

function markdownSection(markdown, heading) {
  const marker = `${heading}\n`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `missing Markdown section: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const bodyStart = start + marker.length;
  const tail = markdown.slice(bodyStart);
  const nextHeading = tail.search(new RegExp(`^#{1,${level}}\\s`, "m"));
  return nextHeading === -1 ? tail : tail.slice(0, nextHeading);
}

function bulletCodeNames(markdown) {
  return [...markdown.matchAll(/^- `([^`]+)`(?:\s|$)/gm)].map(
    (match) => match[1],
  );
}

function inlineCode(markdown) {
  return [...markdown.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function parseEnvironment(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `malformed environment line: ${line}`);
    const key = line.slice(0, separator);
    assert.equal(
      Object.hasOwn(values, key),
      false,
      `duplicate environment key: ${key}`,
    );
    values[key] = line.slice(separator + 1);
  }
  return values;
}

const config = JSON.parse(readText("../railway.json"));
const worker = JSON.parse(readText("../apps/worker/package.json"));
const rootPackage = JSON.parse(readText("../package.json"));
const runbook = readText("../docs/runbooks/production-ai-runtime.md");
const environment = readText("../.env.example");
const readiness = readText("../docs/runbooks/production-readiness.md");

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

const vercelVariables = [
  "REDIS_URL",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
];

const railwayVariables = [
  "DATABASE_URL",
  "REDIS_URL",
  ...vercelVariables.slice(1),
  "AI_PROVIDER",
  "OPENAI_API_KEY",
  "OPENAI_LISTING_MODEL",
];

test("defines the exact private Railway worker contract", () => {
  assert.deepEqual(config, {
    $schema: "https://railway.com/railway.schema.json",
    build: {
      builder: "RAILPACK",
      buildCommand:
        "corepack enable && pnpm install --frozen-lockfile && pnpm --filter @wukong/worker... build",
      watchPatterns: expectedWatchPatterns,
    },
    deploy: {
      startCommand: "pnpm --filter @wukong/worker start:production",
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      drainingSeconds: "30",
    },
  });
  assert.equal(worker.scripts["start:production"], "node dist/cli.js");
  assert.equal(
    rootPackage.scripts.test,
    "node --test tests/ci-workflow.test.mjs tests/railway-config.test.mjs && turbo run test",
  );
});

test("keeps the environment template names-only with exact safe fixed values", () => {
  assert.deepEqual(parseEnvironment(environment), {
    DATABASE_URL: "",
    REDIS_URL: "",
    S3_BUCKET: "",
    S3_ENDPOINT: "",
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
    S3_FORCE_PATH_STYLE: "false",
    AI_PROVIDER: "openai",
    OPENAI_API_KEY: "",
    OPENAI_LISTING_MODEL: "gpt-5.6-terra",
  });
});

test("documents the canonical production runtime contract", () => {
  assert.deepEqual(
    [...runbook.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    [
      "Cost decision",
      "Resource names",
      "R2 CORS policy",
      "Variable ownership",
      "Migration and deployment order",
      "Verification",
      "Rollback",
      "Official references",
    ],
  );

  const resources = markdownSection(runbook, "## Resource names");
  for (const resource of [
    "wukong-opak-prod-assets",
    "wukong-listing-queue-prod",
    "wukong-ecommerce-os",
    "listing-worker",
  ]) {
    assert.match(resources, new RegExp(`\\b${resource}\\b`));
  }
  assert.match(resources, /TLS `rediss:\/\/` Upstash endpoint/);
  assert.match(
    resources,
    /eviction is disabled.*no eviction.*queue keys cannot be evicted under capacity pressure/is,
  );

  const cors = markdownSection(runbook, "## R2 CORS policy");
  const corsFence = cors.match(/```json\s*([\s\S]*?)```/);
  assert.ok(corsFence, "missing R2 CORS JSON");
  assert.deepEqual(JSON.parse(corsFence[1]), [
    {
      AllowedOrigins: [
        "https://wukong-ecommerce-os.vercel.app",
        "http://localhost:3000",
      ],
      AllowedMethods: ["PUT", "HEAD"],
      AllowedHeaders: ["Content-Type"],
      ExposeHeaders: ["ETag"],
      MaxAgeSeconds: 3600,
    },
  ]);
  assert.match(cors, /selected Vercel preview deployment origin/);
  assert.match(cors, /Remove that origin after the preview is retired/);

  const vercel = markdownSection(runbook, "### Vercel");
  assert.deepEqual(bulletCodeNames(vercel), vercelVariables);
  assert.match(vercel, /Vercel must not receive `OPENAI_API_KEY`/);

  const railway = markdownSection(runbook, "### Railway");
  assert.deepEqual(bulletCodeNames(railway), railwayVariables);
  const railwayDenylist = railway.match(/Do not store ([^.]+)\./);
  assert.ok(railwayDenylist, "missing Railway denylist");
  assert.deepEqual(inlineCode(railwayDenylist[1]), [
    "DATABASE_ADMIN_URL",
    "AUTH_SECRET",
    "AUTH_SMTP_URL",
    "SHOPLINE_*",
  ]);
  assert.match(railwayDenylist[1], /Resend\/auth-mail variables/);

  const deployment = markdownSection(
    runbook,
    "## Migration and deployment order",
  );
  const migration = deployment.indexOf(
    "pnpm.cmd --filter @wukong/db db:migrate",
  );
  const productionWorker = deployment.indexOf(
    "Deploy Vercel production and the private Railway worker",
  );
  assert.ok(migration >= 0 && productionWorker > migration);
  assert.match(
    deployment,
    /Keep the new Railway worker stopped until the controlled migration succeeds/,
  );
  assert.match(
    deployment,
    /preview[\s\S]*eviction (?:is )?disabled[\s\S]*production[\s\S]*eviction (?:is )?disabled/i,
  );

  const verification = markdownSection(runbook, "## Verification");
  assert.match(verification, /listing\.enqueue_accepted/);
  assert.match(verification, /listing worker started/);
  assert.match(verification, /job consumption/i);
  const safeCodes = verification.match(
    /only the safe codes ([^.]+) may be retained/,
  );
  assert.ok(safeCodes, "missing terminal safe-code contract");
  assert.deepEqual(inlineCode(safeCodes[1]), [
    "provider_timeout",
    "provider_failure",
    "pipeline_failure",
  ]);
  assert.match(
    verification,
    /preview[\s\S]*production[\s\S]*eviction (?:is )?disabled|eviction (?:is )?disabled[\s\S]*preview[\s\S]*production/i,
  );

  const rollback = markdownSection(runbook, "## Rollback");
  assert.match(rollback, /Retain the Upstash Redis queue and all Neon records/);
  assert.match(rollback, /Never delete `wukong-opak-prod-assets`/);
  assert.match(
    rollback,
    /keep eviction disabled.*(?:stop|scale).*never enable eviction/is,
  );

  const references = markdownSection(runbook, "## Official references");
  assert.deepEqual(
    [...references.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map(
      (match) => match[1],
    ),
    [
      "https://upstash.com/docs/redis/integrations/bullmq",
      "https://upstash.com/pricing/redis",
      "https://developers.cloudflare.com/r2/api/s3/presigned-urls/",
      "https://developers.cloudflare.com/r2/buckets/cors/",
      "https://developers.cloudflare.com/r2/pricing/",
      "https://docs.railway.com/pricing",
      "https://docs.railway.com/config-as-code/reference",
      "https://docs.railway.com/deployments/monorepo",
      "https://vercel.com/docs/cli/env",
    ],
  );

  assert.match(readiness, /production-ai-runtime\.md/);

  const checkedText = `${runbook}\n${environment}\n${JSON.stringify(config)}`;
  assert.doesNotMatch(checkedText, /\bsk-[A-Za-z0-9_-]{12,}\b/);
  assert.doesNotMatch(checkedText, /\bAKIA[A-Z0-9]{16}\b/);
  assert.doesNotMatch(
    checkedText,
    /(?:postgres(?:ql)?|rediss):\/\/[^`\s/:]+:[^`\s@]+@/i,
  );
  for (const sensitiveName of [
    "DATABASE_URL",
    "DATABASE_ADMIN_URL",
    "REDIS_URL",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "OPENAI_API_KEY",
  ]) {
    assert.doesNotMatch(runbook, new RegExp(`^${sensitiveName}=.+$`, "m"));
  }
});
