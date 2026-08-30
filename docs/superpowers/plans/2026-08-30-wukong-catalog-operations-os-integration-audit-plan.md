# Wukong Catalog Operations OS Integration Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to run this plan task-by-task. It is a research-and-writing task, not a code change — "tests" below mean citation/completeness verification, not automated test runs. Do NOT use superpowers:subagent-driven-development for the drafting tasks (3–6): the design at `docs/superpowers/specs/2026-08-30-wukong-catalog-operations-os-integration-design.md` §4 requires single-author synthesis, i.e. the same conversant who read every research report must write every section — a fresh subagent per task would violate that. Task 1's fan-out is the one place multiple agents run, and they are dispatched directly by the orchestrating session, not by a subagent.

**Goal:** Produce `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`, the single, self-contained, evidence-backed, planning-only Markdown implementation plan required by the master instruction at `docs/superpowers/plans/Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md` (also supplied identically by the user from `C:\Users\laich\Downloads\Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md` — the in-repo copy, uploaded by the user 2026-08-30, is the citable version of record).

**Architecture:** Fan out 7 read-only research subagents in parallel over disjoint areas of the runtime repo, the `wukonggpt` Site repo, and the live Site; pause for user review of the consolidated findings; then synthesize everything personally into the master instruction's 22 mandated sections in order; self-check against the master instruction's own §19 quality gates and §20 stop conditions; pause again for user review of the full draft; then finalize.

**Tech Stack (of the artifact being audited, not of this plan):** pnpm/Turborepo, Next.js 16, React 19, plain CSS, Cloudflare Workers/Queues/Hyperdrive/R2, Neon Postgres/Drizzle/RLS, Better Auth, Zod, Vitest, Playwright.

**Confirmed baseline (do not re-verify):** local `main` is synced to `origin/main` @ `765c616`, one commit past the master instruction's audited SHA `aac65e5`. Every file path named in the master instruction's §5 required-inspection list has been confirmed to exist at this commit (checked via `git cat-file -e main:<path>` for all 30 paths — all `OK`, zero misses). The Opak workbook (`opakcellar-BulkUpdateForm-2026-05-21-15-50_0.xlsx`, SHA-256 `1475aa85e7bb400ed5ce16dbdfff93219413cc5403202903f8c5c670ce83c6f1`) is hashed and structurally profiled in the design doc §2 — do not re-hash or re-profile it.

---

## Task 1: Dispatch Research Subagents

**Files:** none created or modified — this task only produces in-conversation subagent reports plus one scratch notes file.

- [ ] **Step 1: Dispatch all 7 subagents in parallel, in a single message with 7 Agent tool calls**

