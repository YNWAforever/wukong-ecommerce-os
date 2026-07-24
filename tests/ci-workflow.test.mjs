import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  knownFormatDebtEntries,
  matchesKnownFormatDebt,
} from "../scripts/check-runtime-format.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const workflow = readFileSync(
  new URL(".github/workflows/ci.yml", new URL("../", import.meta.url)),
  "utf8",
);
const turbo = JSON.parse(
  readFileSync(new URL("turbo.json", new URL("../", import.meta.url)), "utf8"),
);
const rootPackage = JSON.parse(
  readFileSync(
    new URL("package.json", new URL("../", import.meta.url)),
    "utf8",
  ),
);
const workerPackage = JSON.parse(
  readFileSync(
    new URL("apps/worker/package.json", new URL("../", import.meta.url)),
    "utf8",
  ),
);
const databasePackage = JSON.parse(
  readFileSync(
    new URL("packages/db/package.json", new URL("../", import.meta.url)),
    "utf8",
  ),
);
const runtimeCheckSource = readFileSync(
  new URL("scripts/check-runtime-format.mjs", new URL("../", import.meta.url)),
  "utf8",
);
const localRunbook = readFileSync(
  new URL(
    "docs/runbooks/local-development.md",
    new URL("../", import.meta.url),
  ),
  "utf8",
);
const productionRunbook = readFileSync(
  new URL(
    "docs/runbooks/production-ai-runtime.md",
    new URL("../", import.meta.url),
  ),
  "utf8",
);
const readinessRunbook = readFileSync(
  new URL(
    "docs/runbooks/production-readiness.md",
    new URL("../", import.meta.url),
  ),
  "utf8",
);
const composeSource = readFileSync(
  new URL("docker-compose.yml", new URL("../", import.meta.url)),
  "utf8",
);
const secretVerifierUrl = new URL(
  "scripts/verify-cloudflare-secrets.mjs",
  new URL("../", import.meta.url),
);
const secretVerifierSource = existsSync(secretVerifierUrl)
  ? readFileSync(secretVerifierUrl, "utf8")
  : "";

test("installs pnpm before setup-node enables the pnpm cache", () => {
  const pnpmSetup = workflow.indexOf("uses: pnpm/action-setup@v6");
  const nodeSetup = workflow.indexOf("uses: actions/setup-node@v6");

  assert.notEqual(pnpmSetup, -1, "the workflow must install pnpm explicitly");
  assert.notEqual(
    nodeSetup,
    -1,
    "the workflow must use the Node 24 setup action",
  );
  assert.ok(
    pnpmSetup < nodeSetup,
    `pnpm setup must run before setup-node caching in ${repositoryRoot}`,
  );
});

test("builds workspace packages before running migrations", () => {
  const build = workflow.indexOf("- name: Build");
  const migrate = workflow.indexOf("- name: Apply migrations");

  assert.notEqual(build, -1, "the workflow must build workspace packages");
  assert.notEqual(migrate, -1, "the workflow must apply database migrations");
  assert.ok(
    build < migrate,
    "workspace packages must exist before migration imports run",
  );
});

test("builds dependency packages before workspace verification tasks", () => {
  for (const task of ["lint", "typecheck", "test"]) {
    assert.deepEqual(
      turbo.tasks[task].dependsOn,
      ["^build"],
      `${task} must build dependency packages before resolving dist exports`,
    );
  }
});

test("keeps service-backed suites in the integration gate", () => {
  assert.match(workerPackage.scripts.test, /--exclude .*integration\.test\.ts/);
  assert.match(
    databasePackage.scripts.test,
    /--exclude .*integration\.test\.ts/,
  );
});

test("pins the declared pnpm release toolchain", () => {
  assert.match(
    workflow,
    /uses: pnpm\/action-setup@v6[\s\S]*?version: 11\.7\.0/,
  );
  assert.match(workflow, /node-version: 24/);
});

test("runs the real storage, mail, browser, and audit release gate", () => {
  assert.match(workflow, /services:\s*\n\s+postgres:/);
  assert.doesNotMatch(workflow, /^\s+redis:/m);
  assert.doesNotMatch(workflow, /^\s+(?:TEST_)?REDIS_URL:/m);
  assert.match(
    workflow,
    /docker compose up -d --force-recreate minio minio-tls mailpit/,
  );
  for (const variable of [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
  ]) {
    assert.match(workflow, new RegExp(`^\\s+${variable}:`, "m"));
  }
  assert.match(workflow, /PLAYWRIGHT_E2E: "1"/);
  assert.match(
    workflow,
    /pnpm exec playwright test --project=chromium --workers=1 --reporter=line/,
  );
  assert.match(workflow, /audit:verify --workspace ws_opak --draft/);
});

test("defines a reproducible runtime formatting gate", () => {
  assert.equal(
    rootPackage.scripts["format:runtime:check"],
    "node scripts/check-runtime-format.mjs",
  );
});

