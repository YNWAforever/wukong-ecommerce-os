# Opak UAT Rollout Runbook — Design

**Date:** 2026-09-03
**Status:** Approved (brainstorming), pending implementation plan
**Origin:** Package K of `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — "Controlled Opak UAT and staged rollout." Per that plan, Package K is a process deliverable, not code (`Files: none (process, not code) beyond whatever fixes UAT itself surfaces`). This session already executed the "whatever fixes UAT itself surfaces" half (the multi-product export no-op-row-leak fix, PR #65) as its own scoped PR, per explicit user decision. This design covers the remaining half: the runbook itself.

## 1. What this produces

A new runbook, `docs/runbooks/opak-uat-rollout.md`, governing the four-stage UAT sequence from the master plan's §11/§18: Stage 1 (1–5 products, attended) → Stage 2 (30–50, golden set) → Stage 3 (50–100, 2-week shadow pilot) → Stage 4 (full catalog). This is the actual "outcome" Package K exists to produce — a document Opak and the Wukong operator can follow to advance through the sequence, with real go/no-go gates instead of the master plan's own now-stale table.

## 2. Scope boundary against the two existing runbooks

`docs/runbooks/` already has two related runbooks; this one must not duplicate either:

- **`shopline-pilot-onboarding.md`** owns the mechanics: Developer Center setup, merchant enablement, importing/enriching/exporting a catalog, bulk-approve, admin area, re-delivery via API. The new runbook references these by section number rather than re-explaining them.
- **`production-readiness.md`** owns infrastructure-level gating and rollback: `SHOPLINE_PUBLISH_ENABLED`, Worker/Vercel rollback, DLQ replay, secret ownership. The new runbook's rollback section (§6 below) is a _different, narrower_ concept — restoring a specific SHOPLINE product's prior content via a retained source file — and must say so explicitly to avoid the two "rollback" sections being confused.

The new runbook owns: the stage sequence itself, the go/no-go gate table, the rollback-source-file procedure, and the sign-off template. It is explicitly a living document — its gate table reflects the state of the code at time of writing and must be re-verified against live code before each stage's actual go/no-go decision, not trusted as permanently accurate.

## 3. Current readiness snapshot (as verified live against the repo on 2026-09-03)

Sourced from this session's own direct code reads, not carried over from the master plan's stale §18 table. Each row cites exactly what was checked.

| Gate                                                                                        | Status                     | Evidence                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sheet-name fix (`"Sheet1"` → `"Default"`)                                                   | **Closed**, on `main`      | `packages/shopline/src/bulk-form-xlsx.ts:345`, `WORKBOOK_XML` declares `name="Default"`                                                                                                                        |
| Variant-ID hard block                                                                       | **Closed**, on `main`      | `packages/shopline/src/bulk-form.ts:627`, `severity: "error"`, row dropped                                                                                                                                     |
| Freshness gate (content/evidence/source-digest checks before approval and before export)    | **Closed**, on `main`      | `packages/core/src/content-freshness.ts`, `assert-approval-freshness.ts`, `assert-export-freshness.ts`; wired into `apps/web/app/api/listings/[id]/approve/route.ts` and `apps/web/lib/bulk-export-service.ts` |
| Eight-field confirmation ledger                                                             | **Closed**, on `main`      | `packages/db/src/repositories/review-confirmations.ts`, `apps/web/components/confirmation-checklist.tsx`, `apps/web/lib/review-confirmation-keys.ts`'s `allConfirmed()`                                        |
| CSRF/secure-cookie config                                                                   | **Closed**, on `main`      | `apps/web/auth.ts:101-110`, cross-checked against installed `better-auth@1.5.5` source                                                                                                                         |
| Batch wave-size cap, server-enforced                                                        | **Closed**, on `main`      | `packages/db/src/repositories/enrichment-batches.ts`'s `claimWave` — no client-reachable override path                                                                                                         |
| `/listings/new` wiring                                                                      | **Closed**, on `main`      | `apps/web/app/(app)/listings/new/page.tsx` → `ListingIntakeClient` → real presign/upload/finalize/create flow                                                                                                  |
| SHOPLINE write gating (preview mock, production disabled)                                   | **Closed**, on `main`      | `scripts/render-cloudflare-config.mjs:82-83`, immune to env override, proven by `tests/cloudflare-config.test.mjs`                                                                                             |
| Multi-product export: no-op row leak fixed                                                  | **Closed, pending merge**  | PR [#65](https://github.com/YNWAforever/wukong-ecommerce-os/pull/65), commit `5e5ef7b`                                                                                                                         |
| Multi-product export: reparse-and-assert self-check                                         | **Closed, pending merge**  | PR #65, commits `f9577ea` → `c15d6a4`                                                                                                                                                                          |
| Multi-product export: mixed-store rejection                                                 | **Closed, pending merge**  | PR #65, commit `083899c`                                                                                                                                                                                       |
| Package J accessibility/security/observability hardening                                    | **Closed, pending merge**  | PR [#64](https://github.com/YNWAforever/wukong-ecommerce-os/pull/64)                                                                                                                                           |
| `/jobs` reconciliation (recording what SHOPLINE actually accepted after a manual re-import) | **Open**                   | no `POST /api/listings/[id]/shopline-import-result` route exists (confirmed via repo-wide search); see §5                                                                                                      |
| Tested rollback-source-file procedure                                                       | **Closed by this runbook** | this document's §6 is the procedure                                                                                                                                                                            |
| `audit:verify` run as a stage-level gate (not just per-draft)                               | **Partially closed**       | CLI exists and is tested (`packages/db/src/cli/audit-verify.ts`), but nothing currently runs it across a whole UAT stage — this runbook's sign-off template (§7) requires it explicitly                        |

**PR merge-order note, worth stating plainly in the runbook:** PR #64 and PR #65 both modify `apps/web/app/api/listings/export/route.test.ts`, but a real three-way merge simulation (`git merge-tree`) confirms zero conflicts — they touch disjoint line ranges and merge cleanly regardless of order. Both must land on `main` before Stage 1 begins (Package K depends on Package J per the master plan's dependency graph: `{C,D,E,F,G,H,I} → J → K`), but no coordination is needed beyond "merge both."

## 4. Stage sequence

Each stage's entry gate is a subset of §3's table plus the previous stage's exit criteria; no stage introduces a _new_ code gate beyond what's already listed.

- **Stage 1 — Attended contract UAT (1–5 products).** Entry: sheet-name fix, Variant-ID block, freshness gate, eight-field ledger, and the rollback procedure (§6 below) are all Closed. Exit: a manually-triggered SHOPLINE re-import of a Wukong-generated file succeeds for all 1–5 products, with zero identifier coercion and zero unintended field changes (verified by diffing the re-imported product against the intended eight-field change set). This stage does not require the multi-product export fixes (PR #65) or Package J (PR #64) _by content_ — Stage 1 is single-product export territory — but both must still be merged first per the dependency graph.
- **Stage 2 — Golden set (30–50 products).** Entry: Stage 1 signed off; still single-row or small-batch delivery, same gates as Stage 1. Exit: 100% header/workbook acceptance and 100% intended-row import success across the set, with any partial success explicitly reconciled by hand (no `/jobs` endpoint yet — see §5's Stage 1–2 workaround).
- **Stage 3 — Shadow pilot (50–100 products, 2 weeks, manual import only).** Entry: Stage 2 signed off; multi-product export (PR #65's three fixes) merged and live; **`/jobs` reconciliation endpoint built and live** (§5 — this is the one gate this stage adds beyond Stage 2's). Exit: two weeks of manual-import cycles with `/jobs` showing clean reconciliation (no unresolved partial-import records) and zero locked/pass-through-field regressions.
- **Stage 4 — Catalog-scale rollout (full catalog).** Entry: written Opak sign-off after Stage 3, all of Packages A–J complete and merged. Exit: N/A — this is the terminal state; ongoing operation follows `shopline-pilot-onboarding.md` from here.

## 5. `/jobs` reconciliation — documented gap, not built now

Per the user's explicit choice: this runbook documents the gap and gates Stage 3 on it, rather than building the endpoint now.

- **What's missing:** a `POST /api/listings/[id]/shopline-import-result` route (or equivalent) that records what SHOPLINE actually accepted after an operator manually re-imports a Wukong-generated file — today nothing closes that loop programmatically.
- **Stage 1–2 workaround (manual):** the runbook specifies a plain manual log (a shared sheet or the pilot change log already referenced by `shopline-pilot-onboarding.md`'s header) recording, per import: file digest, product IDs included, SHOPLINE's reported accept/reject count, and any rejected row's reason. This is sufficient at 1–50 products; it is explicitly called out as not sufficient at Stage 3's 50–100-product, 2-week cadence.
- **Stage 3 requirement:** before Stage 3 begins, a small follow-up PR must build the missing endpoint (and a minimal `/jobs` UI surface for it, reusing the existing jobs-ledger patterns from Package I). This runbook does not design that PR — it only states the requirement and points at the master plan's §10/§16 Package I section for the original design intent.

## 6. Rollback-source-file procedure

This is new operational content this runbook owns — distinct from `production-readiness.md`'s infrastructure rollback (disabling SHOPLINE, pausing Queues, rolling back Worker/Vercel deploys), which stays out of scope here.

The procedure, in outline (full command-level detail goes in the runbook itself, not this design doc):

1. **Before every write** (single-row or multi-product), retain the exact bulk-form export file used — the bytes returned by `/api/listings/<id>/deliver` (`method: "bulk_form"`) or `/api/listings/export`, not a re-generated copy. Name it deterministically (e.g. `<date>-<stage>-<digest-prefix>.xlsx`) and store it in the pilot's shared evidence location alongside the change log `shopline-pilot-onboarding.md` already references.
2. **Verify the retained file round-trips** before relying on it as a rollback source: run `pnpm --filter @wukong/shopline bulk-form:profile <file>` against it and confirm the aggregate counts match what was actually delivered (this reuses the existing profiling command from `shopline-pilot-onboarding.md`'s §4, applied here to a delivered-not-imported file — the design must state explicitly that this is the same tool used for a different purpose, not a new tool).
3. **To roll back a specific write:** locate the immediately-prior retained export for the affected product(s) — the last file whose content differs from the one that caused the problem — and manually re-import _that_ file into SHOPLINE via the merchant admin, following the same "do not open in Excel first" caution as normal imports (`shopline-pilot-onboarding.md` §4, step 2). This restores the prior column values for every column in the file, not just the eight enrichable ones — the runbook must warn that this is a blunt instrument (whole-row restore) and should only be used when the alternative is worse.
4. **This is consistent with ADR-12:** rollback means stop the pipeline and manually correct via a separate authorized action; it is not automatic reversal. The runbook states this procedure is exactly that "separate authorized action" for the specific case of a bad bulk-form write, and requires the same written-approval discipline `shopline-pilot-onboarding.md` §3 already requires for a hidden test product.

## 7. Sign-off template

For each stage boundary, the runbook specifies a written record (not a new tool — a markdown/text template operators fill in) capturing:

- Stage number, product count, date range.
- Exit criteria from §4, each explicitly checked off with evidence (a screenshot, a `/jobs` or manual-log export, an `audit:verify` run's output).
- `pnpm --filter @wukong/db audit:verify` run against the stage's actual drafts, with its reported missing-action and accessible-foreign-record counts (must be `0`/`0` — this is the "run it as a stage-level gate" requirement flagged as Partially Closed in §3).
- Opak's named approver and explicit written approval to advance (or not) to the next stage.
- Any defect found during the stage, whether it was fixed inline (small follow-up PR, same pattern as PR #65) or deferred, and to where.

## 8. Explicitly out of scope

- Building the `/jobs` reconciliation endpoint itself (§5) — flagged as a Stage-3 blocker, not built by this runbook.
- Any change to `production-readiness.md` or `shopline-pilot-onboarding.md` — this is a new, additive document only.
- Actually executing any UAT stage — that requires real Opak data, real SHOPLINE writes, and calendar time; this runbook is the process specification those executions will follow, not a substitute for running them.

## 9. Self-review

- **Placeholder scan:** none — §3's table, §4's stage gates, §5's workaround, and §6's procedure steps are all concrete, not TBD.
- **Internal consistency:** §3's PR-pending items are consistently referenced in §4's Stage 1 entry note (both PRs must merge regardless of stage-specific content need, since K depends on J per the dependency graph).
- **Scope check:** appropriately sized for one implementation plan — one new document, cross-referencing two existing ones without modifying them.
- **Ambiguity check:** the two points with more than one reasonable resolution (how to handle the `/jobs` gap and the rollback procedure) were both resolved explicitly with the user before this document was written.
