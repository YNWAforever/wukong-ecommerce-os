# T20 workspace configuration and usage

The administrator settings page now edits workspace name, brand voice, content guidance, required fact fields and public-source domain restrictions. Existing image-background settings use the same locked partial-update repository method so one settings form cannot overwrite another's changes.

`GET/PATCH /api/workspace/policies` derives actor, role and tenant from the session. Only administrators can read/change these settings. The PATCH schema is strict and cannot set credentials or paid-provider activation. A digest of the observed profile provides compare-and-swap protection; conflicts preserve the user's unsaved form and offer reload. Server audit records identify changed field names without copying credentials.

Approval checks the current workspace's required facts before confirmation or status mutation. Numeric zero is a valid entered value. Unknown configured field keys fail closed. A second workspace has independent configuration and cannot read another workspace's usage.

Usage distinguishes settled cost, active reservations and unknown-outcome holds, with physical request counts. Admission information is read-only and only reports configured readiness when the global flag, provider, reviewed model/pricing policy and positive spend bounds agree. It is application admission accounting, not a provider billing guarantee.

## Local checks

- `workspace-policy.test.ts`: field policy and safe configuration schema.
- `workspace-policy.integration.test.ts`: tenant isolation, conflict detection and preservation of unrelated image settings.
- Workspace policy route tests: administrator-only access, validation, safe exposure and update conflicts.
- Workspace policy component tests: failed/conflicting save preserves local edits.
- Approval and legacy settings regression suites included in combined verification.

The full typecheck passed across 14 tasks after integration. Final suite totals are recorded in the consolidated delivery evidence. Native settings screenshots, deployed readiness and merchant onboarding remain separate from these code/DB checks.
