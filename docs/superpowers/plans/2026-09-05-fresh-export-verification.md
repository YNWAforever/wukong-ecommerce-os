# Fresh-export verification implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task with independent spec/quality review. User has approved the next-phase design; do not reopen development authorization.

**Goal:** Persist and display reproducible comparison evidence between an immutable delivered workbook and a later operator-attested snapshot.
**Architecture:** Pure normalized-grid comparator in packages/shopline; workspace-scoped append-only comparison repository with additive migration; thin GET/POST route service and a bilingual form/history in the existing reconciliation panel.
**Tech Stack:** Preserve pnpm 11.7.0, Node 24, existing Next/React/plain CSS, Drizzle/Postgres, Vitest/Playwright. No new dependencies.

## Global constraints

- Read docs/superpowers/specs/2026-09-05-fresh-export-verification-design.md as the complete contract.
- Base c409056d0c066b05908aa1275910e5157d6cd687; codex/catalog-fresh-export-verification worktree. Preserve prior worktrees and runtime.
- Real SHOPLINE writes disabled, fake AI/mock SHOPLINE, synthetic local services only. No push/PR/deploy/production migration/merchant workbook or paid provider use.
- Workspace identity comes from the authenticated session and all database access uses forWorkspace. Server role and provenance checks stay authoritative.
- Comparisons never change approvals, source imports, current drafts, operator reports or publish status. Merchant origin/time remain attested; compare results are not independent live SHOPLINE acceptance.

### Task 1: Comparison backend and durable evidence

Files: create packages/shopline/src/fresh-export-comparison.ts and tests, export via index; create packages/db/drizzle/0018_export_verifications.sql and repositories/export-verifications.ts + tests, wire schema/client/index; create apps/web/lib/fresh-export-verification.ts and tests and app/api/listings/export/[id]/verifications/route.ts + tests. Reuse validateExportResultBinding, artifactHash and existing parser/key functions.

- [x] Write failing behavioral comparator and service/route cases from the design.
- [x] Implement exact-identity comparison with meaningful missing/ambiguous/variant/delta outcomes and input bounds.
- [x] Add append-only tenant-scoped persistence with deterministic idempotent ensure and paged history; commit/audit together.
- [x] Prove RLS/FKs, idempotent identity, immutability and fresh/upgrade/replay in explicitly isolated databases.
- [x] Publish a typed browser wire contract in the report; expose GET/POST on the same verifications route. GET returns items + total/page/pageSize; POST returns the recorded comparison plus replay indication. Use safe errors, no raw reader/database detail.
- [x] Run focused tests/typecheck/format and independent spec/quality review before UI integration.

### Task 2: Bilingual comparison form and history

Files: new apps/web/components/fresh-export-verification-panel.tsx + tests; integrate in export-reconciliation-panel.tsx; extend tests/e2e/bulk-update-pilot.spec.ts (or focused new journey using shared synthetic fixtures). Follow Task 1's typed wire contract exactly.

- [x] Write failures for form's real emitted URL/body/time/attestation and role visibility, validation/retry and history rendering.
- [x] Render comparison counts, exact product bindings, differences, separate delta observations, bounded history and truthful operator-attested scope in en/zh-Hant.
- [x] Preserve existing reconciliation retry identity and avoid nested forms/stale async overwrites.
- [x] Run full synthetic managed-server browser journey from empty artifact storage, independent review, then combined checks appropriate to changed packages.

### Task 3: Final acceptance and local handoff

- [x] Update CONTEXT and verification/runbook notes with exact candidate checks and unapplied migration boundary.
- [x] Independent whole-range review, address all actionable findings and rerun affected checks.
- [x] Stop all task-owned services, retain synthetic evidence outside tracked files, commit explicit paths and leave branch local for review.
