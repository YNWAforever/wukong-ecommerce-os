/**
 * What each surface needs at runtime, written down once.
 *
 * Names only, never values -- the same rule as `.env.example`.
 *
 * Before this existed, nothing in the repository said what `apps/web` requires.
 * The doctor checked the Worker's secrets and the operator's own shell, and an
 * operator bringing production up had no list to compare `vercel env ls`
 * against. That is how `DATABASE_MIGRATION_URL` survived: a name read in one
 * file, spelled differently from the `DATABASE_ADMIN_URL` used everywhere else,
 * documented nowhere, and handed to a `migrate()` the web app never calls.
 *
 * `tests/runtime-env-manifest.test.mjs` scans the source for every
 * `process.env.X` these surfaces read and fails when one is missing here, so
 * this list cannot quietly fall behind the code.
 */

/**
 * Supplied by the platform. Never set by hand, never checked, and deliberately
 * absent from `.env.example` -- an entry there would invite someone to set it.
 */
export const PLATFORM_PROVIDED = [
  "NODE_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
];

/**
 * Supplied in the deploy shell and consumed by `render-cloudflare-config.mjs`.
 *
 * Not `.env` entries: `BUILD_SHA` is `git rev-parse HEAD` at deploy time and
 * `CLOUDFLARE_HYPERDRIVE_ID` comes from `wrangler hyperdrive list`. Writing
 * either into a file would make it stale the moment it was written, which is
 * why the bring-up runbook `export`s them instead.
 */
export const DEPLOY_RENDER_INPUTS = ["BUILD_SHA", "CLOUDFLARE_HYPERDRIVE_ID"];

/**
 * Values that must never reach Vercel, whatever they are called.
 *
 * `docs/runbooks/production-ai-runtime.md` states the rule in prose; this makes
 * it checkable. A name here is a finding if the web app reads it at all.
 */
export const FORBIDDEN_ON_VERCEL = [
  "DATABASE_ADMIN_URL",
  "DATABASE_MIGRATION_URL",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "PHOTOROOM_API_KEY",
];

/**
 * What the Next.js app needs.
 *
 * `optional` means the app runs without it, not that it does not matter:
 * `S3_REGION` defaults to `auto` and `S3_FORCE_PATH_STYLE` to `false`
 * (`packages/assets/src/s3-runtime-config.ts`), and an absent
 * `PRODUCT_SHOT_PROVIDER` reads as `disabled`.
 *
 * `SHOPLINE_TOKEN_ENCRYPTION_KEY` is required rather than optional even though
 * its absence is handled: `apps/web/app/api/workspace/connection/route.ts`
 * answers `503 runtime_unavailable`, which is a clean failure of a screen the
 * merchant needs, not an acceptable steady state.
 */
export const WEB_RUNTIME_ENV = {
  required: [
    "AUTH_EMAIL_FROM",
    "AUTH_SECRET",
    "AUTH_SMTP_URL",
    "BETTER_AUTH_URL",
    "DATABASE_URL",
    "QUEUE_INGRESS_SECRET",
    "QUEUE_INGRESS_URL",
    "S3_ACCESS_KEY_ID",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_SECRET_ACCESS_KEY",
    "SHOPLINE_TOKEN_ENCRYPTION_KEY",
  ],
  optional: [
    "PRODUCT_IMAGE_PUBLIC_ORIGIN",
    "PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY",
    "PRODUCT_SHOT_PROVIDER",
    "S3_FORCE_PATH_STYLE",
    "S3_REGION",
  ],
};

/**
 * What the Worker needs beyond the secrets `listing-provider-config.mjs`
 * already derives from the chosen providers. These are plain vars rendered into
 * the wrangler config, not secrets.
 */
export const WORKER_RUNTIME_ENV = {
  required: [
    "AI_PROVIDER",
    "BUILD_SHA",
    "CLOUDFLARE_HYPERDRIVE_ID",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_FORCE_PATH_STYLE",
    "S3_REGION",
  ],
  optional: [
    "OPENAI_LISTING_MODEL",
    "OPENROUTER_LISTING_MODEL",
    "PRODUCT_IMAGE_PUBLIC_ORIGIN",
    "PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY",
    "PRODUCT_SHOT_PROVIDER",
    "WEBSITE_FETCH_BASE_URL",
  ],
};

/** Every name a surface may legitimately read. */
export function knownNames(manifest) {
  return new Set([
    ...manifest.required,
    ...manifest.optional,
    ...PLATFORM_PROVIDED,
  ]);
}

/** The variable names `.env.example` documents, in file order. */
export function documentedEnvNames(source) {
  return source
    .split(/\r?\n/)
    .map((line) => /^([A-Z_][A-Z0-9_]*)=/.exec(line.trim())?.[1])
    .filter((name) => name !== undefined);
}

/**
 * Names the manifest lists that `.env.example` does not document.
 *
 * Deploy-time render inputs are excluded because a file is the wrong place for
 * them, and the Vercel deny list because documenting those in an app env file
 * would read as an invitation to set them there.
 */
export function undocumentedNames(manifest, envExampleSource) {
  const documented = new Set(documentedEnvNames(envExampleSource));
  const exempt = new Set([...FORBIDDEN_ON_VERCEL, ...DEPLOY_RENDER_INPUTS]);
  return [...manifest.required, ...manifest.optional].filter(
    (name) => !documented.has(name) && !exempt.has(name),
  );
}
