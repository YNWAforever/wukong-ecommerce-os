# Attempt Evidence Packet Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development task-by-task with independent review. User approved implementation and the stacked worktree; do not reopen scope permission.

**Goal:** Download a truthful bounded review packet for one selected immutable comparison and its exact export.
**Architecture:** Single-statement snapshot repository, pure canonical packet builder, injected route service, separate bilingual preview/download panel.
**Tech Stack:** Existing pnpm11.7/Node24/TypeScript/Next/plainCSS/Drizzle/Postgres/Vitest/Playwright; no dependency or schema additions.

## Global constraints

- Full contract: docs/superpowers/specs/2026-09-05-attempt-evidence-packet-design.md. Base88c3b0b, branchcodex/attempt-evidence-packet.
- Synthetic only. No push, merge, deploy, production migration, real workbook, merchant seed, paid provider or real SHOPLINE write. Preserve old worktrees and runtime.
- Authenticated workspace and reviewer/admin/owner authority. Immutable selected comparison, no latest substitution. Reports remain unverified and unchanged.
- Single coherent read; maximum1,000receipt revisions,3MiB complete packet; explicit refusal, no truncation. Canonicalization sorted-json-v1, schemaVersion wukong-attempt-evidence-packet/v1. Preview snapshot hash excludes asOf only, payload hash includes it.

### Task 1: Snapshot and packet backend

Files: create packages/db/src/repositories/export-evidence.ts and integration tests; wire client.ts/index.ts. Create apps/web/lib/export-evidence-packet.ts + tests for canonical projection/hash, apps/web/lib/export-evidence-service.ts + tests for bindings/I/O, app/api/listings/export/[id]/evidence-packet/route.ts + tests. Existing import-results, export-attempts, export-verifications and asset digest helpers are authoritative; no mirrored mutable state.

- [ ] RED: synthetic exact selected comparison fixture with two products and receipt corrections; absent builder/route initially fails. Add mismatch, unreported, canonical hash and bound cases.
- [ ] Implement typed getSnapshot(attemptId,comparisonId) repository using one SQL statement (current snapshot asOf, attempt, exact comparison and complete relevant receipt revisions, overflow sentinel/count). Exclude unrelated receipt modes/members. Verify RLS and a concurrent receipt append cannot mix snapshot parts using explicit synthetic TEST_DATABASE_* pair. No migration.
- [ ] Implement pure buildExportEvidencePacket snapshot projection and canonical encoding; validate complete existing provenance plus comparison evidence consistency, deterministic member/receipt order, payload and snapshot hashes and final byte bound.
- [ ] Implement injected createExportEvidenceService with preview/download. GET summary and POST expectedSnapshotSha256 as design; check exact stored artifact bytes; safe errors; download audit only after all checks, no other writes. Route factories enforce role and workspace, UUID/body validation, attachment/no-store response.
- [ ] Focused commands: corepack.cmd pnpm@11.7.0 --filter @wukong/db build; --filter @wukong/web exec vitest run lib/export-evidence-packet.test.ts lib/export-evidence-service.test.ts 'app/api/listings/export/[id]/evidence-packet/route.test.ts'; --filter @wukong/web typecheck. Database integration uses root vitest config and local TEST_DATABASE_* only.
- [ ] Commit explicit paths and record exact wire types/errors/commands in ignored .superpowers/sdd/task9-backend-report.md. Independent spec/quality review before Task2.

### Task 2: Evidence preview and download UI

Files: create apps/web/components/export-evidence-packet-panel.tsx + tests; integrate into fresh-export-verification-panel.tsx for selected detail; scoped CSS as needed; extend tests/e2e/bulk-update-pilot.spec.ts and locale helper if necessary.

- [ ] RED: actual emitted preview query and POST comparison/hash identity; wrong comparison never downloads; selection change invalidates preview, late responses ignored, 409 asks refresh/review, failures retain recoverable selection, no double-submit.
- [ ] Implement typed bilingual summary and explicit download using Task1 wire. Show required evidence limits/disclosures and exact IDs. Keep role/ready controls correct and existing forms/retries untouched. Trigger Blob download from successful canonical response only, revoke object URL safely.
- [ ] Extend existing attended synthetic fixture: preview selected older comparison when newer exists, download/parse actual JSON, independently compute SHA256 and inspect exact IDs/receipt revisions; assert report/comparison counts unchanged and only expected download audit. Exercise stale preview and recovery where meaningful.
- [ ] Run focused component tests/typecheck, production build then full managed Playwright --project=chromium --workers=1 --retries=0 --reporter=line, bothlocales375/1440. Root supplies isolated local services/env.
- [ ] Commit explicit paths, ignored .superpowers/sdd/task9-ui-report.md. Independent review before final acceptance.

### Task 3: Final acceptance and local handoff

Files: CONTEXT.md, relevant pilot runbook, docs/superpowers/plans/2026-09-05-attempt-evidence-packet-results.md.

- [ ] Record exact current checks and limitations; reproduce and address review findings with targeted tests.
- [ ] Full unit/integration/type/lint/build/runtime checks and synthetic audit as applicable. Independent whole-range review against88c3b0b.
- [ ] Stop all task-owned services, retain ignored synthetic evidence, commit documentation and leave clean local branch for review. No publication.
