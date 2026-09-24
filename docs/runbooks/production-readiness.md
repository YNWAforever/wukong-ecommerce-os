# Production readiness and ownership

This checklist is a gate, not permission to provision or deploy. Every blank owner, secret, monitoring, or rollback decision blocks production enablement.

Every box below says who settles it. Six are settled by repository source and
are verified by `pnpm release-gate:check`; the other fourteen need a person,
and each says why. A green run of that command is **not** sign-off -- it proves
the repository is configured as described, and nothing about a deployment. The
human half is the gate.

## Services and secrets

- [ ] Neon runtime and admin roles are separate. `DATABASE_ADMIN_URL` exists only in the controlled migration job; the web and Worker never receive it. _[verified by `pnpm release-gate:check`]_
- [ ] The exact preview and production Cloudflare Workers, Queues, DLQs, cache-disabled Hyperdrive configurations, private R2 buckets, and owners match [`production-ai-runtime.md`](./production-ai-runtime.md). _[needs a person: owners and provisioned resource identities live outside the repo]_
- [ ] Queue retention, DLQ replay, backlog alert, oldest-message-age alert, Worker error alert, and Hyperdrive error alert owners are recorded. _[needs a person: alert ownership is a person, not a file]_
- [ ] R2 public access is disabled; bucket-scoped object credentials, CORS origins, lifecycle, backup, and restore owners are recorded. _[needs a person: bucket policy and restore ownership are set on the provider]_
- [ ] `QUEUE_INGRESS_SECRET`, `AUTH_SECRET`, connector-token encryption key, OpenAI key, SHOPLINE credentials, and mail credentials are held by the approved secret managers. Rotation owners and cadence are recorded without values. _[needs a person: secret custody and rotation cadence cannot be read from source]_
- [ ] Database backups, restore drill date, audit retention, deletion-request process, and incident contact are approved. _[needs a person: a drill is an event, and approval is a decision]_

## Release gate

- [ ] CI pins Node 24 and pnpm 11.7, performs a frozen install, proves the forbidden legacy runtime surface is absent, renders and validates Wrangler configuration, builds database dependencies, migrates Postgres, and runs lint, typecheck, unit, integration, build, and full Playwright. _[verified by `pnpm release-gate:check`]_
- [ ] Playwright uses production-built Next plus `wrangler dev`, local Cloudflare Queue simulation, local Hyperdrive-to-Postgres, MinIO, and Mailpit with fake AI/mock SHOPLINE only. _[verified by `pnpm release-gate:check`]_
- [ ] The exact synthetic Opak draft passes `audit:verify` with missing action count `0` and accessible foreign-record count `0`. _[verified by `pnpm release-gate:check`]_
- [ ] Preview and production resource IDs, deployed commit, Vercel deployment ID, Worker deployment ID, Queue/DLQ metrics, Hyperdrive name, and private R2 evidence are recorded without connection strings or credentials. _[needs a person: these exist only once something has been deployed]_
- [ ] Deployment-specific logs contain no credentials, signatures, database URLs, signed object query strings, prompts, model output, or customer content. _[needs a person: it is a claim about a running deployment, not about source]_
- [ ] No customer file, production credential, or unreviewed AI claim appears in Git history or fixtures. _[needs a person: an unreviewed AI claim is a judgement, and history needs a full scan]_

## SHOPLINE production gate

- [ ] Preview remains `SHOPLINE_ADAPTER=mock`. _[verified by `pnpm release-gate:check`]_
- [ ] Production acceptance remains `SHOPLINE_ADAPTER=disabled` and `SHOPLINE_PUBLISH_ENABLED=false`. _[verified by `pnpm release-gate:check`]_
- [ ] The production SHOPLINE API version, scopes, merchant approval, Developer Center ownership, hidden test-product owner, CSV fallback, and rollback/delete procedure are recorded. _[needs a person: merchant approval and Developer Center ownership are external]_
- [ ] A separate final confirmation is obtained immediately before enabling the first real SHOPLINE write. _[needs a person: this is the confirmation itself, and must stay a human act]_
- [ ] The first real write is limited to one approved hidden product and is reconciled to one Neon publish ledger and one safe remote product ID. _[needs a person: it describes an action taken against a live store]_

## Rollback

- [ ] Operators can disable SHOPLINE, pause both Cloudflare Queues, and independently roll back the Worker and Vercel. _[needs a person: it is a rehearsal against real consoles]_
- [ ] Rollback retains primary Queues, DLQs, private R2 objects, and Neon ledgers/audits; no purge or destructive migration reversal is part of the incident procedure. _[needs a person: it is a property of the incident procedure people follow]_
- [ ] DLQ replay is one reviewed IDs-only message at a time, acknowledges only after the primary Queue accepts it, and records the root cause plus ledger result. _[needs a person: it constrains how an operator behaves during an incident]_

After the gate is signed, deploy through the approved release pipeline. Resource provisioning, production secret changes, and the first real SHOPLINE write each require their own authorization.
