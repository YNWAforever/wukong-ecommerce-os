# Wukong Catalog Operations OS — Integration Implementation Plan

**Prepared:** 2026-08-30
**Fulfills:** `docs/superpowers/plans/Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md` (uploaded to this repo by the user 2026-08-30; identical copy at `C:\Users\laich\Downloads\Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md`)
**Process record:** `docs/superpowers/specs/2026-08-30-wukong-catalog-operations-os-integration-design.md` (approach), `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration-audit-plan.md` (research-and-drafting task list)
**Nature of this document:** planning-only. No application, infrastructure, database, or deployment change has been made while preparing it; see the closing statement at the end.

Every material claim below is labeled **Observed** (code/test/log evidence cited), **Inferred** (reasonable reading of Observed evidence, not asserted directly by it), **Proposed** (a recommendation in this plan, not existing state), or **Unverified** (could not be confirmed one way or the other; treat as unknown, not as false).

---

## 1. Executive recommendation and readiness verdict

**Verdict: Blocked — not implementation-ready for the Opak Bulk Update pilot as currently scoped.** This is not the workbook-unavailable fallback verdict (the real workbook was supplied and profiled, §2) — it is a verdict driven by concrete, resolvable gaps found by direct code inspection (§7 has the full list; the top five are):

1. **[Observed]** The runtime's listing review/approval UI and the Opak 71-column Bulk Update contract are two entirely disconnected systems today. The review screen (`apps/web/components/listing-review-client.tsx`) edits a 16-field wine-listing domain model (`title`, `producer`, `vintage`, `abvPercent`, …); none of the eight Opak-writable fields (`nameZh`, `summaryEn`, `summaryZh`, `seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`) appear in it. There is no review/approval surface at all for a Bulk-Update draft's eight fields — `deliverBulkForm` (`apps/web/lib/delivery-service.ts:540-556`) writes them directly from whatever enrichment produced them, with no human gate of the kind that exists for the wine-listing workflow.
2. **[Observed]** The generated XLSX names its worksheet `"Sheet1"` (`packages/shopline/src/bulk-form-xlsx.ts:316`, hardcoded), not `"Default"` — the real export's actual sheet name (confirmed in this plan's own workbook inspection, §2). No test or design doc anywhere in the repo checks or even mentions the sheet name. Whether SHOPLINE's own bulk-update re-import rejects a mismatched sheet name is genuinely unknown from this codebase alone.
3. **[Observed]** Five of the Site's routes have no runtime equivalent at all: `/queue`, `/jobs`, `/quality`, `/system-map`, and a list/detail read model for `/batches` (the create/advance write path exists; there is no way to see a batch after creating it).
4. **[Observed]** The master instruction's assumed "immutable source-import and freshness gate" (durable record binding export to `sourceImportId + remoteProductId + sourceRowDigest + activeVersionId`, blocking export unless several conditions hold) has its data half built — `platform_products.contentDigest`/`updatedAt` exist — but no export-time gate function enforcing those conditions was found anywhere in scope. `updatedAt` bumps on every upsert call regardless of whether content actually changed, so it cannot serve as a freshness signal on its own.
5. **[Observed]** A non-empty Variant ID does not block the Bulk Update pipeline (`packages/shopline/src/bulk-form.ts:627-638` — only a warning, row still processes) — the opposite of the master instruction's assumption that this should be an explicit pilot blocker.

**What is not blocked, and should not be rebuilt:** workspace/session security (RLS + `forWorkspace`, role enforcement, invite-only registration, redirect allowlisting, session revocation), the listing state machine and its audit trail, the 71-column classification logic itself (10 locked / 8 writable / 2 delta / 51 pass-through — matches the real workbook exactly, §11), and the Site's IA/visual design (which has no working backend of its own and is a faithful adoption target, not a rebuild target). §6 gives the full reuse disposition.

**Recommended path:** proceed with Package A (baseline/contract freeze, §16) first — it is pure verification and carries no risk — then Package E (the freshness gate and sheet-name fix) before touching any UI, since §11's contract gaps are the highest-severity findings and gate everything downstream. The recommended first PR is detailed in §20.

---

## 2. Evidence register and pinned versions

**Repository.** `https://github.com/YNWAforever/wukong-ecommerce-os`, local branch `main`. At the start of this task, local `main` was 422 commits behind `origin/main`; it was fast-forwarded (`git pull --ff-only`) to `origin/main`'s tip with the user's explicit approval. HEAD during this audit: `765c61628cfdfdf9d289f7127b6d5cd62455296c` ("Add files via upload", 2026-08-30 17:26:19 +0800) — one commit past the master instruction's audited SHA `aac65e5429b86ae308c13a655210295ae7e4f05a` (PR #49, merged 2026-08-26). The one intervening commit added only the master-instruction Markdown file itself (`git show --stat 765c616`: 1 file, 782 insertions, no code changes). This plan's own preparation added two further doc-only commits (`69a831a` design spec, `c44dc47` audit plan) before this file; working tree was otherwise clean of tracked-file conflicts. ~30 untracked scratch files (`task5-*.patch`, `task6-*.ts`, `task7-*.ts`) remain at the repo root from an unrelated, earlier agent session, predate this runtime, and are not part of any package — historical debris, not current state.

