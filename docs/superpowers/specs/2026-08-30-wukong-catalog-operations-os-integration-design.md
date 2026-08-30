# Wukong Catalog Operations OS Integration — Audit & Plan-Writing Design

**Date:** 2026-08-30
**Status:** Approved (brainstorming), pending implementation plan

## 1. What this document is (and isn't)

This is a design for **how Claude will produce one deliverable**, not the deliverable itself. The deliverable's exact required content, structure, and boundaries are fully specified by an external master instruction the user supplied:

> `C:\Users\laich\Downloads\Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md`

That file is outside this repository and is not to be copied into it. It requires producing a single, self-contained, evidence-backed Markdown implementation plan at:

> `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`

covering 22 mandated sections (executive verdict, evidence register, current-state architecture, Site inventory, route/function parity matrix, reuse/anti-rewrite matrix, gaps/contradictions, target IA, proposed ADRs, data/API/RLS/audit contracts, the Opak 71-column Bulk Update contract, auth/i18n/accessibility/security plans, file-level PR sequence, test strategy, rollout/UAT/go-no-go, risks/decisions/stop-conditions, recommended first PR, decisions required, and an implementation-readiness checklist), while remaining strictly planning-only: no application, infrastructure, dependency, or database writes; no branches, commits (beyond the two Markdown files named above), PRs, or deployments; no production SHOPLINE writes.

This document exists because that target is too large and too easy to get subtly wrong (contradicting itself across 22 sections, or silently dropping evidence) to execute as one unbroken pass. It describes the **process** — research fan-out, then single-author synthesis — that will produce it correctly.

## 2. Evidence baseline already established (do not re-derive)

- **Repository:** `https://github.com/YNWAforever/wukong-ecommerce-os`, local branch `main`, fast-forwarded from `1ec8600` to `765c616` ("Add files via upload", 2026-08-30) to match `origin/main`. This is one commit past the master instruction's audited SHA `aac65e5429b86ae308c13a655210295ae7e4f05a` (PR #49, merged). Working tree is clean of tracked-file conflicts; ~30 untracked scratch files (`task5-*.patch`, `task6-*.ts`, `task7-*.ts`) remain at repo root from an earlier, unrelated agent session — they predate the current runtime and are not part of any package; they are to be left alone (untracked, harmless) unless they become relevant evidence during research, in which case treat them as historical/superseded rather than current runtime.
- **Opak workbook:** user-supplied file `C:\Users\laich\Downloads\opakcellar-BulkUpdateForm-2026-05-21-15-50_0.xlsx`.
  - SHA-256: `1475aa85e7bb400ed5ce16dbdfff93219413cc5403202903f8c5c670ce83c6f1`
  - Size: 181,907 bytes
  - Sheet: `Default` (single sheet, no `sharedStrings.xml` — all text cells are `t="inlineStr"`)
  - Dimension: `A1:BS502` → 71 columns (A–BS) × 502 rows → 2 header rows (English row 1, Traditional Chinese row 2) + 500 data rows
  - Header row 1/2 text fully extracted and matches the 71 field names named in the master instruction (`Product ID (DO NOT EDIT)` … `SL_KEY1(DO NOT EDIT)`)
  - First data row confirms: SKU stored as string with leading zero preserved (`0013`), delta column carries literal `+0` string, multi-path category stored as `Red Wine>Italy>Sicily` in one cell, numeric price/cost cells typed `t="n"`.
  - **Reconciliation note for the plan:** the master instruction worried the runtime's XLSX writer using inline strings might not match a genuine SHOPLINE export. This real reference export _also_ uses inline strings with no shared-strings table — so "inline strings" alone is not the risk signal. The actual risk to re-examine is the runtime rebuilding a bare `Sheet1` (wrong sheet name/minimal structure) rather than string-encoding choice. State this precisely in the contradiction-reconciliation section rather than repeating the original framing verbatim.
  - This workbook file itself must never be committed, copied into the repo, or included in any code/config generated as part of this task.

## 3. Research fan-out

Dispatch the following as parallel, read-only subagents (Explore or general-purpose type, no Edit/Write access). Each must return findings as evidence citations only — `path:line-range` + symbol for code, `route, locale, viewport, UTC time` for Site pages, `sheet/cell` for workbook — not unsourced conclusions. Wait for all seven before synthesizing anything.