test("renders and validates Cloudflare configuration without production credentials", () => {
  assert.match(workflow, /CLOUDFLARE_ENV: preview/);
  assert.match(
    workflow,
    /CLOUDFLARE_HYPERDRIVE_ID: [^\n]*(?:fake|local|00000000)/i,
  );
  assert.match(workflow, /node scripts\/render-cloudflare-config\.mjs/);
  assert.match(
    workflow,
    /node --test tests\/ci-workflow\.test\.mjs tests\/cloudflare-config\.test\.mjs/,
  );
  const playwrightStep = workflow.indexOf(
    "Playwright Wrangler Queue acceptance",
  );
  const localConnection = workflow.indexOf(
    "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:",
  );
  assert.ok(playwrightStep >= 0);
  assert.ok(
    localConnection > playwrightStep,
    "the local Hyperdrive connection belongs only to the Playwright step",
  );
  assert.match(
    workflow,
    /Playwright[\s\S]*?CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:/,
  );
});

test("runs an explicit forbidden legacy-runtime scan", () => {
  assert.equal(
    rootPackage.scripts["runtime:forbidden:check"],
    "node scripts/check-runtime-format.mjs --forbidden-runtime",
  );
  assert.match(workflow, /pnpm runtime:forbidden:check/);
});

test("documents the isolated Cloudflare production runtime and stop conditions", () => {
  for (const name of [
    "wukong-runtime-preview",
    "wukong-runtime-production",
    "wukong-listing-preview",
    "wukong-listing-production",
    "wukong-listing-dlq-preview",
    "wukong-listing-dlq-production",
    "wukong-shopline-preview",
    "wukong-shopline-production",
    "wukong-shopline-dlq-preview",
    "wukong-shopline-dlq-production",
    "wukong-neon-preview",
    "wukong-neon-production",
    "wukong-opak-preview-assets",
    "wukong-opak-prod-assets",
  ]) {
    assert.match(productionRunbook, new RegExp(`\\\`${name}\\\``));
  }

  for (const required of [
    /Vercel variable allowlist/i,
    /Worker variable allowlist/i,
    /QUEUE_INGRESS_SECRET[\s\S]*rotate/i,
    /queue backlog/i,
    /oldest message age/i,
    /DLQ depth/i,
    /DLQ replay/i,
    /Hyperdrive caching[\s\S]*disabled/i,
    /max(?:imum)? (?:of )?five (?:database )?connections/i,
    /seed-shopline-connection/i,
    /SHOPLINE_ADAPTER=mock/,
    /SHOPLINE_ADAPTER=disabled/,
    /separate (?:final )?confirmation[\s\S]*first real SHOPLINE write/i,
    /retain[\s\S]*queues[\s\S]*DLQs[\s\S]*R2[\s\S]*Neon ledgers/i,
  ]) {
    assert.match(productionRunbook, required);
  }
});

test("keeps the formatting-debt waiver exact, hash-pinned, and fail-closed", () => {
  const expected = [
    [
      "apps/web/app/api/assets/finalize/route.test.ts",
      "3abb816c52d65a7223313586b4ee6dd56da80abd43e5598a98ddda3b4d50845b",
    ],
    [
      "apps/web/app/api/assets/finalize/route.ts",
      "5aaa692c0b800758e6e63012d8aca47bc31b517b4924244763f3256fa1c097b2",
    ],
    [
      "apps/web/app/api/assets/presign/route.ts",
      "7adbcb02f097f202c849e229d9510f8c3a59059072aa81b55c0ad997c37388ea",
    ],
    [
      "apps/web/app/api/listings/route.create.test.ts",
      "175f467561747ea218d165278e1e57eb4023b50761f81898b3a0f4dc0461cbc0",
    ],
    [
      "apps/web/lib/listing-queue-runtime.ts",
      "0140cf7c13dbc3dddd78e32fec238ff548e31b4a25b94558fd6d61c5f967ad68",
    ],
    [
      "apps/worker/src/listing-consumer.test.ts",
      "e1b487bd64cfe877d416cdd270e731b42ad2a3dba17b2c52a89161c10e7d1035",
    ],
    [
      "apps/worker/src/pipeline-test-support.ts",
      "f02b9b9d618c3d9d74ab50acc393d832f3f4ed1614f5c250568a91f36662b90b",
    ],
    [
      "packages/db/src/index.ts",
      "314a726462f7407f4a608104634e1a3e6945a63a0bb9ac18c85077d2f6a1dc2d",
    ],
    [
      "packages/db/src/publish-jobs-schema.test.ts",
      "8c0609853aa150a6d7fd532e41f387fb152462758d35f4d860a80685f932c5d8",
    ],
    [
      "packages/db/src/repositories/publish-jobs.integration.test.ts",
      "60f109af4c944409f7cfe348c697299a3f34a83a008b1c3478581d43f6e36c7c",
    ],
    [
      "packages/db/src/schema.ts",
      "21c8b510142bf891215df98175e1a168df6016a6a325b7a3b7a45457599034ee",
    ],
    [
      "packages/jobs/src/cloudflare-queue.ts",
      "1f17ed387564268afbdf82c4354a04d7e27b0525d0d2a5dfc613c925796f1b43",
    ],
  ];
  assert.deepEqual(knownFormatDebtEntries(), expected);
  for (const [file, hash] of expected) {
    assert.ok(productionRunbook.includes(file), file);
    assert.ok(productionRunbook.includes(hash), hash);
  }

  for (const [file] of expected) {
    const source = readFileSync(
      new URL(file, new URL("../", import.meta.url)),
      "utf8",
    );
    assert.equal(matchesKnownFormatDebt(file, source), true, file);
    assert.equal(
      matchesKnownFormatDebt(file, `${source}\n// changed`),
      false,
      file,
    );
  }
  assert.equal(
    matchesKnownFormatDebt("apps/new-drift.ts", "unformatted"),
    false,
  );
});
test("keeps local development and readiness Cloudflare-only", () => {
  assert.doesNotMatch(localRunbook, /docker compose up[^\n]*redis/i);
  assert.doesNotMatch(localRunbook, /REDIS_URL|BullMQ|Railway/i);
  assert.match(localRunbook, /wrangler dev/i);
  assert.match(
    localRunbook,
    /CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE/,
  );
  assert.doesNotMatch(readinessRunbook, /Upstash|BullMQ|Railway|REDIS_URL/i);
  assert.match(readinessRunbook, /Cloudflare Queues/i);
  assert.match(readinessRunbook, /separate (?:final )?confirmation/i);
});