**CI.** [Observed] The audited SHA `aac65e5` has a **successful** CI run (`33005551906`, completed 2026-08-26 19:30:52Z) — this matches the run ID the master instruction itself cites, cross-validating both documents. The current HEAD `765c616` has a **failed** CI run (`33304053838`, completed 2026-08-30), but the only failing step is `Check runtime formatting` — i.e. the newly-added Markdown file isn't Prettier-formatted (it has CRLF line endings from a Windows upload), not an application regression. No job besides that one formatting check failed.

**Site.** `https://wukong-catalog-ops.laichiwillyjp.chatgpt.site`, UX/IA reference only, source at `https://github.com/YNWAforever/wukonggpt` (single commit `2426044`, "Import Wukong Catalog Operations OS site source", cloned read-only for this audit). Live crawl performed 2026-08-30 10:15–10:33 UTC, both `zh-HK`/`en-HK` locales, 1280px and 375px viewports, 17/17 hypothesized routes reachable with **no auth gating anywhere** on the live Site (full detail in §4–§5).

**Opak workbook.** `opakcellar-BulkUpdateForm-2026-05-21-15-50_0.xlsx`, supplied by the user as read-only local evidence, never committed to this repo. SHA-256 `1475aa85e7bb400ed5ce16dbdfff93219413cc5403202903f8c5c670ce83c6f1`, 181,907 bytes. Sheet `Default` (single sheet, no `sharedStrings.xml` — every text cell is `t="inlineStr"`), dimension `A1:BS502` → 71 columns × 502 rows → 2 bilingual header rows + 500 data rows. All 71 header cells (both English row 1 and Traditional Chinese row 2) were extracted and matched, in order, against the runtime's `BULK_FORM_COLUMNS` contract (`packages/shopline/src/bulk-form.ts:22-246`) — exact match, confirmed independently by both this plan's own inspection and by the research subagent's separate extraction. First data row spot-checked: SKU `0013` stored as a string (leading zero preserved), delta cell carries the literal string `"+0"`, multi-path category stored as `Red Wine>Italy>Sicily` in one cell, price/cost cells typed `t="n"` (numeric).

**Master instruction provenance.** Two related but distinct planning documents exist in this repo: this one's source (`Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md`, uploaded 2026-08-30, scope: adopt the Site's IA into the runtime) and an earlier, still-live, separate instruction (`docs/product/Wukong_Ecommerce_OS_Product_Frontend_Revamp_ChatGPT_Master_Instruction.md`, v2.0, dated 26 Aug 2026, 1473 lines, scope: a frontend revamp with its own 25 numbered findings and its own required baseline artifacts under `docs/product/frontend-revamp/`). These target overlapping surface area (both touch auth layout, dashboard, review UI). See §7 for the reconciliation and §9 for the decision this creates.

---

## 3. Current-state architecture and runtime invariants

[Observed, unless noted] The runtime is a real pnpm/Turborepo monorepo: `apps/web` (Next.js 16 App Router, React 19, plain CSS), `apps/worker` (Cloudflare Worker), `packages/{core,db,ai,shopline,assets,jobs}`. Stack and conventions are documented in `CLAUDE.md` and enforced by CI (`.github/workflows/ci.yml`).

**Identity and workspace scoping.** Better Auth (`apps/web/auth.ts`) backs invite-only email/password and magic-link sign-in; self-service sign-up is disabled at the Better Auth layer (`disableSignUp: true`, lines 124 and 181) *in addition to* a server-side, SQL-function-backed eligibility check (`auth_get_eligible_user`, `packages/db/drizzle/0002_auth_access_rls.sql:1-21`) that runs before any enrollment email is ever sent — the UI itself (`apps/web/components/auth-form.tsx`, `apps/web/app/register/page.tsx`) contains no eligibility logic of its own. `apps/web/lib/session-context.ts:41-47,137-155` defines the canonical role order `viewer(10) < operator(20) < reviewer(30) < admin(40) < owner(50)` and `requireWorkspaceRole`, used at the app-shell layout (`apps/web/app/(app)/layout.tsx:11-12`), the admin page, and workspace-membership routes. `owner` is bootstrap-only and immutable through every admin code path (Zod enums exclude it, a DB CHECK constraint excludes it, and `MembershipGuardViolation("owner_immutable")` blocks any attempt to change or remove an existing owner row — `packages/db/src/repositories/memberships.ts:241-243,265-267`); no application code was found that ever creates an `owner` row, so bootstrap provisioning happens entirely outside this application (**Inferred**: likely a manual database operation, not documented in any runbook found).

`db.forWorkspace(workspaceId, callback)` (`packages/db/src/client.ts:130-141`) opens a Postgres transaction and sets `app.workspace_id` via a transaction-local `set_config`; every tenant table (and `workspaces` itself) has `FORCE ROW LEVEL SECURITY` policies keyed on that same GUC (`packages/db/drizzle/0000_initial.sql:479-516`). Workspace ID is never accepted from request JSON — it is resolved server-side from the authenticated session (`session-context.ts:13-17`, comment: *"Set by the server after membership resolution; never copied from request input."*). `apps/web/middleware.ts` performs only a cookie-presence check for UX redirect purposes — `CLAUDE.md:55-58` states this explicitly ("Middleware cookie checks are UX only"), and RLS is the real enforcement layer. Root `/` (`apps/web/app/page.tsx`) `redirect("/dashboard")`s; middleware alone stops a signed-out visitor before this file is reached, sending them to `/signin?callbackUrl=/`.

