# Production Worker release checklist (2026-10-06)

Brings `wukong-runtime-production` from build `3ca5b995` (2026-09-16, #87) up to `main`, then
ships #132 (listing prompt hardening). Read-only checks were run on 2026-10-06 against `main` at
`95280b7b`. Nothing was deployed, migrated or changed.

## Current state

- **Production Worker:** version `6842b51c`, deployed 2026-09-16, `BUILD_SHA=3ca5b995`. `main`
  is 191 commits and 279 Worker/package files ahead.
- **Worker settings:** `AI_PROVIDER=opencode-go`, `OPENCODE_GO_LISTING_MODEL=deepseek-v4.1-flash`,
  `LISTING_PAID_OPERATIONS_ENABLED=true`, `PRODUCT_SHOT_PROVIDER=disabled`,
  `SHOPLINE_ADAPTER=disabled`, `SHOPLINE_PUBLISH_ENABLED=false`.
- **Production web (Vercel):** `main` at `95280b7b` since 2026-10-06. The deploy before #121 was
  `dpl_7qVNQ191tqXME3uT7rWmZ4ssA92d` (`dde9e178`).
- **Migration levels in code:** live Worker build up to `0040`; web before #121 up to `0048`;
  `main` up to `0053`.
- **Production database:** the 2026-10-02 to 2026-10-05 Opak runbooks record `0046` as **not
  applied**. `0046` is authorised (Codex as operator) but blocked on a backup/restore owner and a
  confirmed recoverable point. `0047`–`0053` are not authorised. See
  `opak-production-repair-proposal-2026-10-03.md`.
- **Prompt versions:** web and Worker both pin extraction `1.1.0` / generation `1.0.0` today, so
  they match. #132 moves them to `1.2.0` / `1.1.0`.
- **Production runtime logs:** no 5xx since the #121 merge, but no signed-in traffic either. The
  preview running the same code logged `schema_unavailable` on `/api/catalog` and
  `/api/listings`.

## Read-only checks run 2026-10-06

- **`runtime-doctor production --pre-deploy` with the live settings:** OK. Wrangler auth, 4
  queues, Hyperdrive id and required secrets all pass.
- **Render production config from `main` with the live settings and diff it against the live
  version:** provider, model, paid-operations, product-shot, S3 and SHOPLINE values are
  identical. Two new values: `TYPESAFE_VERIFICATION_MODE=off` and
  `WINE_ENRICHMENT_ENABLED=false`. Same queues, DLQs and Hyperdrive; cron `*/5 * * * *`.
- **`verify-cloudflare-secrets production`:** **FAIL**, `unexpected: OPENAI_API_KEY`. The deploy
  script will abort until this is resolved.
- **`wrangler deploy --dry-run` of `main`:** bundles to 3,258 KiB / 589 KiB gzip. Bindings match
  production.
- **Queue backlog:** `wrangler queues info` reports producers and consumers only. Read the backlog
  from the Cloudflare dashboard before step 3.

## Blockers (each needs its own approval)

- [ ] **B1 Database schema.** Name the backup/restore owner and confirm a recoverable point (Neon
      branch or PITR timestamp). Then apply `0046`–`0053` through the controlled migration job in
      `production-ai-runtime.md` ("Controlled migration and Opak seed"). `DATABASE_ADMIN_URL`
      exists only in that job. Authorisation for `0047`–`0053` is still needed.
- [ ] **B2 Obsolete secret.** Remove `OPENAI_API_KEY` from `wukong-runtime-production` as a
      separately approved secret operation. Keep secure access to the credential for rollback.
- [ ] **B3 Prompt-version pairing.** #132 must ship with a Worker deploy, not on its own.

## Release steps

1. [ ] B1 and B2 done, each approval recorded.
2. [ ] Signed-in smoke test of production web against the migrated database: catalog, a listing
       detail, the work queue. Expect no `schema_unavailable`.
3. [ ] Pause listing intake, or confirm the listing queue backlog is 0 and nothing is in flight.
4. [ ] From a clean checkout of `main`, export the live settings exactly as captured above (plus
       `CLOUDFLARE_HYPERDRIVE_ID`, `WEBSITE_FETCH_BASE_URL` and `BUILD_SHA=<main sha>`).
5. [ ] `pnpm turbo run build --filter='./packages/*'`, then
       `pnpm --filter @wukong/worker deploy:production`.
6. [ ] Post-deploy: `GET /health` reports the new build and `opencode-go`;
       `pnpm runtime:doctor production` (full) passes; DLQ count is unchanged.
7. [ ] One separately approved real processing cycle. Check factual output, source binding and
       reported cost.
8. [ ] Merge #132, then run step 5 again immediately. Vercel deploys the web app on merge, and
       until the Worker matches, new listing operations refuse with "Accepted prompt versions are
       unavailable".
9. [ ] Canary: signed-out routes, security headers, signed-in smoke test, runtime errors for 30
       minutes.
10. [ ] Resume intake.

## Rollback

- Worker: `wrangler rollback 6842b51c-95ce-4bdf-989d-36a645be8f59 --name wukong-runtime-production`.
  Only safe while the database is still compatible with build `3ca5b995`. Migrations are
  additive, and no down-migration is part of rollback.
- Web: Vercel instant rollback to the previous production deployment.
- Operations pinned to `1.2.0`/`1.1.0` after a rollback refuse and need a new retry once forward
  again.
- Keep queues, DLQs, R2 objects, ledgers and audits. No purge.
