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

After the gate is signed, deploy through the existing release pipeline. Do not create a database, bucket, Redis instance, SMTP account, or secret from this checklist.