**Gaps found in the security surface (§7 has full detail):** no `trustedOrigins`/CSRF configuration and no explicit secure-cookie attributes were found in application code — both rely on whatever Better Auth defaults to (unverifiable from this repo, since the package isn't resolvable in an inspectable `node_modules`). A second, hand-written role-check mechanism (array allowlists like `["reviewer","admin","owner"].includes(role)`) coexists with `roleOrder` in several listing-workflow routes, with no shared source of truth between the two.

**Workflow, audit, concurrency.** `packages/core/src/workflow.ts:15-25` defines the exhaustive `ListingAction` union (no `reject` action exists anywhere in the codebase) and `transitionListing` (illegal transitions throw, and the transition itself writes a `"listing.transition"` audit event). Every domain mutation writes to `audit_events` via `AuditWriter`, inside the same Postgres transaction as the mutation (rollback-safe). Approval (`apps/web/lib/listing-approval.ts`, `packages/core/src/review.ts`, `packages/db/src/repositories/listings.ts:493-598`) is whole-listing, never per-field, and protected by version-id optimistic concurrency checked **twice** — once when the service reads the current snapshot, and again as the `WHERE activeVersionId = expectedVersionId` predicate on the actual mutating `UPDATE` — so a stale approval can never silently win a race. `reopenListing` (`packages/core/src/review.ts:42-48`) exists and is audited but is never called from any route, service, or worker — it is exported dead code today.

**Delivery.** `apps/web/lib/delivery-service.ts` is the shared decision point for both the wine-listing CSV/API path and the Bulk-Update path (`deliverBulkForm`, lines 540-556) — the latter writes exactly the 8 enrichable columns via `createBulkFormUpdate` and nothing else. `apps/worker/src/listing-pipeline.ts` and `publish-product.ts` operate purely on `CanonicalListing`/`ShoplineProductPayload` and never import anything from the bulk-form modules — confirming the disconnect named in §1.

**Data model.** `platform_products` (`packages/db/src/schema.ts:644-702`) is the one place any listing's SHOPLINE remote-product link lives (`origin: "import"|"created"`); it carries `specVersion`, `rawRow` (jsonb), `factsPrefill` (jsonb), `contentDigest` (an application-computed SHA-256 of the ordered row, via `hashBulkFormRow`, `packages/shopline/src/bulk-form-digest.ts:14-20` — the SHA-256 property is an application-level invariant, not a DB constraint), and `createdAt`/`updatedAt`.

**Verified script surface (all confirmed to exist as named at this commit):** `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e`, `pnpm runtime:doctor <env>`, `pnpm format:runtime:check`, `pnpm runtime:forbidden:check`, `pnpm lint`/`pnpm typecheck` (both are `tsc --noEmit`, not ESLint — `CLAUDE.md:23`), and `pnpm --filter @wukong/db audit:verify` (this one is defined only inside `packages/db/package.json`, not at the workspace root — it resolves solely because `--filter` dispatches into that package).

---

## 4. Updated Site design/route/function inventory

[Observed] The Site (`wukonggpt`) is a Next.js 16.2.6/React 19.2.6 App Router application with **zero backend** — no `route.ts` API handler, no `middleware.ts`, and zero `fetch`/`axios`/`useSWR`/`useQuery` calls anywhere in `app/` or `components/` (confirmed by repo-wide grep on the cloned source). All 16 hypothesized routes plus root `/` exist, exactly as the master instruction's checklist named them, with no extras and no omissions: `/`, `/signin`, `/register`, `/register/set-password`, `/forgot-password`, `/reset-password`, `/pilot`, `/dashboard`, `/catalog`, `/queue`, `/listings/new`, `/batches`, `/listings/[id]`, `/jobs`, `/quality`, `/admin`, `/system-map`. The Site's own `/system-map` page (`app/(product)/system-map/page.tsx:9-19`) and its shell nav (`components/wukong-shell.tsx:42-48`) both independently corroborate this same route set.

**Prototype self-labeling (exact copy, `components/auth-preview.tsx`):** every auth screen carries a status banner — *"原型預覽：身份驗證及電郵傳送尚未連接。請勿輸入真實登入資料；系統不會提交登入或密碼重設要求。"* / *"Prototype preview: Authentication and email delivery are not connected. Do not enter real credentials; no sign-in or reset request will be submitted."* (lines 214-220) — and a disabled submit button labeled "原型暫不提供"/"Not available in prototype" (line 288). The sign-in screen additionally offers a "示範工作區入口"/"Sample workspace access" link straight into `/dashboard` with the caveat *"這不會建立已驗證的登入工作階段"* / *"This does not create an authenticated session"* (lines 293-302).

**Sample data.** Every page's content is inline TypeScript literals — `lib/opak-contract.ts:1-65` defines shared "ground truth" constants (`opakBulkUpdateContract`, `opakReferenceProfile` with counts like `untranslatedNames: 499`) imported across dashboard/quality/catalog/batches/intake/review components; `components/catalog-control-center.tsx:73-79` hard-codes 6 sample rows (`sample-0013`, `sample-stale-0088`, etc.) and its own copy admits *"真實商品目錄仍由伺服器分頁"* / *"real catalog remains server-paginated"* — i.e. the Site's own text acknowledges its sample page isn't representative of real pagination.

**Live crawl confirms:** all 17 routes return HTTP 200 in both locales and both viewports (desktop 1280px+, mobile 375px) with **no auth gate anywhere** — the entire product surface, including `/admin`, is openly viewable. The dashboard's "500 products / 499 name gaps / 489 missing summaries / 7 reference flags" are confirmed literal Site sample data (`opakReferenceProfile`), not runtime output — do not mistake these for real workspace counts anywhere downstream. One anomaly: `/admin` was observed stuck on a loading skeleton ("正在載入工作台管理…") across every visit in this crawl session, with its real content (Members/Integrations/Brand & Policy/System Truth tabs) sitting inert in an unhydrated template node — **[Unverified]** whether this is a genuine Site defect or an artifact of automated/headless capture (`document.visibilityState` was `hidden` throughout); a human interactive re-check is recommended before treating `/admin`'s Site-side behavior as evidence of anything.

**i18n.** Not file-based, not routed — `components/locale-provider.tsx:1-75` is a React Context (`Locale = "zh-HK"|"en-HK"`, default `zh-HK`) with inline `t(zh, en)` call sites everywhere; no persistence (no cookie/localStorage), no locale-prefixed URL — every fresh navigation reverts to `zh-HK`. One partial-translation defect found: the `/queue` English view leaves "無限數量" untranslated inside an otherwise-English sentence.

**Design tokens (`app/globals.css`), confirmed against the master instruction's hypothesis with two nuances:** canvas `#f6f4ef`, navy `#17324d`, text `#182432`, border `#dfe2e1`, muted `#5f6e7b` all confirmed as literal CSS custom properties. The primary CTA `#b36a24`/hover `#8d4e17` are **not** CSS custom properties — they are inline Tailwind arbitrary-value utility classes (`bg-[#b36a24] hover:bg-[#8d4e17]`); the coincidentally-matching `--chart-2` token is unrelated. The "~16px card radius" comes from Tailwind's own unmodified `rounded-2xl` utility (used 106× across 17 files), not from the Site's own `--radius` custom property (which is `0.7rem` ≈ 11.2px, backing `rounded-xl`/`rounded-lg` instead). Font stack confirmed exactly: `"Noto Sans TC", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.

---

## 5. Route and function parity matrix

Rendered as one structured entry per route rather than a single wide table — the master instruction's required column set (route/goal, public/protected + minimum role, zh/en behavior, desktop/mobile states, actions and capability-truth, current runtime route, reusable artifacts, visual/interaction/real-capability parity separately, missing contract, disposition/priority, dependencies, acceptance evidence) does not fit legibly into one row per route; every field is still present for every route below.

### `/` — Front-page workspace entry
- **User goal:** land signed-in users in the app, redirect signed-out users to sign-in.
- **Public/protected:** effectively protected (middleware redirects signed-out visitors); no distinct role requirement.
- **zh/en:** N/A (redirect-only, no rendered content).
- **Site desktop/mobile states:** identical structure both viewports and locales (renders the combined pilot-hero + sign-in composite).
- **Runtime route:** `apps/web/app/page.tsx` — `redirect("/dashboard")`, documented rationale for why the file must exist even though it renders nothing (`page.tsx:1-11`).
- **Parity:** visual — Site-only concept (Site renders a hero here; runtime renders nothing, by design). Interaction — Exact (both ultimately land the user on dashboard or sign-in). Real capability — Exact.
- **Disposition:** reuse as-is. **Priority:** — (already correct).
- **Acceptance evidence:** existing behavior, no test gap identified.

### `/signin` — Functional workspace sign-in
- **Goal:** authenticate an invited user.
- **Public/protected:** public (unauthenticated entry point). No role.
- **zh/en:** Site: full bilingual copy confirmed both locales. Runtime: `apps/web/app/signin/page.tsx` + `auth-form.tsx` — locale support **[Unverified in this audit]**, not directly inspected by any research subagent; flag as a task-3 verification item, not an assumed gap.
- **Desktop/mobile:** Site confirmed both; runtime **Unverified**.
- **Actions/capability-truth:** Site: submit disabled, "prototype" banner, anonymous-demo link. Runtime: **fully functional** — real Better Auth password/magic-link sign-in, server-side eligibility, redirect-allowlisting (`auth-flow.ts:42-76`), lockout after 5 failed attempts (`auth-access.ts:11-12`).
- **Current runtime route/component:** `apps/web/app/signin/page.tsx`, `apps/web/components/auth-form.tsx`, `apps/web/lib/auth-flow.ts`, `apps/web/auth.ts`.
- **Parity:** visual — Partial (layout adoption target, not yet measured against runtime's actual rendered page). Interaction — Runtime-only capability exceeds Site (Site is decorative). Real capability — Runtime-only (Site has none).
- **Missing contract:** none — reuse the existing functional flow; only the layout/copy should be adopted from the Site.
- **Disposition:** extend (visual layer only). **Priority:** high (public-facing, low risk).
- **Dependencies:** ADR-5 (public/auth boundary).
- **Acceptance evidence:** existing `apps/web/auth.test.ts`, `auth-flow.test.ts`; add visual-regression capture per §14.

### `/register`, `/register/set-password`, `/forgot-password`, `/reset-password` — functional flows
- **Goal:** invite-token enrollment, password set, enumeration-safe recovery, token-validated reset.
- **Public/protected:** public routes, server-side eligibility/token validation gates the actual mutation.
- **Site:** all four confirmed reachable, bilingual, both viewports, all with disabled submit + "prototype" labeling; `/register/set-password` and `/reset-password` show no different state even with a `?token=...` query param tried.
- **Runtime:** all four routes exist and are backed by real API routes (`forgot-password/route.ts`, `magic-link/route.ts`, `password/route.ts`, `register/route.ts`), all routed through the same server-side `safeCallbackPath`/eligibility/lockout machinery as `/signin`.
- **Parity:** interaction/real-capability — Runtime-only (functional) vs Site (decorative). Visual — Partial, same layout-adoption note as `/signin`.
- **Disposition:** extend (visual layer only) for all four. **Priority:** high.
- **Dependencies:** ADR-5.
- **Acceptance evidence:** existing `flow-routes.test.ts`; token-specific UI states (e.g. expired-token messaging) should be explicitly acceptance-tested since neither the Site nor this audit observed a distinct token-context render.

### `/pilot` — Public positioning and pilot intake
- **Goal:** public marketing/lead-intake, no workspace access.
- **Public/protected:** public, no role.
- **Site:** full marketing page — hero, 4-step workflow explainer, capability-truth table, an intake form whose submit is deliberately not wired ("this form is intentionally not transmitted").
- **Runtime:** **Missing** — no equivalent route found anywhere in `apps/web`.
- **Parity:** all three axes — Missing.
- **Missing contract:** none required beyond static content + (optionally) a lead-capture endpoint, which is explicitly out of scope per the master instruction unless a decision owner approves it.
- **Disposition:** new (Proposed) — but ownership must be decided first: this page's content and purpose overlaps with the separate public `wukong-ops-suite` marketing application named in `docs/product/ecommerce-os-product-plan.md`. **Do not duplicate a second marketing surface inside this runtime.**
- **Priority:** low (not on the Opak pilot's critical path).
- **Dependencies:** ADR-5.
- **Acceptance evidence:** none yet — blocked on the ownership decision in §21.

### `/dashboard` — Source readiness, gaps, risk, UAT overview
- **Goal:** operator landing page summarizing catalog health.
- **Public/protected:** protected, any authenticated role (viewer+).
- **Site:** readiness banner, 4 stat tiles (confirmed literal sample data, not live), 6-step operating flow, capability-truth list; reachable with no auth gate live.
- **Runtime:** `apps/web/app/(app)/dashboard/page.tsx`, `apps/web/components/dashboard-listings-client.tsx` — counts (`active`/`inReview`/`blocked`) are computed by `.filter().length` over real fetched data, **not hard-coded**, but the source query (`repositories.listings.listRecent(100)`) caps at the 100 most-recently-updated listings — so counts are real arithmetic over a bounded, not-necessarily-complete, subset.
- **Parity:** visual — Partial (IA/copy needs adoption). Interaction — Partial. Real capability — Partial (real data, capped scope).
- **Missing contract:** a true full-workspace count (no `COUNT(*)` query exists anywhere in scope); source-freshness/content-gap surfacing (data exists in `platform_products` but isn't exposed to any dashboard-facing API).
- **Disposition:** extend. **Priority:** high.
- **Dependencies:** the `/queue`/`/jobs`/`/quality` read models below feed this page's "gaps/risk/UAT" framing.
- **Acceptance evidence:** new test needed for the >100-listings case (currently untested per this audit — flag for §17).

### `/catalog` — Existing-product control centre
- **Goal:** read-only, searchable view of the platform-linked catalog.
- **Public/protected:** protected, viewer+.
- **Site:** 6 sample rows showing 5 distinct states in one view (Ready for review / Needs enrichment / Blocked / Data warning / Approved for XLSX), client-side search/filter controls.
- **Runtime:** `apps/web/components/catalog-control-center.tsx`, `apps/web/app/api/catalog/route.ts`. **CONFIRMED**: the read endpoint takes no `Request` parameter at all and cannot read a query string; `platform-products.ts:246-261`'s `listRecent(limit)` has no search WHERE clause. All filtering happens client-side over the already-fetched, hard-capped 100-row payload. The runtime's own in-app copy admits this ("下一階段會加入分頁..." — pagination is next-phase, not yet built) and `docs/product/catalog-control-center-acceptance.md` explicitly scopes this as a deliberate, temporary limitation with cursor pagination and server search listed as its own deferred acceptance items — not silently unaddressed.
- **Parity:** visual — Partial. Interaction — Partial (search/filter exist but scoped to 100 rows). Real capability — Partial, matching the master instruction's own hypothesis exactly.
- **Missing contract:** server-side `GET /api/catalog` with pagination/search/cohort/source-freshness fields (§10).
- **Disposition:** extend. **Priority:** high (this is the highest-visibility read surface).
- **Dependencies:** none blocking; independent of the Opak review-UI work.
- **Acceptance evidence:** new integration test for >100-row workspaces; existing acceptance doc's deferred items become this package's scope.

### `/queue` — Risk-laned work queue
- **Goal:** operator triage queue laned by risk/state.
- **Site:** reachable, part of standard nav.
- **Runtime:** **Missing route.** `apps/web/components/listing-queue.tsx` exists (confirmed present in the file-existence check preceding this audit) and is a named required-reading artifact in the master instruction, but no research subagent found an `apps/web/app/(app)/queue/page.tsx` or equivalent wiring it to a page — **[Unverified beyond component existence]**, flag for direct confirmation in Task Package D before assuming the component is unused vs. simply unwired.
- **Parity:** visual/interaction/real-capability — Missing (runtime), matches master instruction's own hypothesis.
- **Missing contract:** a page wiring `listing-queue.tsx` to real listing-status data, laned by the risk states the Site demonstrates.
- **Disposition:** new route, reusing the existing component (extend `listing-queue.tsx` itself only as needed for lane logic). **Priority:** medium.
- **Dependencies:** shares its status data source with `/dashboard` and `/jobs`.
- **Acceptance evidence:** none yet.

### `/listings/new` — Existing-product Bulk Update import (Create separated)
- **Goal:** import a fresh SHOPLINE export and start the Bulk Update flow; new-product creation kept separate.
- **Site:** 3-tab intake (Existing products = primary/confirmed, Supporting evidence, New products = explicitly "Blocked — separate Create template required").
- **Runtime:** `apps/web/app/(app)/listings/new/page.tsx` exists; `apps/web/lib/bulk-form-import.ts` (the actual XLSX-import logic, confirmed present and functioning per §11) exists as a library function, but **no research subagent directly confirmed this page invokes it** — the page's content/wiring to Bulk Update import specifically is **[Unverified]**, not Observed; per the master instruction's own framing this route was "primarily new-listing intake" historically (per `docs/superpowers/plans/2026-07-12-shopline-ai-listing-mvp.md`'s original scope) and may still carry that legacy shape.
- **Parity:** Unverified pending direct page inspection — do not assume Exact or Missing.
- **Missing contract:** confirm current wiring; if the page still targets new-listing intake rather than the Bulk-Update importer, an ADR is needed on route ownership (ADR-2, §9).
- **Disposition:** requires investigation before disposition can be assigned — this is a stop-relevant unknown, not a decided "extend."
- **Priority:** high (this is the entry point for the entire Opak flow).
- **Dependencies:** blocks nothing else, but nothing else should proceed confidently until this is confirmed.
- **Acceptance evidence:** none yet; add a task to Package E to resolve this before any UI work on this route.

### `/batches` — Attended enrichment cohorts/waves
- **Goal:** create and step through budgeted AI-enrichment waves over a content-gap cohort.
- **Site:** wave-planning form + wave table showing 3 states (Awaiting operator / Locked ×2, policy-gated on prior wave).
- **Runtime:** **Missing list/detail route.** `apps/web/lib/enrichment-batch-service.ts` exists; per `docs/superpowers/plans/2026-08-16-catalog-enrichment-batches.md` (subagent 5's doc survey) the create/advance service and API contracts exist, but there is no page to view a batch after creating it — matches the master instruction's own hypothesis exactly.
- **Parity:** Missing (read model), Runtime-only-partial (write path).
- **Missing contract:** `GET` list/detail contract for batches (§10); the master instruction's required backend-enforced 1–5 wave-size cap for the Opak pilot — **[Unverified]** whether the existing create/advance API already enforces this range server-side or only relies on UI limits; must be confirmed, not assumed, before this is called pilot-ready.
- **Disposition:** extend (add read model + verify/enforce the wave-size cap server-side). **Priority:** high (directly gates Opak pilot scale control).
- **Dependencies:** the freshness-gate work in Package E, since batch items must bind to `sourceImportId`+digest per §11.
- **Acceptance evidence:** none yet.

### `/listings/[id]` — Evidence/diff review of the exact eight writable fields
- **Goal:** review AI-proposed changes against evidence, approve or request more info.
- **Site:** 8-field AI-diff UI (evidence panel with confidence%, current-vs-proposed diff, locked-field integrity panel), sampled `sample-0013` (ready) and `sample-stale-0088` (a distinct "blocked by stale sample" banner) — both trivially reachable via different sample IDs, no backend manipulation needed.
- **Runtime:** `apps/web/components/listing-review-client.tsx`, `listing-fields-form.tsx`, `evidence-panel.tsx`. **CONFIRMED gap** (§1, §7): this UI reviews a 16-field wine-listing model, not the 8 Opak fields — there is no Bulk-Update review surface here at all today. The version-id optimistic-concurrency protection and the whole-listing approval mechanics (§3) are solid and directly reusable once the right fields are wired in.
- **Parity:** visual — Site-only concept for the specific 8-field diff layout (nothing to compare against on the runtime side yet). Interaction — Missing (no review path for these fields exists). Real capability — Missing.
- **Missing contract:** the entire eight-field review/diff/evidence surface, bound to `platform_products`'s `contentDigest`/`activeVersionId` (§10, §11) — this is the single largest build item in this plan.
- **Disposition:** extend the existing review-workflow machinery (version-concurrency, audit, approval gating) with a new field set and evidence source; do not replace the underlying workflow engine. **Priority:** highest (this is the pilot's core value surface).
- **Dependencies:** Package E (freshness gate) must land first so review/approval can bind to it correctly (§11's confirmation-ledger requirement).
- **Acceptance evidence:** none yet; this is the centerpiece of Package G (§16).

### `/jobs` — Import, processing, export and SHOPLINE confirmation ledger
- **Goal:** operational ledger across import/enrichment/export/manual-SHOPLINE-import stages.
- **Site:** 4 rows, 4 distinct states (Reference only / Awaiting operator / UAT required / Waiting for evidence).
- **Runtime:** **Missing route and read model** — no equivalent found anywhere.
- **Parity:** Missing on all three axes.
- **Missing contract:** a durable ledger read model spanning import → batch → export → manual-SHOPLINE-import-confirmation, per §11's confirmation-ledger and §10's job/import/export contract requirements.
- **Disposition:** new. **Priority:** high (this is where "file generated" vs. "SHOPLINE import confirmed" must be kept visibly distinct, per master instruction §11).
- **Dependencies:** Package E and Package H (multi-product export) both feed this ledger.
- **Acceptance evidence:** none yet.

### `/quality` — Real content gaps, evidence, human edits, cost
- **Goal:** report AI enrichment quality/cost/coverage.
- **Site:** 4 stat tiles + 6-row signal table (localisation gap, summary gap, SEO title/description mirrors, keyword mirrors — matching the gap enum documented in `docs/runbooks/shopline-pilot-onboarding.md:83-121`: `untranslatedName, untranslatedSeoTitle, seoTitleMirrorsName, seoDescriptionMirrorsSeoTitle, keywordsMirrorName, summaryMissing`).
- **Runtime:** **Missing route and read model.** `ai_runs` records exist in the schema (per §3's data model and the runbook's gap enum being already-defined vocabulary), so the underlying data to compute these signals likely exists — **[Inferred]**, not directly confirmed by any subagent reading a quality-specific query — but no page or API surfaces it.
- **Parity:** Missing.
- **Missing contract:** a read model aggregating `ai_runs`/`field_evidence`/human-edit-distance into the six gap signals; must not invent telemetry that isn't backed by stored data (master instruction §9).
- **Disposition:** new. **Priority:** medium.
- **Dependencies:** depends on Package G's review UI actually recording human edits before "edit distance" can be computed honestly.
- **Acceptance evidence:** none yet.

### `/admin` — Members, integrations, brand/policy, system truth
- **Goal:** workspace administration.
- **Site:** 4 tabs (Members/Integrations/Brand & Policy/System Truth) per the accessibility-tree inspection of its (currently unhydrated) content; **[Unverified]** live rendering — this route was observed stuck on a loading skeleton throughout the live crawl (§4), so the Site's actual admin behavior could not be directly confirmed as working, only inspected from its inert markup.
- **Runtime:** `apps/web/components/admin-tabs.tsx:9-15` — **3 tabs only** (members, connection, settings — no separate "roles" tab, folded into members). All backed by real, admin-role-gated API routes (§3). "Workspace settings" today is a single `brandBackgroundColor` field, not a broader configuration surface.
- **Parity:** visual — Partial (Site has a 4th "System Truth" tab concept the runtime lacks). Interaction — Partial (3 of the Site's implied 4 areas are real; System Truth doesn't exist). Real capability — Partial, and Runtime-only in the sense that the 3 existing tabs are fully functional (unlike the Site's own currently-broken live rendering).
- **Missing contract:** a "System Truth"/capability-registry surface (§9 ADR-11, §10).
- **Disposition:** extend. **Priority:** medium.
- **Dependencies:** the capability registry needed here overlaps with what `/system-map` needs below — build once, surface twice.
- **Acceptance evidence:** existing admin route tests; new test needed for any capability-registry addition.

### `/system-map` — Route/capability truth
- **Goal:** self-documenting map of what's real vs. planned.
- **Site:** self-documents its own (Site-side) route table plus a 7-row API-contract status table (Implemented in runtime / Needs extension / Missing / Runtime contract / Controlled UAT) — useful as the Site's own claimed parity assessment, but **not to be taken at face value**; this plan's §5 (this section) is the actual cross-checked source of truth, built from runtime code, not from the Site's own claims about the runtime.
- **Runtime:** **Missing.**
- **Parity:** Missing.
- **Missing contract:** a capability-registry-backed page (shared backing with `/admin`'s "System Truth" tab, per above) showing Live/Pilot/Planned/Blocked per capability, per master instruction §9.
- **Disposition:** new. **Priority:** low-medium (valuable for internal truth-telling, not on the pilot's critical path).
- **Dependencies:** shares its data source with `/admin`'s System Truth tab (build once).
- **Acceptance evidence:** none yet.

---

## 6. Reuse and anti-rewrite matrix

| Artifact | Disposition | Justification |
|---|---|---|
| `packages/db` schema, RLS policies, `forWorkspace`, migrations | **Reuse as-is** | Fully correct, force-RLS on every tenant table, transaction-scoped GUC — no evidence of any defect (§3). |
| `apps/web/lib/session-context.ts`, `auth.ts`, `auth-flow.ts`, invite/eligibility SQL functions | **Reuse as-is** | Server-side enforced, well-tested, matches master instruction's security requirements already (§3). |
| `apps/web/middleware.ts` | **Reuse as-is** | Correctly scoped as UX-only per its own documented intent (`CLAUDE.md:55-58`); not a security boundary to "fix." |
| Role-order dual-enforcement (hand-written array allowlists in listing routes) | **Refactor in place** | Consolidate the array-allowlist checks in `deliver`/`review`/`bulk-approve`/`approve`/`flags/resolve` routes onto `requireWorkspaceRole`/`roleOrder` — same behavior today, but removes a silent-divergence risk (§3, §7). Low-risk, mechanical change; keep as its own small PR. |
| `packages/core/workflow.ts`, `review.ts`, `compliance.ts` (state machine, approval, compliance scanning) | **Reuse as-is**, **extend** only to wire `reopenListing` into a real UI action if the product decides it's needed (currently unused dead code, not broken) | Domain logic is correct and audited; the only issue is one unused export, not a defect. |
| `packages/db/src/repositories/listings.ts` (version-concurrency, audit) | **Reuse as-is** | Read+write double-checked optimistic concurrency is exactly the pattern the master instruction requires for the new eight-field review (§11) — extend its *usage*, not its mechanism. |
| `apps/web/components/catalog-control-center.tsx`, `apps/web/app/api/catalog/route.ts`, `platform-products.ts`'s `listRecent` | **Extend** | Add a `Request`-aware handler with cursor pagination/search/cohort fields; keep the existing component's rendering approach, just feed it a real paginated contract (§5, §10). |
| `apps/web/components/admin-tabs.tsx` + 3 panel components | **Extend** | Add a 4th "System Truth"/capability-registry tab; the existing 3 are correct and complete for their current scope (§5). |
| `apps/web/components/listing-review-client.tsx`, `listing-fields-form.tsx`, `evidence-panel.tsx`, and the approval/version machinery they sit on | **Extend** (not replace) | The concurrency/audit/approval engine underneath is exactly right; what's missing is a second review "mode" or a parallel component targeting the 8 Bulk-Update fields instead of the 16 wine-listing fields. Replacing the whole component would throw away correct, tested concurrency logic for no reason (§1, §5). |
| `packages/shopline/src/bulk-form.ts` (71-column classification, parsing, validation) | **Reuse as-is** | Classification exactly matches the real workbook, zero unclassified columns, correct string-preservation guarantees (§2, §11). This is the strongest-built part of the whole contract — do not touch its column logic. |
| `packages/shopline/src/bulk-form-xlsx.ts` | **Extend** (narrow fix) | Only the hardcoded `"Sheet1"` literal (line 316) needs to change to `"Default"`; everything else (inline-string encoding, no numeric coercion, 3-cell-type reader) is correct and should not be rewritten (§1, §11). |
| `packages/shopline/src/bulk-form-digest.ts`, `platform_products.contentDigest`/`updatedAt` | **Extend** | The digest computation itself is correct; what's missing is (a) surfacing these fields through an API, (b) an explicit export-time freshness-gate function enforcing the master instruction's conditions, and (c) not conflating "upserted" with "content actually changed" for freshness purposes (§3, §11). |
| `apps/web/lib/delivery-service.ts`, `deliverBulkForm` | **Reuse as-is** for its current single-listing scope; **extend** with a new multi-product batch-export mode (§11) | The single-listing path is correct; the batch gap is additive, not a rewrite. |
| `apps/web/components/listing-queue.tsx` | **Reuse as-is**, wire into a new `/queue` page | Component exists and is presumably complete per its inclusion in the master instruction's required-reading list; confirm exact current state before final disposition (§5's flagged unknown). |
| `apps/web/lib/enrichment-batch-service.ts` + batch create/advance API | **Extend** | Write path exists and is correct per its own design docs; add the missing read model, and confirm/enforce the 1–5 wave-size cap server-side (§5, §9 ADR-10). |
| Site (`wukonggpt`) design tokens, IA, component layout | **Extend into existing plain-CSS system** | Adopt confirmed tokens/layout into the runtime's existing CSS-custom-property approach (§4); do not introduce Tailwind/shadcn into the runtime to match the Site's stack — the Site's own stack is irrelevant to the runtime's implementation (master instruction §6). |
| Site's own auth/data-fetching code | **Retire (do not port)** | The Site has no working backend of any kind — nothing here to reuse beyond visual reference; porting its "prototype" states or copy into the connected runtime would be a regression (§1, §4). |
| `/pilot`, `/queue`, `/batches` (read), `/jobs`, `/quality`, `/system-map`, admin's 4th tab | **New** (Proposed) | No existing runtime artifact to reuse beyond named components noted above; build per §5's per-route contract. |
