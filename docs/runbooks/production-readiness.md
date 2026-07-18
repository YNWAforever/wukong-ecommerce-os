# Production readiness and ownership

This checklist is a gate, not a provisioning script. Every blank owner, secret, or rollback decision blocks production enablement.

## Services and secrets

- [ ] Neon pooled `DATABASE_URL` is used by web/worker; direct `DATABASE_ADMIN_URL` is restricted to migrations and migrations run from a controlled job.
- [ ] Redis URL and queue retention/alert owner are recorded.
- [ ] Object storage bucket, region, endpoint, private read URL policy, lifecycle, and backup owner are recorded.
- [ ] SMTP host/port/from address and mail delivery owner are recorded; magic-link tokens never enter logs.
- [ ] `AUTH_SECRET`, encryption key for connector tokens, OpenAI API key, SHOPLINE credentials, and Sentry endpoint are held by the approved secret manager. Record rotation owner and cadence, not secret values.
- [ ] Database backups, restore drill date, audit retention, deletion request process, and incident contact are approved.

## Release gate

- [ ] CI passes frozen pnpm install, migrations, lint, typecheck, unit/integration tests, build, and Playwright with fake AI/mock SHOPLINE only.
- [ ] A synthetic Opak run passes `audit:verify`; the cross-tenant probe reports zero accessible foreign records.
- [ ] The production SHOPLINE API version and scopes are recorded. Merchant enablement and Developer Center app ownership are separate approvals.
- [ ] A hidden test product has explicit owner approval before the first write. CSV fallback and rollback/deletion instructions are tested.
- [ ] No customer file, production credential, or unreviewed AI claim appears in Git history or fixtures.

## Production AI runtime gate

Follow [`production-ai-runtime.md`](./production-ai-runtime.md) for the exact provider ownership, resource names, CORS policy, deployment order, verification, and rollback procedure.

- [ ] Current Upstash, Railway, and R2 prices are rechecked before provisioning; any material increase has explicit approval.
- [ ] Vercel has only the AI-runtime additions allowlist, while Railway has only its worker allowlist and no auth-mail, admin-database, or SHOPLINE secret.
- [ ] The controlled release environment alone holds `DATABASE_ADMIN_URL`; the additive migration succeeds once before the new Railway worker starts.
- [ ] Vercel and Railway deploy the same accepted commit. The private portless worker has no public domain, healthcheck path, or startup migration.
- [ ] Deployment-specific Vercel/Railway logs, Neon state, one BullMQ job, and private R2 objects prove the synthetic workflow without exposing secrets or source content.
- [ ] Rollback owners can independently roll back Vercel and roll back or stop Railway while retaining Redis, Neon records, and the R2 bucket.

After the gate is signed, deploy through the existing release pipeline. Do not create a database, bucket, Redis instance, SMTP account, or secret from this checklist.
