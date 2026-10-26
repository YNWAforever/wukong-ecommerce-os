# Build and deployment

Web runs on Vercel; Queue ingress, consumers and recovery cron run on Cloudflare.
Postgres is behind the runtime role/Hyperdrive boundary, and assets are private
R2 objects. This runbook documents release commands; it does not activate a
provider, provision resources or authorize a production write.

## Build locally without deployment

Start with `pnpm test` and `pnpm typecheck`. The Worker build requires a generated
Wrangler config and types. This synthetic preview configuration matches CI and
does not contact Cloudflare or create resources:

```sh
CLOUDFLARE_ENV=preview \
CLOUDFLARE_HYPERDRIVE_ID=00000000000000000000000000000000 \
BUILD_SHA="$(git rev-parse HEAD)" \
AI_PROVIDER=fake OPENAI_LISTING_MODEL=gpt-5-mini \
S3_BUCKET=wukong-opak-preview-assets \
S3_ENDPOINT=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com \
S3_REGION=auto S3_FORCE_PATH_STYLE=false \
  node scripts/render-cloudflare-config.mjs
pnpm --filter @wukong/worker types
AUTH_SECRET=local-build-only-secret-at-least-thirty-two-characters \
BETTER_AUTH_URL=http://localhost:3000 AUTH_EMAIL_FROM=auth@local.invalid \
AUTH_SMTP_URL=smtp://127.0.0.1:1026 \
SHOPLINE_TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  pnpm build
```

`CLOUDFLARE_ENV` is scoped to the renderer; do not leave it exported for
`wrangler types`. `pnpm build` runs Next production build and Wrangler
`deploy --dry-run`, not a deployment. Never deploy this dummy Hyperdrive ID or
synthetic storage endpoint. Generated config/types live in ignored `.wrangler/`.

## Release an approved commit

1. Require the exact commit's [CI](../../.github/workflows/ci.yml) unit,
   integration, build and Playwright checks. Run `pnpm release-gate:check` and
   complete the human items in [production readiness](production-readiness.md).
   Record the commit, migration set, environment and rollback owners.
2. Confirm the environment's Vercel project, Worker, Queues/DLQs, private bucket,
   database and cache-disabled Hyperdrive match
   [production runtime](production-ai-runtime.md#exact-isolated-resources).
   Apply migrations through a controlled job using the admin credential;
   neither web nor Worker receives that credential. Confirm preview migrations
   too. Worker startup never applies migrations.
3. Set non-secret configuration and secrets in their owning platform scopes.
   Use [.env.example](../../.env.example) and the runtime runbook as inventories.
   Web and Worker need the same ingress signing secret, but separate scoped
   storage credentials. Provider keys stay Worker-side. Keep paid admission and
   wine admission off until their specific acceptance gates are satisfied.
4. Render the **real environment's** config with its approved IDs, bucket,
   endpoint, provider/model and `BUILD_SHA`. Verify required secret names using
   the runtime runbook. The renderer forces preview SHOPLINE to `mock`,
   production to `disabled`, and publish enablement to `false`.
5. Ship a compatible Worker consumer before a web producer that adds Queue
   fields. If prompt/schema compatibility changes, pause admission/drain the
   affected Queue, coordinate both deploys and inspect accepted work before
   resuming. See [production recovery](production-recovery-2026-10-08.md) for
   compatibility/preflight procedures. Deploy commands, after configuration:

   ```sh
   pnpm --filter @wukong/worker deploy:preview
   # Production release instead:
   pnpm --filter @wukong/worker deploy:production
   ```

   Each script runs the pre-deploy doctor, renderer and exact-name secret check
   before Wrangler deployment. Use only the command for the intended environment.
   Deploy web through the linked Vercel project's approved Git release flow;
   confirm monorepo root `apps/web`, pnpm frozen install, dependency builds and
   environment scope. Record the actual deployment SHA rather than assuming a
   merge deployed successfully. Platform configuration is external to this repo.

6. Run `pnpm runtime:doctor preview` or `pnpm runtime:doctor production` with
   that environment's controlled configuration. Check both deployed versions,
   signed health, Queue age/DLQs, a synthetic operator journey, persisted
   operation/audit state and private asset access. The doctor uses the shell's
   ingress secret; it does not by itself prove Vercel has the same value.

Real SHOPLINE enablement requires the separate first-write confirmation in
[production readiness](production-readiness.md#shopline-production-gate).
Unit tests and synthetic Queue acceptance do not grant that confirmation.

## Rollback and recovery

Disable admission/SHOPLINE writes and pause affected Queues before incompatible
rollback. Restore compatible web and Worker versions; retain database ledgers,
audits, primary Queues, DLQs and private objects. Do not reverse migrations or
purge work as a generic rollback step. Inspect accepted prompt/version pins and
reconcile ambiguous remote outcomes before retrying. Replay only reviewed
IDs-only messages, one at a time, and verify their durable result. Follow
[production readiness rollback](production-readiness.md#rollback) and the
[runtime recovery procedure](opak-runtime-recovery.md) for owner/evidence details.
