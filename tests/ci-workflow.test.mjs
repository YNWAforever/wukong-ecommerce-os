import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { check } from "prettier";

import {
  knownFormatDebtEntries,
  matchesKnownFormatDebt,
  protectedUnrelatedFileEntries,
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
  assert.match(
    workflow,
    /audit:verify --workspace "\$WORKSPACE_ID" --draft "\$DRAFT_ID"/,
  );
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
  const playwrightStep = workflow.indexOf("- name: Playwright");
  const localConnection = workflow.indexOf(
    "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:",
  );
  assert.ok(playwrightStep >= 0);
  assert.ok(
    localConnection > playwrightStep,
    "the local Hyperdrive connection belongs only to the Playwright steps",
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
      "apps/worker/src/listing-consumer.test.ts",
      "004dcee5a589f459004489c538632cf202a225066922996be1e35b9b00fea41f",
    ],
    [
      "packages/db/src/publish-jobs-schema.test.ts",
      "8c0609853aa150a6d7fd532e41f387fb152462758d35f4d860a80685f932c5d8",
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
  assert.match(
    workflow,
    /S3_ENDPOINT: https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com/,
  );
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

test("documents replacement of stale plaintext vars and exact secret protection", () => {
  assert.match(
    productionRunbook,
    /deployment replaces[\s\S]*plaintext variables[\s\S]*deletes[\s\S]*stale/i,
  );
  assert.match(
    productionRunbook,
    /exact-name secret preflight[\s\S]*protects[\s\S]*five encrypted secrets/i,
  );
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

test("prepares the configured local bucket before storage integration tests", () => {
  const prepare = workflow.indexOf(
    "- name: Prepare integration object storage",
  );
  const integration = workflow.indexOf("- name: Integration tests");
  assert.ok(
    prepare >= 0,
    "CI must create its bucket before first integration write",
  );
  assert.ok(
    prepare < integration,
    "bucket setup must precede integration tests",
  );
  const step = workflow.slice(prepare, integration);
  assert.match(step, /CreateBucketCommand/);
  assert.match(step, /HeadBucketCommand/);
  assert.match(step, /Bucket: process.env.S3_BUCKET/);
  assert.match(step, /endpoint: process.env.S3_ENDPOINT/);
  assert.match(step, /BucketAlreadyOwnedByYou/);
  assert.match(step, /throw error/);
});

test("runs product-shot acceptance separately with synthetic image processing and TLS", () => {
  const image = workflow.indexOf("- name: Playwright product-shot acceptance");
  const legacy = workflow.indexOf(
    "- name: Playwright Wrangler Queue acceptance",
  );
  assert.ok(
    image >= 0 && image < legacy,
    "image mode must run separately before legacy audit evidence",
  );
  const step = workflow.slice(image, legacy);
  assert.match(step, /WUKONG_PRODUCT_SHOT_E2E: "1"/);
  assert.match(step, /playwright test tests\/e2e\/product-shot\.spec\.ts/);
  assert.match(step, /--retries=0/);
  assert.match(step, /openssl verify/);
  assert.match(step, /photoroom-services\/certs\/public\.crt/);
  const config = readFileSync(
    new URL("../playwright.config.ts", import.meta.url),
    "utf8",
  );
  assert.match(config, /WUKONG_PRODUCT_SHOT_E2E/);
  assert.match(config, /testIgnore:[\s\S]*?product-shot\.spec\.ts/);
});

test("CI image mode exercises both synthetic failure outcomes for the actual fixture bytes", () => {
  const image = workflow.indexOf("- name: Playwright product-shot acceptance");
  const legacy = workflow.indexOf(
    "- name: Playwright Wrangler Queue acceptance",
  );
  const step = workflow.slice(image, legacy);
  const configured = step.match(/PRODUCT_SHOT_SYNTHETIC_SCENARIO: '([^']+)'/);
  assert.ok(
    configured,
    "image acceptance must configure fake failure scenarios",
  );
  const scenarios = JSON.parse(configured[1]);
  const fixture = readFileSync(
    new URL("./e2e/real-stack-fixture.ts", import.meta.url),
    "utf8",
  );
  for (const [name, outcome] of [
    ["definitiveFailure", "definitive_failure"],
    ["ambiguous", "ambiguous_completion"],
  ]) {
    const match = fixture.match(
      new RegExp(`${name}: Buffer\\.from\\(\\s*"([^"]+)"`),
    );
    assert.ok(match, `synthetic ${name} image must exist`);
    const digest = createHash("sha256")
      .update(Buffer.from(match[1], "base64"))
      .digest("hex");
    assert.equal(scenarios[digest], outcome);
  }
  assert.equal(Object.keys(scenarios).length, 2);
  assert.doesNotMatch(
    workflow.slice(legacy),
    /PRODUCT_SHOT_SYNTHETIC_SCENARIO:/,
  );
});

test("browser modes allow the real-stack harness to stop detached children", async () => {
  const previous = process.env.PLAYWRIGHT_E2E;
  process.env.PLAYWRIGHT_E2E = "1";
  try {
    const { default: config } = await import("../playwright.config.ts");
    assert.deepEqual(config.webServer.gracefulShutdown, {
      signal: "SIGTERM",
      timeout: 15000,
    });
    if (process.platform !== "win32")
      assert.match(config.webServer.command, /&& exec node/);
    assert.equal(config.webServer.reuseExistingServer, !process.env.CI);
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_E2E;
    else process.env.PLAYWRIGHT_E2E = previous;
  }
});

test("audits the workspace and draft emitted by the same completed browser fixture", () => {
  assert.match(
    workflow,
    /WORKSPACE_ID="\$\(cat test-results\/real-stack-workspace-id\.txt\)"/,
  );
  assert.match(workflow, /test -n "\$WORKSPACE_ID"/);
  const pilot = readFileSync(
    new URL("./e2e/listing-pilot.spec.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    pilot,
    /writeFile\(\s*"test-results\/real-stack-workspace-id\.txt",\s*OPAK_WORKSPACE_ID,/,
  );
  assert.match(
    pilot,
    /writeFile\("test-results\/real-stack-draft-id\.txt", draftId!/,
  );
});

test("keeps the protected-file exclusions exact and self-justifying", async () => {
  // The gate has two escape hatches. knownFormatDebt is hash-pinned and has
  // been pinned by a test for as long as it has existed. protectedUnrelatedFiles
  // was neither exported nor tested, so a path added to it left the gate in
  // silence -- and because the gate diff-scopes to merge-base..HEAD, a file
  // already on main is never looked at either. That combination is how the
  // 2026-08-30 specification sat unformatted while CI stayed green, with the
  // failure waiting for the next commit that happened to touch it.
  const expected = [
    ".gitignore",
    "apps/web/.gitignore",
    "apps/web/auth.test.ts",
    "docs/superpowers/plans/2026-07-12-shopline-ai-listing-mvp.md",
    "docs/superpowers/plans/Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md",
  ];

  assert.deepEqual(protectedUnrelatedFileEntries(), expected);

  // A Prettier-clean file must never be parked here. The list is for documents
  // kept exactly as received; it is not a way to skip formatting. The two
  // dotfiles are belt-and-braces: extname is "" for both, which is not in
  // supportedExtensions, so the gate never reaches them regardless.
  for (const file of expected) {
    if (!file.endsWith(".md") && !file.endsWith(".ts")) continue;
    const source = readFileSync(
      new URL(file, new URL("../", import.meta.url)),
      "utf8",
    ).replaceAll("\r\n", "\n");
    assert.equal(
      await check(source, { filepath: file }),
      false,
      file + " is Prettier-clean, so it does not need an exemption",
    );
  }
});

test("keeps the three end-to-end ports disjoint", () => {
  // The auth mode and the real-stack public-image server both claimed 49218.
  // Whichever started second died on EADDRINUSE, and because
  // real-stack-server.mjs binds the application port as well, losing the image
  // port took the app down with it -- so the failure surfaced as a refused
  // connection on 49217, a port that was never the conflict. Derived from the
  // sources rather than restated, so moving a port cannot re-collide silently.
  const config = readFileSync(
    new URL("playwright.config.ts", new URL("../", import.meta.url)),
    "utf8",
  );
  const harness = readFileSync(
    new URL("tests/e2e/real-stack-server.mjs", new URL("../", import.meta.url)),
    "utf8",
  );

  const authPort = /--port (\d+)"/.exec(config)?.[1];
  const appPort = /PORT: "(\d+)"/.exec(config)?.[1];
  const imagePort = /publicImagePort = (\d+);/.exec(harness)?.[1];

  assert.ok(authPort, "auth-mode dev server port not found");
  assert.ok(appPort, "real-stack app port not found");
  assert.ok(imagePort, "public-image port not found");
  assert.equal(
    new Set([authPort, appPort, imagePort]).size,
    3,
    `ports collide: auth=${authPort} app=${appPort} image=${imagePort}`,
  );
});