Use `subagent_type: general-purpose` for all seven (need Bash for git-clone and Browser tools for the live crawl; Explore's tool restrictions are too narrow for the cross-referencing agents 4 and 5 need to do). Every prompt below ends with the same three constraints — read-only, cite everything, flag rather than guess — do not drop them when dispatching.

**Subagent 1 — Auth & workspace identity**

```
Investigate authentication and workspace-identity code in the wukong-ecommerce-os repo at
C:\Users\laich\Documents\WukongEommerce (git ref: main @ 765c616). Read and cite exact
file:line-range and symbol name for each finding on:

- apps/web/components/auth-form.tsx
- apps/web/lib/session-context.ts
- apps/web/auth.ts (Better Auth configuration)
- apps/web/app/api/auth/[...all]/route.ts, forgot-password/route.ts, magic-link/route.ts,
  password/route.ts, register/route.ts
- apps/web/app/register/page.tsx, register/set-password/page.tsx, forgot-password/page.tsx,
  reset-password/page.tsx, signin/page.tsx
- apps/web/lib/auth-flow.ts, auth-mailer.ts, auth-route.ts
- apps/web/middleware.ts if it exists (search for it if the exact path differs)

Specifically answer, with citations: how is the role order (viewer < operator < reviewer <
admin < owner) enforced and where; how does bootstrap-only owner assignment work; where does
authenticated code enter db.forWorkspace(...) / RLS; what rate limiting, CSRF/origin
protection, redirect allowlisting, secure-cookie, session-fixation defence, and
previous-session revocation behavior actually exists (cite each or state "not found" with
where you searched); is invitation-only registration enforced server-side or only in UI.

Read-only: do not edit, write, or run any command that mutates files or git state. Return a
structured list: {claim, file, lines, symbol, quote-or-paraphrase}. If a named path does not
exist exactly, search the same directory for the closest equivalent and report the
discrepancy as its own finding rather than silently substituting. Do not draw architectural
conclusions beyond what the code shows — flag anything ambiguous instead of guessing.
```

**Subagent 2 — Dashboard / Catalog / Admin**

```
Investigate the dashboard, catalog, and admin surfaces in the wukong-ecommerce-os repo at
C:\Users\laich\Documents\WukongEommerce (git ref: main @ 765c616). Read and cite exact
file:line-range and symbol name for each finding on:

- apps/web/components/catalog-control-center.tsx
- apps/web/components/admin-tabs.tsx
- apps/web/components/dashboard-listings-client.tsx
- apps/web/app/(app)/dashboard/page.tsx, apps/web/app/(app)/catalog/page.tsx,
  apps/web/app/(app)/admin/page.tsx
- packages/db/src/repositories/platform-products.ts
- the catalog read API route (search apps/web/app/api for a catalog route; report its exact
  path)

Specifically answer, with citations: does the catalog read endpoint support server-side
pagination and search, or only recent-records/client-side filtering (the master instruction
claims the latter — confirm or refute with a citation); what content-gap/source-freshness/
eligibility fields does the repository or API actually expose today; what admin capabilities
exist (members, invites, roles, connections, workspace settings) and which API routes back
them; are dashboard counts computed from real data or hard-coded — cite the exact
line if hard-coded values are found.

Read-only: do not edit, write, or run any command that mutates files or git state. Return a
structured list: {claim, file, lines, symbol, quote-or-paraphrase}. If a named path does not
exist exactly, search the same directory for the closest equivalent and report the
discrepancy as its own finding rather than silently substituting. Do not draw architectural
conclusions beyond what the code shows — flag anything ambiguous instead of guessing.
```

**Subagent 3 — Listing review/approval workflow**

```
Investigate the listing review and approval workflow in the wukong-ecommerce-os repo at
C:\Users\laich\Documents\WukongEommerce (git ref: main @ 765c616). Read and cite exact
file:line-range and symbol name for each finding on:

- apps/web/components/listing-review-client.tsx
- apps/web/components/listing-fields-form.tsx
- apps/web/components/evidence-panel.tsx
- apps/web/components/delivery-panel.tsx
- apps/web/components/compliance-flags.tsx
- apps/web/components/listing-processing-panel.tsx
- apps/web/lib/listing-approval.ts
- apps/web/app/api/listings/[id]/approve/route.ts,
  apps/web/app/api/listings/[id]/flags/resolve/route.ts,
  apps/web/app/api/listings/[id]/review/route.ts
- packages/core/src/workflow.ts, review.ts, compliance.ts

Specifically answer, with citations: does the review UI expose all eight Opak Bulk-Update
writable fields (nameZh, summaryEn, summaryZh, seoTitleEn, seoTitleZh, seoDescriptionEn,
seoDescriptionZh, seoKeywords), or fewer — list exactly which fields the review component
renders and cite the lines; how does immutable-version / stale-edit protection work (what
prevents approving a version that is no longer active); what audit events are written on
approve/reject/reopen and where; is approval whole-listing or per-field.

Read-only: do not edit, write, or run any command that mutates files or git state. Return a
structured list: {claim, file, lines, symbol, quote-or-paraphrase}. If a named path does not
exist exactly, search the same directory for the closest equivalent and report the
discrepancy as its own finding rather than silently substituting. Do not draw architectural
conclusions beyond what the code shows — flag anything ambiguous instead of guessing.
```

**Subagent 4 — Opak Bulk Update contract code**

```
Investigate the Opak SHOPLINE Bulk Update contract implementation in the wukong-ecommerce-os
repo at C:\Users\laich\Documents\WukongEommerce (git ref: main @ 765c616). Read and cite exact
file:line-range and symbol name for each finding on:

- packages/shopline/src/bulk-form.ts, bulk-form-xlsx.ts, bulk-form-source.ts,
  bulk-form-digest.ts, csv.ts, delivery-policy.ts
- apps/worker/src/listing-pipeline.ts, publish-product.ts
- packages/core/src/listing-schema.ts
- packages/db/src/schema.ts, client.ts
- apps/web/lib/delivery-service.ts, bulk-form-import.ts, enrichment-batch-service.ts

The real workbook's 71 ordered column headers (English, from row 1 of the actual
opakcellar-BulkUpdateForm-2026-05-21-15-50_0.xlsx, sheet "Default") are:

A Product ID (DO NOT EDIT) | B Product Name (English) | C Product Name (Traditional Chinese)
| D Product Summary (English) | E Product Summary (Traditional Chinese) | F SEO Title
(English) | G SEO Title (Traditional Chinese) | H SEO Description (English) | I SEO
Description (Traditional Chinese) | J SEO Keywords | K Hidden Product | L Preorder Feature |
M Preorder Note (English) | N Preorder Note (Traditional Chinese) | O Unlimited Preorder
Supply | P Preorder Limit | Q Online Store Status | R Retail Store Status | S Preset Online
Store Publish Date | T Product Available start date | U Product Available end date | V Brand
| W Hide Price | X Online Store Categories | Y POS Categories (English) | Z POS Categories
(Traditional Chinese) | AA Regular Price | AB Sale Price | AC Product Retail Store Price | AD
Member Price | AE Gold Membership Price | AF Platinum Membership Price | AG Diamond
Membership Price | AH Trade Price | AI Unlimited Quantity | AJ Same Price | AK Product Cost |
AL SKU | AM Quantity (DO NOT EDIT) | AN Update Quantity (e.g. +5 or -8) | AO Weight(KG) | AP
Supplier | AQ Product Tag | AR Product Promotion Label (English) | AS Product Promotion Label
(Traditional Chinese) | AT Exclude Payment Options | AU Exclude Delivery Options | AV Variant
ID (DO NOT EDIT) | AW Variant (English) (DO NOT EDIT) | AX Variant (Traditional Chinese) (DO
NOT EDIT) | AY Variant Quantity (DO NOT EDIT) | AZ Update Variant Quantity (e.g. +5 or -8) |
BA Variant Price | BB Variant Sale Price | BC Variant Retail Store Price | BD Variant Member
Price | BE Variant Gold Membership Price | BF Variant Platinum Membership Price | BG Variant
Diamond Membership Price | BH Variant Trade Price | BI Variant Cost | BJ Variant Weight(KG) |
BK Variant SKU | BL Location ID | BM MPN | BN Barcode | BO SL_STOCK_ID(DO NOT EDIT) | BP
Warehouse(DO NOT EDIT) | BQ Product not applicable to discount | BR SL_KEY0(DO NOT EDIT) | BS
SL_KEY1(DO NOT EDIT)

For every one of these 71 columns, find where (if anywhere) the runtime code classifies it as
one of: locked/echoed-exactly (expect 10: productId, quantity, variantId, variantEn,
variantZh, variantQuantity, slStockId, warehouse, slKey0, slKey1), AI-writable (expect 8:
nameZh, summaryEn, summaryZh, seoTitleEn, seoTitleZh, seoDescriptionEn, seoDescriptionZh,
seoKeywords), neutral-only stock delta (expect 2: updateQuantity, updateVariantQuantity), or
pass-through (expect the remaining 51). Cite the exact file:line for each classification you
find, and list any column the code does NOT classify at all. Also answer: does the exporter
preserve identifiers as strings (leading-zero SKU/Barcode, alphanumeric/blank Barcode)?
Does it preserve blank/null/0/0.0/+0 as distinct states, or coerce them? What sheet name and
string-encoding does the generated XLSX actually use (cite the writer code) — compare against
"Default" with inline strings (the real export's actual format, already confirmed). Does a
non-empty Variant ID block the pipeline? Is there a durable source-import record with
SHA-256/digest/freshness fields, and where?

Read-only: do not edit, write, or run any command that mutates files or git state. Return a
structured list: {claim, file, lines, symbol, quote-or-paraphrase}, plus an explicit
column-by-column table (71 rows) of classification-found-in-code vs expected. Do not draw
conclusions beyond what the code shows — flag ambiguity instead of guessing.
```

**Subagent 5 — Docs, CI, tests**

```
Investigate the documentation, CI, and test surface of the wukong-ecommerce-os repo at
C:\Users\laich\Documents\WukongEommerce (git ref: main @ 765c616). Read and summarize with
exact file:line citations:

- CLAUDE.md, CONTEXT.md (repo root)
- docs/product/ecommerce-os-product-plan.md, docs/product/catalog-control-center-acceptance.md,
  docs/product/Wukong_Ecommerce_OS_Product_Frontend_Revamp_ChatGPT_Master_Instruction.md
- docs/runbooks/local-development.md, production-readiness.md, shopline-pilot-onboarding.md,
  production-ai-runtime.md, production-bring-up.md
- Every file under docs/superpowers/specs/ and docs/superpowers/plans/ dated 2026-07-12
  through 2026-08-27 (list each file's title/goal in one line — do not summarize full content,
  just what feature/decision each one covers, since there are ~20 of them and later synthesis
  only needs to know which one to go back to for which topic)
- .github/workflows/ci.yml
- root package.json, pnpm-workspace.yaml, turbo.json (workspace scripts only — what does
  `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e`, `pnpm runtime:doctor`,
  `pnpm --filter @wukong/db audit:verify`, `pnpm format:runtime:check`,
  `pnpm runtime:forbidden:check`, `pnpm lint`, `pnpm typecheck` actually resolve to — confirm
  each script name exists verbatim or report the closest actual name)

Read-only: do not edit, write, or run any command that mutates files or git state (you may
run read-only `pnpm` script-listing commands like `pnpm run` with no arguments, or `cat
package.json`, but do not run `pnpm install`, `pnpm build`, or any test suite). Return a
structured list: {claim, file, lines, quote-or-paraphrase}. Flag anything ambiguous instead
of guessing.
```

**Subagent 6 — Site (wukonggpt) code structure**

```
Clone https://github.com/YNWAforever/wukonggpt read-only into
C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\wukonggpt-site-src
(create the directory if needed). Do NOT clone it inside
C:\Users\laich\Documents\WukongEommerce (the runtime repo) and do not commit anything there.

Map the Site's route structure, components, and mock/sample data sources. Specifically
answer, with file:line citations from the cloned source:

- Every route the Site defines (list all — the master instruction hypothesizes /, /signin,
  /register, /register/set-password, /forgot-password, /reset-password, /pilot, /dashboard,
  /catalog, /queue, /listings/new, /batches, /listings/[id], /jobs, /quality, /admin,
  /system-map — confirm each exists, note any missing or extra)
- Where and how the Site labels itself an unconnected/prototype auth flow (exact copy string
  and file:line)
- Where sample/anonymous data is hard-coded vs. fetched
- The Site's i18n mechanism (locale files, switch route, default locale)
- Design tokens actually defined in code (colors, radius, font stack, spacing) — compare
  against this starting hypothesis to confirm/refute: canvas #f6f4ef, navy #17324d, text
  #182432, border #dfe2e1, muted #5f6e7b, primary CTA #b36a24, hover #8d4e17, active accent
  #d39a63, font Noto Sans TC with Inter/system fallbacks, ~16px card radius

Read-only after the clone: do not edit or push anything. Return a structured list:
{claim, file, lines, quote-or-paraphrase}. Flag ambiguity instead of guessing.
```

**Subagent 7 — Live Site crawl**

```
Using the Browser tool, crawl https://wukong-catalog-ops.laichiwillyjp.chatgpt.site. For each
of these routes — /, /signin, /register, /register/set-password, /forgot-password,
/reset-password, /pilot, /dashboard, /catalog, /queue, /listings/new, /batches,
/listings/[id] (pick any reachable sample id or state), /jobs, /quality, /admin, /system-map —
visit it at both a desktop width (1280px+) and a 375px mobile width (use resize_window), and
in both English and Traditional Chinese if a locale switch is reachable. For each
route+locale+viewport combination, capture: whether it's reachable at all (note the HTTP
behavior or redirect if not), the primary rendered state, and any additional state visibly
reachable without artificial network manipulation (loading/empty/error/disabled/stale/
forbidden/success — only where a UI control or URL param makes it trivially reachable; do not
force states that require backend manipulation). Note design tokens actually rendered
(colors, radius, type) for cross-check against the hypothesis in subagent 6's brief. Record
UTC capture time for each visit.

If a route is inaccessible (auth-gated with no way in, etc.), mark it Unverified and do not
infer its behavior. Return a structured list: {route, locale, viewport, utc_time, reachable,
state_captured, notes}. Do not draw conclusions about backend capability from anything you
see on this Site — it is a UX/IA reference only.
```

- [ ] **Step 2: Verify each of the 7 returned reports contains citations, not just prose**

For each report, confirm every material claim carries a `{file, lines}` or `{route, locale,
viewport}` or `{sheet, cell}` reference. If any subagent's report is missing citations for a
significant claim, or came back null (dead on a terminal API error), re-dispatch that single
subagent with the same prompt plus one added line: "Your previous attempt returned
uncited/vague claims — every claim in this report must carry a file:line or route/locale/
viewport citation." Do not proceed to Step 3 until all 7 reports are citation-complete.

- [ ] **Step 3: Save consolidated raw findings to a scratch notes file (not committed)**

Write the 7 reports, concatenated with clear headers, to:
`C:\Users\laich\AppData\Local\Temp\claude\C--Users-laich-Documents-WukongEommerce\8854911c-9fc7-4f55-82c2-24ba7d846561\scratchpad\catalog-ops-research-findings.md`

This file is a working reference for Tasks 3–6, not part of the deliverable — it lives outside
the repo and is never committed.

- [ ] **Step 4: Commit — none.** This task produces no repo changes.

---

## Task 2: Checkpoint 1 — Present Findings, Wait for Approval

**Files:** none.

- [ ] **Step 1: Summarize the 7 reports for the user**

Present a concise summary (not the full raw text) covering: what each subagent found, any
named-conflict already resolved or still open (the five conflicts named in the master
instruction §4, plus the inline-string reconciliation from the design doc §2), and anything
that looks like a new stop-condition trigger (per master instruction §20).

- [ ] **Step 2: Wait for explicit user go-ahead before starting Task 3**

Do not begin drafting the target deliverable until the user responds. If they request more
research on a specific area, dispatch one targeted follow-up subagent for that area only,
then re-summarize and wait again.

---

## Task 3: Draft Target Deliverable — Sections 1–6

**Files:**

- Create: `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`

- [ ] **Step 1: Confirm the target file does not already exist**

Run: `git ls-tree main -- docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`
Expected: empty output (already confirmed once in this session — re-confirm immediately
before the first write in case anything changed).

- [ ] **Step 2: Write the document header and Section 1 — Executive recommendation and readiness verdict**

State the overall Go/Blocked verdict plainly, driven by real gaps found in Task 1 (e.g. missing
`/queue` `/jobs` `/quality` `/batches`-read-model routes, partial eight-field review UI, single-
listing-only export vs. Site's batch export). The master instruction's "Blocked pending
workbook verification" fallback verdict does NOT apply here — the real workbook was supplied
and profiled (design doc §2) — but any other unresolved §20 stop condition found during Task 1
must still be named explicitly in this verdict, not deferred silently to Section 19.

- [ ] **Step 3: Write Section 2 — Evidence register and pinned versions**

Include: repo URL, branch, HEAD SHA `765c616`, audited SHA `aac65e5` (one commit prior), CI
run status from subagent 5's findings, Site URL/access state/inspection times from subagent 7,
workbook filename/SHA-256/sheet/dimension from the design doc §2, and a citation to the
in-repo master instruction copy at
`docs/superpowers/plans/Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md`
(uploaded by the user 2026-08-30) as the version of record.

- [ ] **Step 4: Write Section 3 — Current-state architecture and runtime invariants**

Synthesize from subagents 1–4: auth/session model, role order and enforcement point, RLS
entry point, workflow state machine, audit event points, queue idempotency — each claim
citing its subagent's file:line finding.

- [ ] **Step 5: Write Section 4 — Updated Site design/route/function inventory**

Synthesize from subagents 6–7: every Site route, its purpose, i18n mechanism, design tokens
confirmed vs. hypothesis, and where the Site self-labels as prototype.

- [ ] **Step 6: Write Section 5 — Route and function parity matrix**

One row per Site route (from subagent 6/7) and per runtime route (from subagents 1–3),
using the parity labels from master instruction §8 (Exact/Partial/Missing/Site-only concept/
Runtime-only/Blocked/Deliberately excluded) and every column that section requires. This is
the spine other sections reference — do not defer any route to "TBD."

- [ ] **Step 7: Write Section 6 — Reuse and anti-rewrite matrix**

For every artifact touched by the parity matrix, assign a disposition (reuse as-is / extend /
refactor in place / replace / retire) per master instruction §6, with justification citing
subagent findings for any replace/retire call.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md
git commit -m "docs: draft sections 1-6 of catalog operations os integration plan"
```

---

## Task 4: Draft Target Deliverable — Sections 7–11

**Files:**

- Modify: `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`

- [ ] **Step 1: Write Section 7 — Confirmed gaps, contradictions and blockers**

Resolve explicitly, with evidence for each side: auth prototype-vs-real, missing routes
(`/batches` `/queue` `/jobs` `/quality` `/system-map` `/pilot`), single-listing-vs-batch
export, freshness-gate depth (Site's hard-coded 24/72h vs. runtime's manual instructions —
do not hard-code a threshold per master instruction §11), eight-field review breadth, and the
inline-string workbook reconciliation from the design doc §2.

- [ ] **Step 2: Write Section 8 — Target information architecture and component ownership**

Define shared shell/layout boundaries, role-aware nav, workspace-derived Opak/pilot labels
from config not hard-coded shared-shell copy, loading/empty/error/stale/conflict/retry states,
per master instruction §7.

- [ ] **Step 3: Write Section 9 — Proposed ADRs**

Write all 12 ADRs named in master instruction §15, each with context/decision/alternatives/
consequences/compatibility/security effect/migration path/reversal trigger, marked
**Proposed** with a named decision owner (use role, e.g. "Opak product owner" / "runtime tech
lead" — do not invent a person's name).

- [ ] **Step 4: Write Section 10 — Data model, API, RLS and audit contracts**

Map every user action per master instruction §10's chain (UI → endpoint/method → minimum role
→ Zod schema → domain service → repository → queue if any → audit event → idempotency/
version key), inventorying existing endpoints from subagents 1–4 before proposing any new one.

- [ ] **Step 5: Write Section 11 — Opak 71-column Bulk Update contract**

Use subagent 4's column-by-column classification table directly. State plainly where the
code's classification diverges from the expected 10 locked / 8 writable / 2 delta / 51
pass-through split, and carry forward the freshness-gate, review-ledger, multi-product-XLSX,
and UAT go/no-go requirements from master instruction §11 verbatim in structure (not
paraphrased into vagueness — these are the highest-risk section of the whole deliverable).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md
git commit -m "docs: draft sections 7-11 of catalog operations os integration plan"
```

---

## Task 5: Draft Target Deliverable — Sections 12–17

**Files:**

- Modify: `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`

- [ ] **Step 1: Write Section 12 — Authentication and public-entry plan**

Per master instruction §9's "Public entry and authentication" subsection: ownership of `/`,
`/signin`, `/pilot` without duplicating `wukong-ops-suite`; reuse of Better Auth/invite/mailer;
adopting the two-panel layout without carrying over the Site's "prototype unavailable"
messaging; security items listed there (rate limiting, CSRF, redirect allowlisting, etc.),
citing subagent 1's findings for what already exists vs. what's proposed.

- [ ] **Step 2: Write Section 13 — Internationalisation plan**

Per master instruction §12, using subagent 6/7's confirmed i18n mechanism as the "current
state" input.

- [ ] **Step 3: Write Section 14 — Accessibility, responsive and performance plan**

Per master instruction §13, using subagent 7's captured desktop/mobile states as evidence of
current gaps.

- [ ] **Step 4: Write Section 15 — Security, privacy, observability and audit plan**

Per master instruction §14, citing subagent 1/3/4's RLS/audit/idempotency findings as the
current-state baseline for each item in that section's list.

- [ ] **Step 5: Write Section 16 — File-level PR sequence and dependency graph**

Per master instruction §16, using the A–K phase list as the ordering skeleton, filling in
exact files/symbols from subagents 1–6's findings for each package, with size (S/M/L) per
package rather than hour estimates.

- [ ] **Step 6: Write Section 17 — Test strategy and commands**

Use subagent 5's confirmed exact script names (not the master instruction's assumed names,
if they differ) and list the test coverage areas from master instruction §17.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md
git commit -m "docs: draft sections 12-17 of catalog operations os integration plan"
```

---

## Task 6: Draft Target Deliverable — Sections 18–22 and Closing Statement

**Files:**

- Modify: `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`

- [ ] **Step 1: Write Section 18 — Rollout, Opak UAT, go/no-go and rollback**

Per master instruction §11's UAT subsection (1–5 attended, 30–50 golden set, 50–100 shadow
pilot, catalog-scale only after sign-off) and its acceptance-criteria list.

- [ ] **Step 2: Write Section 19 — Risks, decisions, assumptions and stop conditions**

List every open risk/assumption surfaced across Tasks 3–5, plus every stop condition from
master instruction §20 that currently applies (even partially) to this repo's real state.

- [ ] **Step 3: Write Section 20 — Recommended first PR**

Name one concrete, small, reviewable first package from the Section 16 sequence, with its
exact files and acceptance evidence.

- [ ] **Step 4: Write Section 21 — Decisions required before the first PR**

List each decision from the ADRs in Section 9 that blocks the recommended first PR, with a
named decision-owner role for each.

- [ ] **Step 5: Write Section 22 — Implementation-ready checklist**

One line per item in master instruction §19's plan-quality-gate list, marked done/not-done
with a pointer to the section that satisfies it.

- [ ] **Step 6: Append the mandatory closing statement verbatim**

```markdown
> No application code, infrastructure, database, deployment or production SHOPLINE state was changed while preparing this plan.
```

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md
git commit -m "docs: draft sections 18-22 and closing statement of catalog operations os integration plan"
```

---

## Task 7: Self-Review Against the Master Instruction's Own Quality Gates

**Files:**

- Modify (if fixes needed): `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`

- [ ] **Step 1: Run the §19 plan-quality-gate checklist literally**

Read master instruction §19 line by line against the drafted document. For each bullet,
confirm pass or fix inline before moving to the next bullet — do not batch fixes for later.

- [ ] **Step 2: Run the §20 stop-condition checklist literally**

For each stop condition, confirm it does not apply, or that it's already surfaced correctly
in Section 19 (Risks/decisions/stop conditions) of the drafted document rather than silently
ignored.

- [ ] **Step 3: Placeholder and citation scan**

Search the drafted document for "TBD", "TODO", unsourced claims lacking a file:line/route/
cell citation, and any route from the Section 5 parity matrix that doesn't also appear
somewhere in Sections 7–20 if it was flagged as a gap. Fix inline.

- [ ] **Step 4: Commit any fixes**

```bash
git add docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md
git commit -m "docs: self-review fixes for catalog operations os integration plan"
```

(Skip this commit if Step 3 found nothing to fix.)

---

## Task 8: Checkpoint 2 — Present Full Draft, Wait for Approval

**Files:** none.

- [ ] **Step 1: Present the full draft to the user for review**

Point to the file, summarize the verdict (Section 1) and the biggest 3–5 findings/decisions
needed, and ask explicitly whether they want changes before final polish.

- [ ] **Step 2: Wait for explicit approval**

If changes are requested, make them in the relevant task's section and re-run the affected
parts of Task 7's checklist before returning to this checkpoint.

---

## Task 9: Final Polish

**Files:**

- Modify: `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md`

- [ ] **Step 1: Apply any changes requested at Checkpoint 2**

- [ ] **Step 2: Re-run Task 7's three checks one final time**

- [ ] **Step 3: Final commit**

```bash
git add docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md
git commit -m "docs: finalize catalog operations os integration plan"
```

- [ ] **Step 4: Report completion to the user**

State the final file path, the verdict, and remind them per the design doc §5 that no
application/infra/database/deployment change has occurred — only these Markdown files.