test("renders every safe Worker variable and generates Wrangler types in CI", () => {
  for (const variable of [
    "BUILD_SHA",
    "AI_PROVIDER",
    "OPENAI_LISTING_MODEL",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_FORCE_PATH_STYLE",
  ]) {
    assert.match(
      workflow,
      new RegExp(
        `Render and validate Cloudflare configuration[\\s\\S]*?${variable}:`,
      ),
      variable,
    );
  }
  assert.doesNotMatch(
    workflow,
    /Render and validate Cloudflare configuration[\s\S]*?SHOPLINE_ADAPTER:\s*(?:real|disabled)/,
  );
  assert.doesNotMatch(
    workflow,
    /Render and validate Cloudflare configuration[\s\S]*?SHOPLINE_PUBLISH_ENABLED:\s*true/,
  );
  const render = workflow.indexOf("node scripts/render-cloudflare-config.mjs");
  const unsetEnvironment = workflow.indexOf("unset CLOUDFLARE_ENV");
  const types = workflow.indexOf("pnpm --filter @wukong/worker types");
  assert.ok(
    render >= 0 && unsetEnvironment > render && types > unsetEnvironment,
    "Wrangler types must run after render without CLOUDFLARE_ENV",
  );
});

test("fails closed on the exact Worker secret contract before deploy", () => {
  const expectedSecrets = [
    "QUEUE_INGRESS_SECRET",
    "OPENAI_API_KEY",
    "SHOPLINE_TOKEN_ENCRYPTION_KEY",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ];
  for (const secret of expectedSecrets) {
    assert.match(
      productionRunbook,
      new RegExp(`wrangler secret put ${secret}`),
    );
  }
  assert.match(productionRunbook, /wrangler secret list[\s\S]*--format json/);
  assert.match(
    productionRunbook,
    /missing[\s\S]*unexpected secret name[\s\S]*abort/i,
  );
  assert.match(secretVerifierSource, /secret["',\s]+list/);
  assert.match(secretVerifierSource, /--format["',\s]+json/);
  assert.match(secretVerifierSource, /missing/i);
  assert.match(secretVerifierSource, /unexpected/i);
  for (const script of ["deploy:preview", "deploy:production"]) {
    const command = workerPackage.scripts[script];
    const verify = command.indexOf("verify-cloudflare-secrets.mjs");
    const deploy = command.indexOf("wrangler deploy");
    assert.ok(
      verify >= 0 && deploy > verify,
      `${script} must verify before deploy`,
    );
  }
});

test("documents distinct least-privilege R2 credentials per environment", () => {
  assert.match(
    productionRunbook,
    /two distinct[^\n]*R2 credentials[^\n]*per environment/i,
  );
  assert.match(productionRunbook, /Vercel[\s\S]*Object Read & Write/);
  assert.match(productionRunbook, /Worker[\s\S]*Object Read(?: |-)?only/i);
  assert.match(
    productionRunbook,
    /credential[^\n]*(?:must not|never)[^\n]*(?:reuse|shared)/i,
  );
  assert.match(productionRunbook, /CORS[^\n]*Vercel/i);
  assert.match(productionRunbook, /Worker[^\n]*read-only[^\n]*CORS/i);
});

test("uses one stable Compose project across worktrees", () => {
  assert.match(composeSource, /^name: wukong-ecommerce-local$/m);
  const inspect = localRunbook.indexOf("docker compose ps");
  const down = localRunbook.indexOf("docker compose down --remove-orphans");
  const up = localRunbook.indexOf(
    "docker compose up -d --force-recreate postgres minio minio-tls mailpit",
  );
  assert.ok(inspect >= 0 && down > inspect && up > down);
  assert.match(localRunbook, /shared Compose project[\s\S]*worktree/i);
  assert.match(localRunbook, /--force-recreate[\s\S]*replace/i);
});
