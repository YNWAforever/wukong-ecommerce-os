# Isolated staging Resend test mode — 2026-10-02

This is source/local safety verification and branch configuration, not SMTP delivery, cloud Web UAT or merchant acceptance. The user selected Resend within the existing isolated synthetic staging authorization; no real recipient or production change is authorized by this phase.

## Behavior and configuration

The existing Nodemailer adapter remains. Only the dedicated Preview branch has AUTH_EMAIL_DELIVERY_MODE=resend-test. With that explicit mode, the mailer requires the platform VERCEL_ENV=preview, rejects other/unknown configured modes before transport, and allows only delivered/bounced/complained simulator addresses with optional ASCII labels, or suppressed without a label, on resend.dev. Display names, extra recipients, deceptive domains, unsupported labels and line terminators are rejected before creating a transport. The default unset mode preserves existing production, ordinary Preview and local capture behavior.

Test mode requires a parseable smtp/smtps URL and rejects every query/hash option. Nodemailer URL options can enable content logging, alter TLS or select a service preset. Do not configure logger/debug/ignoreTLS/rejectUnauthorized/service options. No SMTP URL, key, recipient, auth link or email content is included in application delivery metadata.

| Field                    | Isolated staging value/source                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Scope                    | Vercel Preview; branch codex/opak-isolated-staging-20261002 only                                                   |
| AUTH_EMAIL_DELIVERY_MODE | resend-test; nonsecret, added only to this branch                                                                  |
| AUTH_EMAIL_FROM          | Wukong Staging with onboarding@resend.dev; nonsecret branch sender                                                 |
| AUTH_SMTP_URL            | Sensitive; user supplies a distinct staging Sending access key via the provider dashboard; no secret recovery/pull |
| SMTP components          | SMTPS; smtp.resend.com;465; username resend; password is the staging API key, URL-encoded where needed             |
| VERCEL_ENV               | Platform-provided; never set by hand to defeat the placement check                                                 |
| BETTER_AUTH_URL          | Explicit intended isolated alias; assignment and deployed origin verification still pending                        |

Resend is a delivery service with event simulators, not a catch-only mailbox. Its test emails count against sending quota. Use only the official simulator recipients and stay within existing quota/budget; no account upgrade, real-recipient delivery or quota acceptance is claimed. The existing .invalid password actors can continue password-only UAT, but their email requests deliberately fail the simulator recipient guard. A separately seeded labelled simulator actor would be needed for a bounded SMTP test; no merchant account or existing fixture is silently retargeted.

## Findings and regression evidence

1. Initial existing mailer accepted nine non-test recipients and a pending/malformed Preview SMTP value through a fake transport: RED10 failed/13 passed. Initial host-based correction passed23, then address-boundary coverage passed26.
2. Independent review reproduced the host inference bypass: trailing DNS dot, percent-encoded host, Unicode dot variants and Nodemailer service preset could route to Resend while skipping its recipient guard. Explicit mode, placement/default behavior and unsafe option tests reproduced14 failures before correction.
3. Corrected service-level fake-transport tests passed40/40. No remaining actionable finding in the independent final review. The source guard is independent of hostname inference and rejects unsafe URL options. No actual mail was sent.
4. Final Web units passed2274/2274 across230 files. Root Node contracts passed143, skipped2, failed0 across145 cases. Web typecheck passed. Final build and exact new-head CI are recorded separately in the fix-status ledger; old b115 CI green is dated source evidence, not a pass for this change.

Commands: pnpm --filter @wukong/web exec vitest run lib/auth-mailer.test.ts; pnpm --filter @wukong/web test; node --test tests/*.test.mjs; pnpm --filter @wukong/web typecheck; pnpm --filter @wukong/web build. All logs, retained failing attempts and private configuration are outside Git.

Normal Vercel readback reports36 branch fields, including the updated sender and new mode. SMTP createdAt/updatedAt remains unchanged despite the earlier user update claim. Provider identity is now Resend; the Sensitive field Save, actual authentication, sender acceptance, quota, deployed flag and SMTP behavior remain unverified. Existing R2/SMTP secrets were not read or replaced. Shared production/Preview settings were not changed.

## Deployment, stop and rollback

Use the newly reviewed guard-compatible Web source with branch-only runtime values; do not deploy the old6d8 candidate with the new mode, because old code ignores it. Explicitly verify effective AUTH_EMAIL_DELIVERY_MODE=resend-test and platform Preview placement in the actual candidate before any email test. A provider name or field timestamp does not establish SMTP behavior.

Web remains undeployed and its intended alias unassigned. Worker remains held, new staging compute disabled/idle; Queue/R2/Web-to-Worker/authenticated UAT/scoped audit are separate gates. No production500 root cause is asserted.

There is no migration. Rollback stops new admission and staging compute/consumers/cron/ingress while retaining data, sources, versions, reservations, artifacts, receipts, audit and DLQs. Preserve the test-mode field and use only a guard-compatible Web version with a compatible reviewed Worker. Removing the mode or reverting to a version that ignores it is not a safe SMTP rollback. Do not purge evidence, perform destructive down migrations or restore unsafe roles/cache.

Primary references: [Resend SMTP](https://resend.com/docs/send-with-smtp), [Resend simulators and quota](https://resend.com/docs/dashboard/emails/send-test-emails), [Nodemailer service and logging options](https://nodemailer.com/smtp).