1. **Auth & workspace identity** — `apps/web/components/auth-form.tsx`, `apps/web/lib/session-context.ts`, Better Auth config/routes, invite/reset/magic-link flows, role order (`viewer < operator < reviewer < admin < owner`), bootstrap-owner semantics, RLS entry via `db.forWorkspace(...)`.
2. **Dashboard / Catalog / Admin** — `apps/web/components/catalog-control-center.tsx`, `apps/web/components/admin-tabs.tsx`, dashboard page(s), `packages/db/src/repositories/platform-products.ts`, catalog read API, existing pagination/search/cohort behavior.
3. **Listing review/approval workflow** — `apps/web/components/listing-review-client.tsx`, `listing-fields-form.tsx`, `evidence-panel.tsx`, `delivery-panel.tsx`, `apps/web/lib/listing-approval.ts`, `packages/core/src/workflow.ts`, immutable-version and stale-edit protection, audit events.
4. **Opak Bulk Update contract code** — `packages/shopline/src/bulk-form.ts`, `bulk-form-xlsx.ts`, `bulk-form-source.ts`, `bulk-form-digest.ts`, `csv.ts`, `delivery-policy.ts`, `apps/worker/src/listing-pipeline.ts`, `publish-product.ts`, `packages/core/src/listing-schema.ts`, `packages/db/src/schema.ts` / `client.ts`. Cross-check every field against the 71-column workbook header list from §2.
5. **Docs, CI, tests** — `CLAUDE.md`, `CONTEXT.md`, `docs/product/*`, `docs/runbooks/*`, all dated files under `docs/superpowers/specs/` and `docs/superpowers/plans/` (there are several beyond the 2026-07-12 MVP plan — a real architecture history exists there), `.github/workflows/ci.yml`, root/package `package.json` scripts, existing Vitest/Playwright suites relevant to the above.
6. **Site code structure** — clone `https://github.com/YNWAforever/wukonggpt` read-only into the session scratchpad (never into this repo), map every route, component, mock/sample data source, and any place the Site labels itself an unconnected prototype.
7. **Live Site crawl** — `https://wukong-catalog-ops.laichiwillyjp.chatgpt.site`, every reachable route, in Traditional Chinese and English, at desktop and 375px widths; capture normal/loading/empty/error/disabled/stale/forbidden/success states where reachable; note design tokens (colors, radius, type) against the spec's starting hypothesis in its §7.

## 4. Synthesis (single author)

After all seven reports return, I reconcile them personally rather than concatenating subagent output:

- Build the route/function parity matrix first (one row per Site route and per runtime route, per the master instruction's required columns) — this is the spine the rest of the document hangs off.
- Label every material statement **Observed**, **Inferred**, **Proposed**, or **Unverified** per the source hierarchy in the master instruction (code/tests > workbook/business rules > Site > external docs > older specs).
- Explicitly reconcile the five named conflicts in the master instruction (auth prototype-vs-real, missing `/batches` `/queue` `/jobs` `/quality` `/system-map` `/pilot`, batch-export-vs-single-export, freshness-gate depth, eight-field review breadth) plus the inline-string reconciliation from §2.
- Draft ADRs, contracts, PR sequence, and the rest of the 22 sections in the mandated order.
- Run the master instruction's own §19 quality gates and §20 stop conditions as a literal checklist before calling the deliverable done.

## 5. Guardrails

- No application/infra/dependency/migration writes at any point.
- No git branch, commit (beyond the two Markdown files named in this document), PR, or deployment.
- No production SHOPLINE calls; adapters stay `mock`/`disabled` per the master instruction.
- If a stop condition in the master instruction's §20 is triggered during research or synthesis, stop and report the blocker rather than inventing a resolution.

## 6. Outputs

- This design: `docs/superpowers/specs/2026-08-30-wukong-catalog-operations-os-integration-design.md`
- Meta-layer implementation plan (superpowers task list, produced next by `writing-plans`): `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration-audit-plan.md` (a **different file** from the target deliverable, to avoid collision with the master instruction's own required filename)
- Target deliverable (produced by executing that plan): `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`

## 7. Checkpoints

Two pauses for user review are built into execution, not just a final one:

1. After the seven research subagents return, before drafting begins.
2. After the full 22-section draft exists, before the final self-review/quality-gate pass.
