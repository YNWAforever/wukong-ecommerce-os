# Production readiness and ownership

This checklist is a gate, not permission to provision or deploy. Every blank owner, secret, monitoring, or rollback decision blocks production enablement.

## Services and secrets

- [ ] Neon runtime and admin roles are separate. `DATABASE_ADMIN_URL` exists only in the controlled migration job; the web and Worker never receive it.
- [ ] The exact preview and production Cloudflare Workers, Queues, DLQs, cache-disabled Hyperdrive configurations, private R2 buckets, and owners match [`production-ai-runtime.md`](./production-ai-runtime.md).
- [ ] Queue retention, DLQ replay, backlog alert, oldest-message-age alert, Worker error alert, and Hyperdrive error alert owners are recorded.
- [ ] R2 public access is disabled; bucket-scoped object credentials, CORS origins, lifecycle, backup, and restore owners are recorded.
- [ ] `QUEUE_INGRESS_SECRET`, `AUTH_SECRET`, connector-token encryption key, OpenAI key, SHOPLINE credentials, and mail credentials are held by the approved secret managers. Rotation owners and cadence are recorded without values.
- [ ] Database backups, restore drill date, audit retention, deletion-request process, and incident contact are approved.

## Release gate

- [ ] CI pins Node 24 and pnpm 11.7, performs a frozen install, proves the forbidden legacy runtime surface is absent, renders and validates Wrangler configuration, builds database dependencies, migrates Postgres, and runs lint, typecheck, unit, integration, build, and full Playwright.
- [ ] Playwright uses production-built Next plus `wrangler dev`, local Cloudflare Queue simulation, local Hyperdrive-to-Postgres, MinIO, and Mailpit with fake AI/mock SHOPLINE only.
- [ ] The exact synthetic Opak draft passes `audit:verify` with missing action count `0` and accessible foreign-record count `0`.
- [ ] Preview and production resource IDs, deployed commit, Vercel deployment ID, Worker deployment ID, Queue/DLQ metrics, Hyperdrive name, and private R2 evidence are recorded without connection strings or credentials.
- [ ] Deployment-specific logs contain no credentials, signatures, database URLs, signed object query strings, prompts, model output, or customer content.
- [ ] No customer file, production credential, or unreviewed AI claim appears in Git history or fixtures.

## SHOPLINE production gate

- [ ] Preview remains `SHOPLINE_ADAPTER=mock`.
- [ ] Production acceptance remains `SHOPLINE_ADAPTER=disabled` and `SHOPLINE_PUBLISH_ENABLED=false`.
- [ ] The production SHOPLINE API version, scopes, merchant approval, Developer Center ownership, hidden test-product owner, CSV fallback, and rollback/delete procedure are recorded.
- [ ] A separate final confirmation is obtained immediately before enabling the first real SHOPLINE write.
- [ ] The first real write is limited to one approved hidden product and is reconciled to one Neon publish ledger and one safe remote product ID.

## Rollback

- [ ] Operators can disable SHOPLINE, pause both Cloudflare Queues, and independently roll back the Worker and Vercel.
- [ ] Rollback retains primary Queues, DLQs, private R2 objects, and Neon ledgers/audits; no purge or destructive migration reversal is part of the incident procedure.
- [ ] DLQ replay is one reviewed IDs-only message at a time, acknowledges only after the primary Queue accepts it, and records the root cause plus ledger result.

After the gate is signed, deploy through the approved release pipeline. Resource provisioning, production secret changes, and the first real SHOPLINE write each require their own authorization.
