# Wukong Catalog Operations OS — Integration Implementation Plan

**Prepared:** 2026-08-30
**Fulfills:** `docs/superpowers/plans/Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md` (uploaded to this repo by the user 2026-08-30; identical copy at `C:\Users\laich\Downloads\Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md`)
**Process record:** `docs/superpowers/specs/2026-08-30-wukong-catalog-operations-os-integration-design.md` (approach), `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration-audit-plan.md` (research-and-drafting task list)
**Nature of this document:** planning-only. No application, infrastructure, database, or deployment change has been made while preparing it; see the closing statement at the end.

Every material claim below is labeled **Observed** (code/test/log evidence cited), **Inferred** (reasonable reading of Observed evidence, not asserted directly by it), **Proposed** (a recommendation in this plan, not existing state), or **Unverified** (could not be confirmed one way or the other; treat as unknown, not as false).

---

## 1. Executive recommendation and readiness verdict

**Verdict: Blocked — not implementation-ready for the Opak Bulk Update pilot as currently scoped.** This is not the workbook-unavailable fallback verdict (the real workbook was supplied and profiled, §2) — it is a verdict driven by concrete, resolvable gaps found by direct code inspection (§7 has the full list; the top five are):

1. **[Observed, corrected from an earlier draft of this plan]** `deliverBulkForm` (`apps/web/lib/delivery-service.ts:494-566`) maps the eight Opak fields directly from the existing `CanonicalListing` reviewed by `listing-review-client.tsx`: `nameZh ← content.title["zh-Hant"]`, `summaryEn/Zh ← content.description.{en,zh-Hant}`, `seoTitleEn/Zh ← content.seo.title.{en,zh-Hant}`, `seoDescriptionEn/Zh ← content.seo.description.{en,zh-Hant}`, `seoKeywords ← content.tags.join(", ")`. Since `title`/`description` are among the 16 fields the review UI already edits, **three of the eight Opak fields (`nameZh`, `summaryEn`, `summaryZh`) are already human-reviewed today**, just under different display labels — the systems are connected, not disconnected. The real gap is narrower: `content.seo`/`content.tags` pass through the review UI unmodified (confirmed: neither is rendered or edited anywhere in `listing-fields-form.tsx`), so the remaining **five fields (`seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`) are exported straight from AI output with no human review gate at all**. The fix is extending the existing review UI's SEO/tags handling, not building a fully parallel review mode.
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

**Identity and workspace scoping.** Better Auth (`apps/web/auth.ts`) backs invite-only email/password and magic-link sign-in; self-service sign-up is disabled at the Better Auth layer (`disableSignUp: true`, lines 124 and 181) _in addition to_ a server-side, SQL-function-backed eligibility check (`auth_get_eligible_user`, `packages/db/drizzle/0002_auth_access_rls.sql:1-21`) that runs before any enrollment email is ever sent — the UI itself (`apps/web/components/auth-form.tsx`, `apps/web/app/register/page.tsx`) contains no eligibility logic of its own. `apps/web/lib/session-context.ts:41-47,137-155` defines the canonical role order `viewer(10) < operator(20) < reviewer(30) < admin(40) < owner(50)` and `requireWorkspaceRole`, used at the app-shell layout (`apps/web/app/(app)/layout.tsx:11-12`), the admin page, and workspace-membership routes. `owner` is bootstrap-only and immutable through every admin code path (Zod enums exclude it, a DB CHECK constraint excludes it, and `MembershipGuardViolation("owner_immutable")` blocks any attempt to change or remove an existing owner row — `packages/db/src/repositories/memberships.ts:241-243,265-267`); no application code was found that ever creates an `owner` row, so bootstrap provisioning happens entirely outside this application (**Inferred**: likely a manual database operation, not documented in any runbook found).

`db.forWorkspace(workspaceId, callback)` (`packages/db/src/client.ts:130-141`) opens a Postgres transaction and sets `app.workspace_id` via a transaction-local `set_config`; every tenant table (and `workspaces` itself) has `FORCE ROW LEVEL SECURITY` policies keyed on that same GUC (`packages/db/drizzle/0000_initial.sql:479-516`). Workspace ID is never accepted from request JSON — it is resolved server-side from the authenticated session (`session-context.ts:13-17`, comment: _"Set by the server after membership resolution; never copied from request input."_). `apps/web/middleware.ts` performs only a cookie-presence check for UX redirect purposes — `CLAUDE.md:55-58` states this explicitly ("Middleware cookie checks are UX only"), and RLS is the real enforcement layer. Root `/` (`apps/web/app/page.tsx`) `redirect("/dashboard")`s; middleware alone stops a signed-out visitor before this file is reached, sending them to `/signin?callbackUrl=/`.

**Gaps found in the security surface (§7 has full detail):** no `trustedOrigins`/CSRF configuration and no explicit secure-cookie attributes were found in application code — both rely on whatever Better Auth defaults to (unverifiable from this repo, since the package isn't resolvable in an inspectable `node_modules`). A second, hand-written role-check mechanism (array allowlists like `["reviewer","admin","owner"].includes(role)`) coexists with `roleOrder` in several listing-workflow routes, with no shared source of truth between the two.

**Workflow, audit, concurrency.** `packages/core/src/workflow.ts:15-25` defines the exhaustive `ListingAction` union (no `reject` action exists anywhere in the codebase) and `transitionListing` (illegal transitions throw, and the transition itself writes a `"listing.transition"` audit event). Every domain mutation writes to `audit_events` via `AuditWriter`, inside the same Postgres transaction as the mutation (rollback-safe). Approval (`apps/web/lib/listing-approval.ts`, `packages/core/src/review.ts`, `packages/db/src/repositories/listings.ts:493-598`) is whole-listing, never per-field, and protected by version-id optimistic concurrency checked **twice** — once when the service reads the current snapshot, and again as the `WHERE activeVersionId = expectedVersionId` predicate on the actual mutating `UPDATE` — so a stale approval can never silently win a race. `reopenListing` (`packages/core/src/review.ts:42-48`) exists and is audited but is never called from any route, service, or worker — it is exported dead code today.

**Delivery.** `apps/web/lib/delivery-service.ts` is the shared decision point for both the wine-listing CSV/API path and the Bulk-Update path (`deliverBulkForm`, lines 540-556) — the latter writes exactly the 8 enrichable columns via `createBulkFormUpdate` and nothing else. `apps/worker/src/listing-pipeline.ts` and `publish-product.ts` operate purely on `CanonicalListing`/`ShoplineProductPayload` and never import anything from the bulk-form modules — confirming the disconnect named in §1.

**Data model.** `platform_products` (`packages/db/src/schema.ts:644-702`) is the one place any listing's SHOPLINE remote-product link lives (`origin: "import"|"created"`); it carries `specVersion`, `rawRow` (jsonb), `factsPrefill` (jsonb), `contentDigest` (an application-computed SHA-256 of the ordered row, via `hashBulkFormRow`, `packages/shopline/src/bulk-form-digest.ts:14-20` — the SHA-256 property is an application-level invariant, not a DB constraint), and `createdAt`/`updatedAt`.

**Verified script surface (all confirmed to exist as named at this commit):** `pnpm test`, `pnpm test:integration`, `pnpm build`, `pnpm test:e2e`, `pnpm runtime:doctor <env>`, `pnpm format:runtime:check`, `pnpm runtime:forbidden:check`, `pnpm lint`/`pnpm typecheck` (both are `tsc --noEmit`, not ESLint — `CLAUDE.md:23`), and `pnpm --filter @wukong/db audit:verify` (this one is defined only inside `packages/db/package.json`, not at the workspace root — it resolves solely because `--filter` dispatches into that package).

---

## 4. Updated Site design/route/function inventory

[Observed] The Site (`wukonggpt`) is a Next.js 16.2.6/React 19.2.6 App Router application with **zero backend** — no `route.ts` API handler, no `middleware.ts`, and zero `fetch`/`axios`/`useSWR`/`useQuery` calls anywhere in `app/` or `components/` (confirmed by repo-wide grep on the cloned source). All 16 hypothesized routes plus root `/` exist, exactly as the master instruction's checklist named them, with no extras and no omissions: `/`, `/signin`, `/register`, `/register/set-password`, `/forgot-password`, `/reset-password`, `/pilot`, `/dashboard`, `/catalog`, `/queue`, `/listings/new`, `/batches`, `/listings/[id]`, `/jobs`, `/quality`, `/admin`, `/system-map`. The Site's own `/system-map` page (`app/(product)/system-map/page.tsx:9-19`) and its shell nav (`components/wukong-shell.tsx:42-48`) both independently corroborate this same route set.

**Prototype self-labeling (exact copy, `components/auth-preview.tsx`):** every auth screen carries a status banner — _"原型預覽：身份驗證及電郵傳送尚未連接。請勿輸入真實登入資料；系統不會提交登入或密碼重設要求。"_ / _"Prototype preview: Authentication and email delivery are not connected. Do not enter real credentials; no sign-in or reset request will be submitted."_ (lines 214-220) — and a disabled submit button labeled "原型暫不提供"/"Not available in prototype" (line 288). The sign-in screen additionally offers a "示範工作區入口"/"Sample workspace access" link straight into `/dashboard` with the caveat _"這不會建立已驗證的登入工作階段"_ / _"This does not create an authenticated session"_ (lines 293-302).

**Sample data.** Every page's content is inline TypeScript literals — `lib/opak-contract.ts:1-65` defines shared "ground truth" constants (`opakBulkUpdateContract`, `opakReferenceProfile` with counts like `untranslatedNames: 499`) imported across dashboard/quality/catalog/batches/intake/review components; `components/catalog-control-center.tsx:73-79` hard-codes 6 sample rows (`sample-0013`, `sample-stale-0088`, etc.) and its own copy admits _"真實商品目錄仍由伺服器分頁"_ / _"real catalog remains server-paginated"_ — i.e. the Site's own text acknowledges its sample page isn't representative of real pagination.

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

### `/register` — Invite-only enrolment

- **Goal:** an invited user creates their account.
- **Public/protected:** public route, server-side invite-eligibility gates the actual mutation.
- **Site:** reachable, bilingual, both viewports, disabled submit + "prototype" labeling ("Invited accounts only" copy).
- **Runtime:** `apps/web/app/register/page.tsx`, backed by `apps/web/app/api/auth/register/route.ts` — real, server-side eligibility-gated, generic response regardless of outcome (§3).
- **Parity:** interaction/real-capability — Runtime-only (functional) vs Site (decorative). Visual — Partial, same layout-adoption note as `/signin`.
- **Disposition:** extend (visual layer only). **Priority:** high.
- **Dependencies:** ADR-5.
- **Acceptance evidence:** existing `flow-routes.test.ts`.

### `/register/set-password` — Invite-token password setup

- **Goal:** complete enrollment by setting a password after an invite token is validated.
- **Public/protected:** public route, token validation gates the actual mutation.
- **Site:** reachable both locales/viewports; showed no distinct state even when a `?token=invalidtoken123` query param was tried (still a generic form).
- **Runtime:** `apps/web/app/register/set-password/page.tsx`, backed by `apps/web/app/api/auth/password/route.ts` (§3).
- **Parity:** interaction/real-capability — Runtime-only vs Site (decorative). Visual — Partial.
- **Disposition:** extend (visual layer only). **Priority:** high.
- **Dependencies:** ADR-5.
- **Acceptance evidence:** existing `flow-routes.test.ts`; a distinct expired/invalid-token UI state should be explicitly acceptance-tested, since neither the Site nor this audit observed one.

### `/forgot-password` — Enumeration-safe recovery

- **Goal:** request a password reset without revealing whether an email exists.
- **Public/protected:** public route.
- **Site:** reachable both locales/viewports, single work-email field, disabled submit.
- **Runtime:** `apps/web/app/forgot-password/page.tsx`, backed by `apps/web/app/api/auth/forgot-password/route.ts`, using the same generic-response, enumeration-safe pattern as `/register` (§3).
- **Parity:** interaction/real-capability — Runtime-only vs Site (decorative). Visual — Partial.
- **Disposition:** extend (visual layer only). **Priority:** high.
- **Dependencies:** ADR-5.
- **Acceptance evidence:** existing `flow-routes.test.ts`.

### `/reset-password` — Token-validated reset

- **Goal:** complete a password reset after a valid reset token.
- **Public/protected:** public route, token validation gates the mutation.
- **Site:** reachable both locales/viewports; like `/register/set-password`, showed no distinct state for a tried token param.
- **Runtime:** `apps/web/app/reset-password/page.tsx`, backed by `apps/web/app/api/auth/password/route.ts`; on success, triggers the confirmed session-revocation behavior (`revokeSessionsOnPasswordReset: true`, §3).
- **Parity:** interaction/real-capability — Runtime-only vs Site (decorative). Visual — Partial.
- **Disposition:** extend (visual layer only). **Priority:** high.
- **Dependencies:** ADR-5.
- **Acceptance evidence:** existing `flow-routes.test.ts`; a distinct expired/invalid-token UI state should be explicitly acceptance-tested, same caveat as `/register/set-password`.

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
- **Runtime, [Observed, resolving the prior Unverified item]:** `apps/web/app/(app)/listings/new/page.tsx` renders `ListingIntakeClient` exclusively — this is the original photo/PDF wine-listing intake flow (breadcrumb "建立草稿"/"Create Draft", copy about uploading bottle photos and supplier data for AI extraction), i.e. exactly the flow the master instruction says should become the pilot's _blocked_ "New products" tab. `POST /api/listings/import` (`apps/web/app/api/listings/import/route.ts`, backed by `apps/web/lib/bulk-form-import.ts`'s `createBulkFormImporter`) is a complete, tested, operator-role-gated Bulk Update import endpoint — but **zero UI anywhere calls it**. So the route isn't ambiguously wired; it's unambiguously wired to the wrong flow for this pilot, with the right flow's backend built but entirely unreachable from any page.
- **Parity:** visual — Site-only concept (Site's 3-tab layout has no runtime analogue at all today). Interaction — Missing (Bulk Update import has no UI path). Real capability — Runtime-only-partial (the import API itself is fully functional and tested; only its UI entry point is missing).
- **Missing contract:** restructure this route into the Site's 3-tab IA (Existing products primary / Supporting evidence / New products blocked), with the "Existing products" tab calling the existing `POST /api/listings/import`, and the current `ListingIntakeClient` flow moving to the disabled "New products" tab (ADR-2, §9).
- **Disposition:** extend — build a new primary tab wired to the already-working import API; move (don't discard) the existing intake flow into the blocked tab.
- **Priority:** high (this is the entry point for the entire Opak flow).
- **Dependencies:** none — the backend it needs already exists and is tested.
- **Acceptance evidence:** existing `app/api/listings/import/route.test.ts` (6 tests, already passing) covers the backend; new UI-level acceptance test needed once the tab is built.

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
- **Runtime:** `apps/web/components/listing-review-client.tsx`, `listing-fields-form.tsx`, `evidence-panel.tsx`. **CONFIRMED, corrected from an earlier draft of this plan** (§1, §7 G5): three of the eight Opak fields (`nameZh`, `summaryEn`, `summaryZh`) are already reviewed today via the existing `title`/`description` fields (`deliverBulkForm`, `apps/web/lib/delivery-service.ts:494-566`, maps them directly from `content.title`/`content.description`). The other five (`seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`) come from `content.seo`/`content.tags`, which pass through the review UI unmodified — those five are exported straight from AI output with no human review gate. The version-id optimistic-concurrency protection and the whole-listing approval mechanics (§3) are solid and directly reusable.
- **Parity:** visual — Partial (the Site's 8-field diff layout has a runtime analogue for 3 of 8 fields already; the other 5 need surfacing). Interaction — Partial (3 of 8 fields reviewable; 5 are not). Real capability — Partial.
- **Missing contract:** exposing and evidence-backing `content.seo.title`, `content.seo.description`, and `content.tags` in the review UI, plus binding the whole review/approval flow to `platform_products`'s `contentDigest`/`activeVersionId` (§10, §11) — smaller than originally scoped, but still the single largest build item in this plan.
- **Disposition:** extend the existing review-workflow machinery and the existing field-review UI with the 5 missing fields' evidence/diff display; do not replace the underlying workflow engine or build a fully parallel review mode. **Priority:** highest (this is the pilot's core value surface).
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

| Artifact                                                                                                                                         | Disposition                                                                                                                                                | Justification                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db` schema, RLS policies, `forWorkspace`, migrations                                                                                   | **Reuse as-is**                                                                                                                                            | Fully correct, force-RLS on every tenant table, transaction-scoped GUC — no evidence of any defect (§3).                                                                                                                                                                                                               |
| `apps/web/lib/session-context.ts`, `auth.ts`, `auth-flow.ts`, invite/eligibility SQL functions                                                   | **Reuse as-is**                                                                                                                                            | Server-side enforced, well-tested, matches master instruction's security requirements already (§3).                                                                                                                                                                                                                    |
| `apps/web/middleware.ts`                                                                                                                         | **Reuse as-is**                                                                                                                                            | Correctly scoped as UX-only per its own documented intent (`CLAUDE.md:55-58`); not a security boundary to "fix."                                                                                                                                                                                                       |
| Role-order dual-enforcement (hand-written array allowlists in listing routes)                                                                    | **Refactor in place**                                                                                                                                      | Consolidate the array-allowlist checks in `deliver`/`review`/`bulk-approve`/`approve`/`flags/resolve` routes onto `requireWorkspaceRole`/`roleOrder` — same behavior today, but removes a silent-divergence risk (§3, §7). Low-risk, mechanical change; keep as its own small PR.                                      |
| `packages/core/workflow.ts`, `review.ts`, `compliance.ts` (state machine, approval, compliance scanning)                                         | **Reuse as-is**, **extend** only to wire `reopenListing` into a real UI action if the product decides it's needed (currently unused dead code, not broken) | Domain logic is correct and audited; the only issue is one unused export, not a defect.                                                                                                                                                                                                                                |
| `packages/db/src/repositories/listings.ts` (version-concurrency, audit)                                                                          | **Reuse as-is**                                                                                                                                            | Read+write double-checked optimistic concurrency is exactly the pattern the master instruction requires for the new eight-field review (§11) — extend its _usage_, not its mechanism.                                                                                                                                  |
| `apps/web/components/catalog-control-center.tsx`, `apps/web/app/api/catalog/route.ts`, `platform-products.ts`'s `listRecent`                     | **Extend**                                                                                                                                                 | Add a `Request`-aware handler with cursor pagination/search/cohort fields; keep the existing component's rendering approach, just feed it a real paginated contract (§5, §10).                                                                                                                                         |
| `apps/web/components/admin-tabs.tsx` + 3 panel components                                                                                        | **Extend**                                                                                                                                                 | Add a 4th "System Truth"/capability-registry tab; the existing 3 are correct and complete for their current scope (§5).                                                                                                                                                                                                |
| `apps/web/components/listing-review-client.tsx`, `listing-fields-form.tsx`, `evidence-panel.tsx`, and the approval/version machinery they sit on | **Extend** (not replace)                                                                                                                                   | The concurrency/audit/approval engine underneath is exactly right; what's missing is a second review "mode" or a parallel component targeting the 8 Bulk-Update fields instead of the 16 wine-listing fields. Replacing the whole component would throw away correct, tested concurrency logic for no reason (§1, §5). |
| `packages/shopline/src/bulk-form.ts` (71-column classification, parsing, validation)                                                             | **Reuse as-is**                                                                                                                                            | Classification exactly matches the real workbook, zero unclassified columns, correct string-preservation guarantees (§2, §11). This is the strongest-built part of the whole contract — do not touch its column logic.                                                                                                 |
| `packages/shopline/src/bulk-form-xlsx.ts`                                                                                                        | **Extend** (narrow fix)                                                                                                                                    | Only the hardcoded `"Sheet1"` literal (line 316) needs to change to `"Default"`; everything else (inline-string encoding, no numeric coercion, 3-cell-type reader) is correct and should not be rewritten (§1, §11).                                                                                                   |
| `packages/shopline/src/bulk-form-digest.ts`, `platform_products.contentDigest`/`updatedAt`                                                       | **Extend**                                                                                                                                                 | The digest computation itself is correct; what's missing is (a) surfacing these fields through an API, (b) an explicit export-time freshness-gate function enforcing the master instruction's conditions, and (c) not conflating "upserted" with "content actually changed" for freshness purposes (§3, §11).          |
| `apps/web/lib/delivery-service.ts`, `deliverBulkForm`                                                                                            | **Reuse as-is** for its current single-listing scope; **extend** with a new multi-product batch-export mode (§11)                                          | The single-listing path is correct; the batch gap is additive, not a rewrite.                                                                                                                                                                                                                                          |
| `apps/web/components/listing-queue.tsx`                                                                                                          | **Reuse as-is**, wire into a new `/queue` page                                                                                                             | Component exists and is presumably complete per its inclusion in the master instruction's required-reading list; confirm exact current state before final disposition (§5's flagged unknown).                                                                                                                          |
| `apps/web/lib/enrichment-batch-service.ts` + batch create/advance API                                                                            | **Extend**                                                                                                                                                 | Write path exists and is correct per its own design docs; add the missing read model, and confirm/enforce the 1–5 wave-size cap server-side (§5, §9 ADR-10).                                                                                                                                                           |
| Site (`wukonggpt`) design tokens, IA, component layout                                                                                           | **Extend into existing plain-CSS system**                                                                                                                  | Adopt confirmed tokens/layout into the runtime's existing CSS-custom-property approach (§4); do not introduce Tailwind/shadcn into the runtime to match the Site's stack — the Site's own stack is irrelevant to the runtime's implementation (master instruction §6).                                                 |
| Site's own auth/data-fetching code                                                                                                               | **Retire (do not port)**                                                                                                                                   | The Site has no working backend of any kind — nothing here to reuse beyond visual reference; porting its "prototype" states or copy into the connected runtime would be a regression (§1, §4).                                                                                                                         |
| `/pilot`, `/queue`, `/batches` (read), `/jobs`, `/quality`, `/system-map`, admin's 4th tab                                                       | **New** (Proposed)                                                                                                                                         | No existing runtime artifact to reuse beyond named components noted above; build per §5's per-route contract.                                                                                                                                                                                                          |

---

## 7. Confirmed gaps, contradictions and blockers

Each entry: conflicting claims → evidence for each side → operational/security consequences → recommended resolution → decision owner → stop-until-decided?

### G1. Auth: "prototype" (Site) vs. real (runtime)

- **Claims:** Site labels every auth screen unconnected/prototype (§4). Runtime has a fully functional, server-side-enforced auth system (§3).
- **Evidence:** Site `auth-preview.tsx:214-220,288`; runtime `auth-flow.ts`, `auth.ts`, `0002_auth_access_rls.sql`.
- **Consequence if mishandled:** copying the Site's "not available in prototype" messaging into the connected runtime would present real, working functionality as broken — a direct regression, explicitly forbidden by the master instruction.
- **Resolution:** adopt the Site's layout/copy/IA verbatim except the disabled-state and prototype-banner elements; keep the runtime's real submit behavior. [**Proposed**]
- **Decision owner:** runtime tech lead. **Stop until decided:** No — resolution is unambiguous from the master instruction's own rules.

### G2. Five routes missing entirely from the runtime

- **Claims:** Site defines `/queue`, `/jobs`, `/quality`, `/system-map`, and a `/batches` read view; master instruction's own hypothesis table already predicted these as Missing.
- **Evidence:** §5, all five entries.
- **Consequence:** none of these are security-relevant gaps (they're read-model absences), but `/dashboard`'s "gaps/risk/UAT overview" framing (master instruction §9) cannot be honest without at least `/quality` and `/jobs` feeding it.
- **Resolution:** build per §5's individual contracts, in the order given in §16 (Packages D, F, I). [**Proposed**]
- **Decision owner:** runtime tech lead. **Stop until decided:** No.

### G3. Single-listing export (runtime) vs. batch changed-row export (Site)

- **Claims:** Site depicts multi-product changed-row XLSX delivery from `/batches`/`/jobs`. Runtime's `deliverBulkForm` (`delivery-service.ts:540-556`) only ever writes one listing's row into one workbook per call.
- **Evidence:** §3, §6.
- **Consequence:** without a batch export, the Opak pilot cannot deliver a wave of enriched products in one file — the workflow language in §11 explicitly requires this.
- **Resolution:** build the multi-product export as an additive capability on top of the existing single-row `createBulkFormUpdate` (§11 has the full spec), not a replacement. [**Proposed**]
- **Decision owner:** Opak product owner + runtime tech lead (joint — this changes operator workflow). **Stop until decided:** No, but this is Package H and gates go-live.

### G4. Freshness-gate depth: Site's hard 24/72h thresholds vs. runtime's absence of any explicit gate

- **Claims:** Site shows source-freshness/fingerprint gates as a settled feature. Runtime has the raw data (`contentDigest`, `updatedAt`) but no function enforcing any threshold, hard-coded or attested.
- **Evidence:** §3, §6; master instruction §11 explicitly says "Do not hard-code the Site's 24/72-hour thresholds until Opak approves them."
- **Consequence:** shipping the batch/review/export features without this gate risks reviewing or exporting against a stale, superseded source row — the single highest-severity risk in the whole plan (data correctness against a live merchant catalog).
- **Resolution:** build an explicit attended freshness attestation (a human confirms "this export is based on a SHOPLINE export taken today") rather than any hard-coded time window, per the master instruction's own directive. [**Proposed**]
- **Decision owner:** Opak product owner (must approve the attestation UX and, eventually, any time-based policy). **Stop until decided:** **Yes** — production rollout must not proceed without this gate; see §18/§19.

### G5. Eight-field review breadth: "partial" (assumed and confirmed, but narrower than an earlier draft of this plan claimed)

- **Claims:** Master instruction's own hypothesis: "the inspected runtime review UI does not expose every SEO/keyword field written by export" (implying partial coverage). An earlier draft of this plan over-corrected to "zero of the eight fields are exposed anywhere in the review UI... a completely separate model" — that was wrong. Direct inspection of `deliverBulkForm` (`apps/web/lib/delivery-service.ts:494-566`) shows it maps `nameZh`/`summaryEn`/`summaryZh` straight from `content.title`/`content.description`, which **are** among the 16 fields the review UI already edits. Only `content.seo.title`, `content.seo.description`, and `content.tags` (backing the other 5 fields: `seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`) pass through unreviewed.
- **Evidence:** §1, §5 (`/listings/[id]`), §7 raw citations (subagent 3), and this correction's own direct read of `delivery-service.ts:494-566`.
- **Consequence:** smaller than either the master instruction's hypothesis or this plan's own earlier draft assumed. This is a UI-completeness gap — expose and evidence-back 3 fields (`seo.title`, `seo.description`, `tags`) — not a missing subsystem requiring a parallel review mode.
- **Resolution:** extend the existing `listing-fields-form.tsx`/`listing-review-client.tsx` with SEO-title, SEO-description, and keywords fields sourced from `content.seo`/`content.tags`, reusing the exact same version-concurrency/audit/approval machinery already in place (§9 ADR-8, §11). [**Proposed**]
- **Decision owner:** runtime tech lead. **Stop until decided:** No, but re-scope estimates in any downstream planning to reflect this correction — Package G is materially smaller than originally drafted.

### G6. Workbook format: inline-string worry (assumed) vs. sheet-name mismatch (confirmed)

- **Claims:** Master instruction worried the runtime's inline-string XLSX writer might not match a genuine SHOPLINE export. Confirmed: the real export **also** uses inline strings with no shared-strings table — that part matches. What does **not** match is the sheet name: the writer hardcodes `"Sheet1"` (`bulk-form-xlsx.ts:316`) while the real export's sheet is named `"Default"`.
- **Evidence:** §1, §2, §11.
- **Consequence:** if SHOPLINE's own bulk-update importer validates the sheet name (unknown — genuinely unverifiable from this codebase), every generated export would fail re-import silently or loudly, with zero existing test coverage to catch it.
- **Resolution:** change the hardcoded literal to `"Default"` (a one-line, low-risk fix) and add a UAT step (§18) that specifically verifies SHOPLINE accepts a generated file's sheet name. [**Proposed**]
- **Decision owner:** runtime tech lead (the code fix); Opak product owner (confirms UAT passes). **Stop until decided:** **Yes for production export** — do not ship the export feature until this is UAT-verified; the code fix itself can land immediately as a no-risk change.

### G7. Variant ID gating: assumed blocker vs. confirmed non-blocking warning

- **Claims:** Master instruction: "A non-empty Variant ID must block this Opak pilot until a real variant contract and round trip are validated." Confirmed: `parseRow` treats a non-empty Variant ID as a warning only; the row is processed normally, and no downstream file gates on it at all.
- **Evidence:** §1, §11.
- **Consequence:** any product row with a variant currently flows through the full pipeline (enrichment, review, export) with no real block — directly contradicting an explicit pilot-safety requirement in the master instruction.
- **Resolution:** add an explicit hard block (not just a warning) wherever a non-empty Variant ID is detected, until variant support is separately validated. [**Proposed**, urgent]
- **Decision owner:** runtime tech lead. **Stop until decided:** **Yes** — this must be fixed before any real Opak data (which may contain variant rows) is processed in a live pilot.

### G8. Two overlapping master-instruction documents on the same repo

- **Claims:** This plan fulfills the Catalog Operations OS master instruction (adopt Site IA). A separate, still-live Frontend Revamp master instruction (v2.0, `docs/product/Wukong_Ecommerce_OS_Product_Frontend_Revamp_ChatGPT_Master_Instruction.md`, dated 26 Aug 2026) targets overlapping surface (auth layout, dashboard, review UI) with its own 25 findings and its own required baseline artifacts.
- **Evidence:** §2, §7 (subagent 5).
- **Consequence:** if both are executed independently without coordination, they could produce conflicting ADRs or duplicate work on the same components (e.g., both touch the review UI's "background choice" defect and the dashboard's hard-coded-identity finding).
- **Resolution:** before Package B (§16) begins, reconcile the two documents' overlapping scope explicitly — likely by treating the Frontend Revamp instruction's 25 findings as additional inputs to this plan's §7/§19 rather than a fully separate execution track. [**Proposed**]
- **Decision owner:** whoever owns both documents (**Unverified** — likely the same person who authored both, but not confirmable from repo evidence alone). **Stop until decided:** **Yes**, before any implementation PR that touches auth layout, dashboard, or review UI — to avoid two uncoordinated efforts colliding.

### G9. Dual role-enforcement mechanisms

- Covered fully in §3/§6 (Refactor-in-place disposition). **Decision owner:** runtime tech lead. **Stop until decided:** No — low-risk mechanical fix, not a blocker.

### G10. CSRF/secure-cookie configuration unverifiable

- **Claims:** No explicit CSRF/secure-cookie configuration exists in application code; behavior depends entirely on Better Auth's defaults, which are not inspectable from this repo (package not present in a resolvable `node_modules`).
- **Consequence:** cannot state with confidence that CSRF protection or secure-cookie attributes meet the master instruction's explicit security requirements (§9's authentication list).
- **Resolution:** verify Better Auth's actual defaults directly (read the installed package version's source, or its changelog/docs for the pinned version) as a Package C task, and add explicit `trustedOrigins`/cookie-attribute configuration if the defaults are insufficient. [**Proposed**]
- **Decision owner:** runtime tech lead. **Stop until decided:** **Yes for production** — this must be confirmed, not assumed, before the auth work in Package C is called complete.

### G11. `/listings/new` wiring to Bulk Update import — resolved

- **Confirmed** (§5): the route renders only the original photo/PDF intake flow; the Bulk Update import API exists, is tested, and is wired to no UI at all. No longer a stop condition — the fix is additive (new tab + move existing flow to a disabled tab), not a foundation risk.
- **Decision owner:** runtime tech lead. **Stop until decided:** No — proceed directly to building it in Package E.

### G12. Batch wave-size cap (1–5) enforcement location unconfirmed

- Covered in §5 (`/batches`). **Decision owner:** runtime tech lead. **Stop until decided:** **Yes for production** — the master instruction explicitly requires backend enforcement, not UI-only; must be confirmed or added before Opak UAT (§18).

### G13. `/admin` Site-side stuck-loading anomaly

- **Claims:** the live Site's `/admin` route never rendered its content during this audit's crawl session.
- **Consequence:** none for the runtime (this is purely a Site-side observation) — but it means this plan's "Site inventory" for `/admin`'s 4th tab concept rests on inspecting inert markup, not a live render.
- **Resolution:** a human should interactively re-check the Site's `/admin` route before this plan's "System Truth" tab concept (§9 ADR-11) is treated as fully understood. [**Proposed**]
- **Decision owner:** whoever owns the Site repo. **Stop until decided:** No — doesn't block runtime work, only refines the Site-side reference.

---

## 8. Target information architecture and component ownership

**Tokens and ownership (extends existing plain CSS, §4, §6):** add the confirmed Site custom properties (`--canvas: #f6f4ef`, `--navy: #17324d`, `--text: #182432`, `--border: #dfe2e1`, `--muted: #5f6e7b`, plus the CTA/hover/active-accent trio, currently inline Tailwind-style in the Site but which should become real CSS custom properties in the runtime's own `globals.css` rather than inline literals) to the existing CSS-custom-property system already in `apps/web/app/globals.css`. Card radius should be a single named token (e.g. `--radius-card: 16px`) rather than inherited from an unrelated framework default, since the runtime has no Tailwind dependency to inherit it from in the first place.

**Shared page shell / route layout boundaries:** `apps/web/app/(app)/layout.tsx` already exists as the authenticated shell and already performs role-aware nav gating (§3) — extend it with the Site's confirmed nav structure (7 items + admin + system-map) rather than creating a second shell.

**Role-aware navigation:** the shell should hide/show nav entries based on `roleOrder`, consistent with the existing `requireWorkspaceRole` mechanism — not a new, separate visibility system.

**Session-derived workspace/operator identity:** already correctly server-derived (§3) — no change needed to the mechanism, only to what's rendered (avoid hard-coding "Opak Cellar" anywhere in shared shell copy; the Frontend Revamp master instruction's finding #1 already flags this exact issue, corroborating this independently, §7 G8).

**Workspace-specific Opak/pilot labels from configuration:** extend `workspaces.profile`/settings (already a jsonb column per §3) rather than hard-coding merchant-specific copy into shared components.

**Loading/empty/error/stale/conflict/retry states:** none of the new routes (`/queue`, `/jobs`, `/quality`, `/batches` read, `/system-map`) currently have any state handling to reuse — each must be built with all six states from the start, following the pattern already used correctly in the existing review UI's stale-version 409 handling (§3) as the template for "conflict" states specifically.

**Accessible drawer/dialog/table/card patterns:** the Site's confirmed mobile pattern (sidebar → bottom-nav collapse at the `lg` breakpoint, plus a hamburger drawer revealing the full nav) should be adopted as the responsive pattern; the runtime has no existing drawer component to reuse, so this is new, plain-CSS-based work (§9 ADR-3).

**Desktop/375px acceptance captures and visual-regression scope:** every route in §5 needs both viewports captured at minimum; routes marked Partial or Missing need before/after captures once built.

**Skip link:** **[Unverified]** whether the current authenticated shell (`apps/web/app/(app)/layout.tsx`) has a skip link — no subagent was asked to check this specifically. Add one if confirmed missing, per master instruction §7's explicit accessibility requirement.

---

## 9. Proposed ADRs

All twelve marked **Proposed**. Decision owners are roles (runtime tech lead / Opak product owner), not named individuals, per this plan's own constraint against inventing personnel.

### ADR-1: Site-to-runtime adoption and anti-rewrite strategy

- **Context:** the Site is UX/IA reference only, with no working backend (§4); the runtime has a mature, mostly-correct backend (§3) but a stale/incomplete frontend relative to the Site's IA.
- **Decision:** adopt the Site's layout, IA, copy, and design tokens into the existing Next.js/plain-CSS runtime; never port the Site's own code, never introduce Tailwind/shadcn into the runtime.
- **Alternatives considered:** rebuild the frontend from the Site's codebase directly (rejected — would require introducing Tailwind/shadcn and abandoning working, tested runtime components); leave the frontend as-is and only fix backend gaps (rejected — the master instruction explicitly requires IA adoption).
- **Consequences:** more translation work up front (manually re-implementing Site layouts in plain CSS) but zero risk of regressing working backend logic.
- **Compatibility:** fully backward compatible — existing routes keep working throughout.
- **Security effect:** none directly; indirectly reduces risk by not introducing a second styling framework's attack surface (e.g. Tailwind's arbitrary-value class injection surface, however small).
- **Migration path:** route-by-route, per §16's package sequence.
- **Reversal trigger:** if plain-CSS translation of the Site's more complex components (e.g. the review diff layout) proves substantially more expensive than expected, revisit component-by-component (not wholesale) adoption of a scoped CSS utility layer — but this would be a narrow, evidenced exception, not a default.
- **Decision owner:** runtime tech lead.

### ADR-2: Route ownership and backward-compatible IA

- **Context:** `/listings/new`'s current wiring is unconfirmed (§5, §7 G11). The Site's own IA (§5) uses a single route with a 3-tab layout — Existing products (primary, confirmed) / Supporting evidence / New products (explicitly "Blocked — separate Create template required") — rather than separate routes per flow.
- **Decision:** confirm current wiring first (Package E task); adopt the Site's one-route/3-tab IA as-is, keeping the New-products tab disabled/blocked for this pilot per master instruction §9. Preserve any existing deep links via redirect if the confirmation task finds the current page already serves a different, incompatible shape.
- **Alternatives:** split into two separate routes, one for Bulk Update import and one for new-product creation (rejected — the Site's own design deliberately keeps them as tabs within one route, and there's no evidence a split serves the pilot better).
- **Consequences:** matches the Site's already-designed IA with minimal structural change.
- **Compatibility:** depends on confirmed current wiring (§7 G11) — must be resolved before this ADR can be finalized.
- **Security effect:** none.
- **Migration path:** Package E.
- **Reversal trigger:** if the wiring-confirmation task reveals `/listings/new` already serves a different, incompatible purpose that can't be safely tabbed.
- **Decision owner:** runtime tech lead.

### ADR-3: Plain-CSS design tokens and component reuse

- **Context:** §8.
- **Decision:** add the confirmed Site tokens as real CSS custom properties in `apps/web/app/globals.css`; build new responsive/drawer patterns in plain CSS, matching the runtime's existing approach.
- **Alternatives:** a scoped CSS-in-JS or utility-class layer (rejected — deviates from the existing, working plain-CSS convention for no functional benefit).
- **Consequences:** consistent styling approach repo-wide; some manual translation effort for the Site's more complex responsive patterns.
- **Compatibility:** additive, no breaking change to existing pages.
- **Security effect:** none.
- **Migration path:** Package B.
- **Reversal trigger:** none anticipated.
- **Decision owner:** runtime tech lead.

### ADR-4: zh-HK/English localisation architecture

- **Context:** the Site's i18n is a stateless, non-persistent, in-memory locale toggle with inline `t(zh,en)` call sites (§4) — genuinely reasonable for a design-reference Site, but not adequate for a real product (no persistence, reverts on every navigation).
- **Decision:** the runtime should implement locale persistence via an approved cookie/user preference (master instruction §12), keeping the Site's simple `t(zh,en)` inline-call-site pattern for translation itself (it's not wrong, just needs a persistence layer added) rather than introducing a full i18n framework/library.
- **Alternatives:** adopt a full i18n library (e.g. next-intl) with message catalogs (rejected as unnecessary complexity for a two-locale, inline-string-based system that already works acceptably at the Site-reference level); keep the Site's exact non-persistent behavior (rejected — master instruction explicitly requires persistence).
- **Consequences:** modest new code (a cookie-backed locale preference + provider), no new dependency.
- **Compatibility:** additive.
- **Security effect:** cookie must be validated/sanitized (only two valid values) to avoid any injection surface, however minor.
- **Migration path:** Package B.
- **Reversal trigger:** none anticipated.
- **Decision owner:** runtime tech lead.

### ADR-5: Public landing/auth/protected-app boundary

- **Context:** `/`, `/signin`, `/pilot` boundary is explicitly called out in the master instruction as needing an explicit decision, particularly to avoid duplicating the separate `wukong-ops-suite` public marketing app (§2, §5 `/pilot`).
- **Decision:** `/` and `/signin` remain part of this runtime (already functional, low risk, §5); `/pilot` ownership is **not decided in this plan** — it requires the decision owner named in §21 to confirm whether `wukong-ops-suite` already covers this content before any `/pilot` route is built here.
- **Alternatives:** build `/pilot` here regardless (rejected until ownership is confirmed — risk of duplicating a marketing surface).
- **Consequences:** `/pilot` work is blocked, not merely deprioritized, until this is resolved.
- **Compatibility:** N/A (new route).
- **Security effect:** none.
- **Migration path:** blocked, see §21.
- **Reversal trigger:** N/A.
- **Decision owner:** product/marketing owner (outside this plan's scope to name more specifically).

### ADR-6: Workspace-derived identity and tenant-specific Opak policy

- **Context:** shared shell copy risks hard-coding "Opak Cellar" (§8, corroborated independently by the separate Frontend Revamp instruction's finding #1, §7 G8).
- **Decision:** all merchant-specific copy (workspace name, Opak-specific labels, claim-policy rules) must be read from `workspaces.profile`/settings, never hard-coded in shared shell/nav components.
- **Alternatives:** leave Opak-specific copy hard-coded since Opak is currently the only tenant (rejected — directly contradicted by an already-identified defect in a sibling planning document).
- **Consequences:** small refactor of any currently-hard-coded shell copy.
- **Compatibility:** additive/refactor, no behavior change for the existing single tenant.
- **Security effect:** none.
- **Migration path:** Package B.
- **Reversal trigger:** none anticipated.
- **Decision owner:** runtime tech lead.

### ADR-7: Page view models and API contracts

- **Context:** several existing endpoints (catalog, listings list) return data shapes that omit fields the DB actually has (`createdAt`/`updatedAt`/`contentDigest` omitted from `CatalogItem`, §3, §5).
- **Decision:** extend existing view-model types rather than replacing them; add fields additively so existing consumers don't break.
- **Alternatives:** introduce a new, parallel API version (rejected — unnecessary given additive extension is safe here).
- **Consequences:** minor type changes across `catalog-contract.ts` and its consumers.
- **Compatibility:** additive.
- **Security effect:** ensure no newly-exposed field leaks cross-workspace data — covered by existing RLS regardless (§3).
- **Migration path:** Package D.
- **Reversal trigger:** none anticipated.
- **Decision owner:** runtime tech lead.

### ADR-8: Bulk Update import-session, digest, diff, review and export architecture

- **Context:** the core architectural decision of this whole plan — how the eight-field review (§7 G5) and the freshness gate (§7 G4) get built. Corrected from an earlier draft: `nameZh`/`summaryEn`/`summaryZh` are already reviewed via the existing `title`/`description` fields; only `seo.title`, `seo.description`, and `tags` need new review surface.
- **Decision:** extend the existing `listing-fields-form.tsx`/`listing-review-client.tsx` with SEO-title, SEO-description, and keywords fields (sourced from `content.seo`/`content.tags`, with evidence), rather than building a second, parallel review mode — reusing the exact same version-concurrency and audit machinery already in place (§6).
- **Alternatives:** build a fully separate review mode/component for all 8 fields, duplicating the 3 already-reviewed ones (rejected — unnecessary duplication now that the actual mapping is confirmed; would confuse operators with two places to edit the same title/description content); build an entirely separate app/service (rejected — unnecessary duplication of auth/RLS/audit machinery that already works).
- **Consequences:** a targeted extension of the existing review UI — three new fields plus evidence/diff display for them — not a new UI surface. Materially smaller than this plan originally estimated; re-scope Package G's size accordingly (§16).
- **Compatibility:** additive — existing wine-listing review is untouched.
- **Security effect:** must inherit the same RLS/role/audit guarantees as the existing review UI — no new security model to invent.
- **Migration path:** Package G, gated on Package E (freshness gate).
- **Reversal trigger:** none anticipated (this is core scope, not an experiment).
- **Decision owner:** runtime tech lead + Opak product owner (joint — this defines the operator's actual workflow).

### ADR-9: Workbook preservation versus minimal XLSX generation

- **Context:** master instruction §11 requires comparing (1) patching the fresh `Default` workbook in place, preserving its package structure/styles/validations, vs. (2) continuing deterministic minimal generation (the current approach) only after real SHOPLINE UAT proves zero identifier/numeric-format damage.
- **Decision (Proposed, pending UAT evidence, §18):** continue with deterministic minimal generation for now (fix the sheet-name bug, §7 G6), since the current generator already demonstrates strong correctness guarantees (no numeric coercion, exact header match, §11) — but this decision is explicitly conditional on the sheet-name-fixed version passing real SHOPLINE UAT (§18). If UAT reveals SHOPLINE rejects the minimal-generation approach for reasons beyond the sheet name, switch to workbook-patching as the fallback.
- **Alternatives:** patch the real workbook now, before UAT (rejected — significantly more complex, unjustified without evidence the minimal approach fails).
- **Consequences:** UAT (§18) becomes the actual gating decision point, not this document.
- **Compatibility:** N/A until UAT.
- **Security effect:** workbook-patching would need to defend against formula-injection in preserved cells (§15) if ever adopted — noted as a future consideration, not applicable to the current minimal-generation approach (which never preserves formulas).
- **Migration path:** contingent on §18.
- **Reversal trigger:** SHOPLINE UAT failure on the minimal-generation approach for reasons other than the sheet name.
- **Decision owner:** Opak product owner (owns the UAT go/no-go).

### ADR-10: Batch/job/quality read models

- **Context:** three missing read models (§5 `/batches`, `/jobs`, `/quality`) share a common shape (list + detail over an operational entity).
- **Decision:** build a shared "operational ledger" read-model pattern (paginated list + detail, consistent status vocabulary) once, and instantiate it three times, rather than three bespoke implementations.
- **Alternatives:** three independent implementations (rejected — unnecessary duplication given the shared shape).
- **Consequences:** slightly more upfront design work, less duplicated code.
- **Compatibility:** additive.
- **Security effect:** each instantiation must independently apply workspace-scoped RLS — the shared pattern must not weaken this per-entity.
- **Migration path:** Package F/I.
- **Reversal trigger:** none anticipated.
- **Decision owner:** runtime tech lead.

### ADR-11: Capability registry, feature flags and truthful states

- **Context:** `/admin`'s proposed 4th tab and `/system-map` both need a single source of truth for Live/Pilot/Planned/Blocked capability state (§5, §8); the Site's own `/system-map` claims should not be trusted as that source (§5).
- **Decision:** build one capability-registry data source (could be as simple as a small config table or a typed constant list reviewed alongside code changes) consumed by both `/admin`'s tab and `/system-map`, keeping `SHOPLINE_PUBLISH_ENABLED=false` visible and enforced as one of its entries.
- **Alternatives:** two independent implementations (rejected, duplicated truth-source risk); a fully dynamic runtime-introspection system (rejected as overkill for the current scale).
- **Consequences:** a new, small, shared module.
- **Compatibility:** additive.
- **Security effect:** must not leak infrastructure details (e.g. real Cloudflare resource names, §15) through this registry — capability state only, no configuration values.
- **Migration path:** Package I.
- **Reversal trigger:** none anticipated.
- **Decision owner:** runtime tech lead.

### ADR-12: Rollout, reconciliation and rollback

- **Context:** the master instruction's UAT staging (1–5 → 30–50 → 50–100 → catalog-scale, §11, §18) needs an explicit rollback story at each stage.
- **Decision:** every stage's rollback is "stop importing/enriching, existing approved-and-delivered listings remain untouched, no automatic reversal of already-completed SHOPLINE writes" — consistent with the existing production-readiness runbook's rollback philosophy (§3, subagent 5 findings on `production-readiness.md`).
- **Alternatives:** an automated rollback that reverts already-written SHOPLINE products (rejected — SHOPLINE writes require separate authorization and reversing them automatically is out of scope and risky).
- **Consequences:** rollback is operationally simple (stop the pipeline) but does not undo committed merchant-facing changes — this must be communicated clearly to Opak.
- **Compatibility:** N/A.
- **Security effect:** none.
- **Migration path:** applies at every stage of §18.
- **Reversal trigger:** N/A (this is the reversal plan itself).
- **Decision owner:** Opak product owner (must accept this rollback model before UAT begins).

---

## 10. Data model, API, RLS and audit contracts

Chain: `UI → endpoint/method → minimum role → Zod request/response → domain service → repository → queue (if any) → audit event → idempotency/version key`.

**Existing endpoints inventoried (reuse before proposing anything new):**

| Action                                        | Endpoint                                                                                                                   | Role                                                      | Service/Repo                                | Audit                                       | Idempotency                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Presign/finalize asset                        | `POST /api/assets/presign`, `/finalize`                                                                                    | operator+                                                 | asset store + `source_assets` repo          | `asset.finalized`                           | workspace-prefixed storage key                |
| Auth (password/magic-link/invite/recovery)    | `/api/auth/*`                                                                                                              | public/none                                               | Better Auth + `auth-flow.ts`                | auth events                                 | eligibility-function-gated, generic responses |
| Catalog read                                  | `GET /api/catalog`                                                                                                         | viewer+                                                   | `platform-products.ts:listRecent`           | none (read-only)                            | N/A                                           |
| Listing list/create/read                      | `/api/listings`, `/api/listings/[id]`                                                                                      | viewer+/operator+                                         | `listings.ts`                               | `listing.created` etc.                      | version-id keyed                              |
| Listing process                               | `/api/listings/[id]/process`                                                                                               | operator+                                                 | pipeline                                    | pipeline audit                              | queue lease `listing:<ws>:<draft>:<seq>`      |
| Listing review (edit)                         | `PUT /api/listings/[id]/review`                                                                                            | operator+/reviewer+ (array-allowlist, §7 G9)              | `editReview`                                | `listing.edited` ×2                         | `baseVersionId` optimistic concurrency        |
| Flag resolve                                  | `POST /api/listings/[id]/flags/resolve`                                                                                    | reviewer+ (array-allowlist)                               | `resolveFlag`                               | `compliance.flag_resolved`                  | `versionId` optimistic concurrency            |
| Approve / bulk-approve                        | `/api/listings/[id]/approve`, `/api/listings/bulk-approve`                                                                 | reviewer+ (array-allowlist)                               | `approveOne`/`promoteAndApprove`            | `listing.approved` ×3, `listing.transition` | version-id, double-checked                    |
| Deliver (CSV/API/bulk-form)                   | `/api/listings/[id]/deliver`                                                                                               | reviewer+ (array-allowlist)                               | `delivery-service.ts`                       | delivery audit                              | publish-job idempotency key                   |
| XLSX import                                   | `bulk-form-import.ts` (invocation route **unconfirmed**, §7 G11)                                                           | operator+ (assumed)                                       | `bulk-form.ts`/`bulk-form-import.ts`        | import audit (on refresh only, §3)          | `contentDigest` comparison                    |
| Enrichment batch create/advance               | (route names not directly captured by subagents; confirmed to exist per `enrichment-batch-service.ts` and its design docs) | operator+ (assumed)                                       | `enrichment-batch-service.ts`               | **[Unverified]**                            | **[Unverified]**                              |
| Compliance resolution                         | see flag resolve above                                                                                                     | —                                                         | —                                           | —                                           | —                                             |
| Workspace members/invites/settings/connection | `/api/workspace/*`                                                                                                         | admin (consistently `requireWorkspaceRole("admin", ...)`) | `memberships.ts`, connection/settings repos | membership audit                            | N/A                                           |

**Gaps to close (new contracts, per master instruction §10):**

- `GET /api/catalog` — add pagination (`cursor`/`limit`), `q` search param, cohort filter, and source-freshness/eligibility fields in the response (§7 G-none directly, but §5/§6 `/catalog`).
- `GET /api/batches`, `GET /api/batches/[id]` — list/detail read contract (§5/§9 ADR-10).
- `GET /api/jobs` — ledger read contract spanning import/batch/export/manual-SHOPLINE-confirmation (§5/§9 ADR-10).
- `GET /api/quality` — read contract over `ai_runs`/`field_evidence`/edit-distance (§5/§9 ADR-10).
- `POST /api/listings/bulk-export` (name Proposed) — multi-product changed-row XLSX (§11).
- `POST /api/listings/[id]/shopline-import-result` (name Proposed) — manual SHOPLINE import-result recording/reconciliation (§11, §18).
- Source-import freshness/fingerprint enforcement — a new domain-service function (name Proposed: `assertExportFreshness`) called from the export endpoint before any file is generated (§11).

**Schema-change discipline (per any of the above that need new columns/tables):** expand/contract migration strategy, explicit indexes/uniqueness, RLS policy + cross-workspace negative test, backfill/default semantics, compatibility window, audit behavior, rollback — each new table (e.g. a `batches`/`jobs` read-model table if not already covered by existing schema) must specify all of these in its own implementation PR, not deferred to "later."

---

## 11. Opak 71-column Bulk Update contract

**Confirmed workflow language (per master instruction, now cross-checked against real code, §7 G3–G7):** Fresh SHOPLINE export → import immutable snapshot → choose content-gap cohort → attended AI enrichment → evidence/diff review → approval → changed-row XLSX → manual SHOPLINE import → import confirmation and reconciliation. **Never label XLSX generation as "published"** — the runtime already keeps these conceptually separate (no code path conflates them), but no UI currently surfaces either state distinctly since the `/jobs` ledger doesn't exist yet (§7 G2).

**Field classification — fully confirmed against the real workbook, exact match, zero discrepancies:**

- **10 locked fields**, echoed verbatim: `productId, quantity, variantId, variantEn, variantZh, variantQuantity, slStockId, warehouse, slKey0, slKey1` — `BULK_FORM_LOCKED_COLUMNS`, `packages/shopline/src/bulk-form.ts:251-262`.
- **8 AI-writable fields**: `nameZh, summaryEn, summaryZh, seoTitleEn, seoTitleZh, seoDescriptionEn, seoDescriptionZh, seoKeywords` — `BULK_FORM_ENRICHABLE_COLUMNS`, `bulk-form.ts:270-279`. `nameEn` correctly excluded (Opak identity/search handle, per code comment).
- **2 neutral-only stock deltas**: `updateQuantity, updateVariantQuantity` — `QUANTITY_DELTA_COLUMNS`, `bulk-form.ts:292-295` (module-private).
- **51 pass-through fields** — everything else, correctly never AI-written (confirmed: no code path writes to any of the 51 outside the export echo).

**Important nuance not previously documented anywhere in the repo:** the locked/pass-through distinction is not separately enforced at runtime — both classes are treated identically (echo original value, reject any write attempt with the same error code). This is functionally correct (locked fields are never writable either way) but means `BULK_FORM_LOCKED_COLUMNS` is presently vestigial — exported but unused outside its own test. **[Proposed]** no code change is required (behavior is already correct), but this should be documented in code as intentional, not left to look like dead code.

**Workbook invariants — status against master instruction's checklist:**

- Full ordered bilingual header contract: **Confirmed exact match** (§2, §11 above).
- Sheet identity/header rows/data start row/cell types: **Confirmed structure matches** (`Default`, rows 1-2 headers, row 3+ data, inline strings) — **except** the generated file's sheet name (`"Sheet1"`, §7 G6), which is the one confirmed, previously-unflagged mismatch.
- Identifiers preserved as strings (leading-zero SKU/Barcode, alphanumeric/blank Barcode): **Confirmed** — structural guarantee, no `Number()`/`parseInt` anywhere in the read/write path.
- Blank/null/`0`/`0.0`/`+0` preserved as distinct raw states: **Confirmed for 61 of 71 columns** (locked + pass-through); **the 2 delta columns are a deliberate, documented exception** — any non-null value collapses to literal `"+0"` on export (§7's raw findings, subagent 4 finding #11).
- Sale Price `0`/`0.0` treated as "no sale," raw cell preserved on pass-through: **[Unverified]** — no subagent traced this specific downstream interpretation logic; flag as a task-11 verification item.
- Raw inventory `-1` and literal `無限數量` preserved, normalized interpretation shown separately, never export normalized `0` over raw source: **[Unverified]** — not directly traced by any subagent; `unlimitedQuantity` is read as a flag (`parseRow:694`) but whether the raw pass-through preserves `無限數量` verbatim on export specifically (vs. just being covered by the general blank/pass-through preservation rule) needs direct confirmation.
- Multi-path category cells and in-cell newlines preserved: **[Inferred]** — `onlineStoreCategories` is parsed (`parseRow:745-757`) and is a pass-through column, so it should be preserved verbatim by the same general rule as other pass-through columns, but this specific case (multi-path with `>` delimiter and possible embedded newlines) was not separately spot-tested by any subagent.
- Cost fields excluded from AI prompts: **Confirmed** — `bulk-form-source.ts:19-22`'s `SourceColumn` type explicitly excludes `productCost`/`variantCost` and all 8 enrichable columns from the AI-facing source render.
- Product Summary ≠ full Product Description: **Confirmed by field naming and scope** — `summaryEn`/`summaryZh` are the only summary-adjacent enrichable fields; no separate "description" field exists in the Bulk-Update contract at all (consistent with the master instruction's own framing).
- No Images field in the Bulk Update form: **Confirmed** — no image-related column exists anywhere in the 71-column contract, and subagent 7's live crawl confirmed the Site's own `/listings/[id]` review UI shows "no image change exists in this Bulk Update file" as an explicit confirmation-ledger item.
- Non-empty Variant ID must block: **NOT currently true** (§7 G7) — this is the plan's most urgent code-level fix.
- Listing must have a `platform_products` remote Product ID link to be Bulk-Update-eligible: **Confirmed as the data model's actual shape** (§3) — `platform_products.origin` distinguishes `import` vs `created`, and only `import`-origin rows carry the SKU/spec-version/raw-row/digest data the Bulk Update flow needs.

**Immutable source-import and freshness gate — status: data model exists, enforcement function does not (§1, §7 G4).** The durable record (`platform_products`: `specVersion`, `rawRow`, `contentDigest`, timestamps) has everything except an explicit merchant-attested SHOPLINE export timestamp and importer/import-timestamp fields as distinct concepts (currently conflated with `createdAt`/`updatedAt`). **Proposed:** add an explicit `sourceImportId` entity (a new table or a repurposed existing one — **Unverified** whether one already exists under a different name; a direct schema-wide search for "import" in `schema.ts` beyond `platform_products` was not performed by any subagent and should be a Package E task before assuming a new table is needed) binding `workspaceId + shoplineConnectionId + filename + workbookSha256 + headerContractSha256 + sheetName + rowCount + merchantAttestedExportTimestamp + importerUserId + importTimestamp + specVersion + ordered row digests`. Bind every batch item/version/review/approval/export manifest to `sourceImportId + remoteProductId + sourceRowDigest + activeVersionId`. At export, block unless: source freshness satisfies an attended attestation (not a hard-coded threshold, §7 G4); active version equals reviewed version; stored digest equals reviewed digest; header fingerprint/spec version match; workspace/connection/source-contract compatibility; a fresh SHOPLINE export was imported immediately before UAT generation specifically (a UAT-only rule, not a production rule).

**Review confirmation and invalidation — status: version-concurrency exists, field-specific confirmation ledger does not (§1, §7 G5).** Proposed atomic approval request: `{expectedVersionId, sourceImportId, expectedSourceRowDigest, confirmationLedgerRevision}` — directly extends the existing `versionId`-checked approval pattern (§3, §10) with two more required-match fields. The confirmation ledger itself must cover, per field, before/after/evidence for each of the 8 fields, plus the negative confirmations (prices/membership/category/status/supplier/stock unchanged, both deltas neutral, no image change) — the Site's `/listings/[id]` review UI already demonstrates the intended shape of most of these confirmations visually (§5), giving a concrete UI target. Invalidate approval on any content/evidence/AI-output/version/digest change; a same-digest re-import may preserve approval only with a fresh freshness attestation recorded.

**Multi-product changed-row XLSX — status: does not exist (§7 G3).** Must: emit the same 2 header rows; include only products with ≥1 approved change; include all 71 cells per included product; restrict differences to the 8 whitelisted cells; prove the 10 locked + 51 pass-through cells are byte-identical to the fresh source; neutralize the 2 delta cells (already implemented correctly for single-row export, §11 above — reuse the same neutralization logic); exclude and report no-op products; reject mixed source contracts/stores/stale rows; produce a manifest (product count, changed-cell counts per field, excluded rows, neutralized deltas, source/output digests, version IDs); reparse the generated workbook before download and assert every invariant. **ADR-9 governs whether this patches the fresh workbook or continues minimal generation** — recommend minimal generation (matching the existing single-row approach) pending UAT evidence either way.

**Opak UAT and go/no-go (per master instruction §11, unchanged — backend enforcement required, not UI-only):**

1. Attended contract UAT: 1–5 products — **this is the first real-world test of the sheet-name fix (§7 G6) and the Variant ID hard-block (§7 G7); both must land before this stage begins.**
2. Golden set: 30–50 products.
3. Shadow pilot: 50–100 products, two weeks, manual import only.
4. Catalog-scale rollout only after written Opak sign-off.

Acceptance requires (unchanged from master instruction, restated for completeness): 100% header/workbook acceptance; 100% intended-row import success with any partial success explicitly reconciled; zero identifier coercion; zero locked/pass-through changes; zero unintended stock/price/status/category/supplier changes; exactly the approved 8-field changes; complete audit evidence; a tested rollback source file. Production remains **No-Go** if any source/workbook/digest/approval/locked-field/delta/identifier/variant/compliance/partial-import/rollback/authorization gate is unresolved — and per this audit, several of those gates (freshness, Variant ID, sheet name) are currently unresolved, confirming the §1 verdict.

Keep preview on `SHOPLINE_ADAPTER=mock` and production on `SHOPLINE_ADAPTER=disabled`/`SHOPLINE_PUBLISH_ENABLED=false` throughout — confirmed already enforced and unoverridable by the renderer (§3, subagent 5's `production-ai-runtime.md` finding). Real SHOPLINE writes require separate written authorization outside this plan, unchanged.

---

## 12. Authentication and public-entry plan

**Ownership (ADR-5):** `/` and `/signin` stay owned by this runtime — both are already functional and low-risk to restyle (§5). `/pilot` is **blocked** pending the decision owner in §21 confirming it doesn't duplicate `wukong-ops-suite`.

**Reuse:** Better Auth configuration, invite-only eligibility (`auth_get_eligible_user`), mailer, and membership logic are all already correct and require no behavioral change (§3, §6) — only the surrounding layout/copy adopts the Site's two-panel design (§4), and only after stripping the Site's "prototype unavailable" banner and disabled-submit state, which must never reach the connected runtime (§7 G1).

**Security items, current state and required action:**

- Rate limiting: reuse existing (Better Auth default + custom 5-attempt/15-minute lockout, §3). No change needed.
- Redirect allowlisting: reuse existing `safeCallbackPath` (§3). No change needed.
- Session fixation/revocation: reuse existing revoke-on-reset and revoke-on-post-auth-failure paths (§3). No change needed.
- CSRF/origin protection and secure-cookie attributes: **must be verified, not assumed** (§7 G10) — a Package C task to read the pinned Better Auth version's actual defaults and add explicit `trustedOrigins`/cookie-attribute configuration if insufficient.
- Invitation-only enforcement: reuse existing server-side SQL-function gate (§3). No change needed.

**Never show fake success states** (login/registration/reset-email/pilot-submission) — the connected runtime already returns real, generic (enumeration-safe) responses for all of these (§3); adopting the Site's layout must not regress this into a decorative fake-success state.

---

## 13. Internationalisation plan

**Default locale:** `zh-HK`, matching both the Site's default and the master instruction's requirement.

**Mechanism (ADR-4):** add a cookie-backed locale preference read server-side on every request (so `html lang` and initial render are correct without a flash of the wrong locale), keeping the Site's simple inline `t(zh, en)` call-site pattern for the translations themselves rather than introducing a message-catalog library — the pattern already works and this plan found no defect in it beyond non-persistence.

**Set correctly on every route:** `html lang`, page metadata/titles, nav labels, actions, error/validation copy, empty states, live regions, ARIA labels. This applies to every route in §5, not just the ones being newly built — the existing `/signin`/`/dashboard`/`/catalog` pages' current locale behavior was **not directly verified** by any research subagent (§5 flags this per-route) and must be confirmed as part of Package B/C, not assumed correct because the Site's reference pages happen to be bilingual.

**Keep untranslated (never localize):** SHOPLINE headers, Product ID, SKU, Barcode, API paths, status keys, raw merchant evidence — already the pattern the Site itself follows for the review UI's field labels (§5 `/listings/[id]` — literal SHOPLINE column header kept in ZH with English description beneath, "by design, not a bug" per the live-crawl finding); replicate this exact pattern in the new eight-field review UI (§9 ADR-8).

**Avoid side-by-side duplicated bilingual UI copy** except where the product field itself is genuinely bilingual (e.g. the workbook's own paired EN/ZH header cells).

**Number/currency/date/time/timezone formatting:** not directly inspected by any subagent; add explicit formatting utilities (HKD currency, HK timezone for timestamps) as part of Package B rather than leaving this to ad-hoc per-component formatting.

**Testing:** missing-key fallback, content-expansion (Chinese text is often shorter than English — verify layouts don't break in the longer-English direction), and locale-persistence across navigation and reload.

**Revalidate the Site's locale-switch behavior claim precisely:** the master instruction's audit hypothesis said the Site's locale switch has "inconsistent" per-route behavior. This plan's own live crawl found something more specific: the switch is **consistently non-persistent** (a stateless in-memory toggle that reverts to `zh-HK` on every fresh navigation) rather than inconsistent between routes — every route behaved the same way. Use this more precise finding, not the original hypothesis, when scoping Package B's persistence work.

---

## 14. Accessibility, responsive and performance plan

**Target:** WCAG 2.2 AA, per master instruction §13.

**Landmarks, heading hierarchy, skip link:** **[Unverified]** across all existing routes — no subagent was tasked with an accessibility-tree audit of the current authenticated shell. This is a Package J task: audit `apps/web/app/(app)/layout.tsx` and every existing page for one logical H1, landmark regions, and a skip link; add what's missing (§8 already flags the skip link specifically as a likely gap per the master instruction's own suspicion).

**Keyboard navigation, visible focus, focus trapping/restoration:** the runtime has no existing drawer/dialog components to audit (none were found in scope) — this only becomes relevant once the new mobile drawer nav (§8, matching the Site's confirmed hamburger-drawer pattern) is built; build it with focus-trap/restoration from the start rather than retrofitting.

**Accessible tables/cards and selection controls:** `catalog-control-center.tsx`'s existing table/card responsive behavior was not accessibility-audited by any subagent; audit as part of Package D's catalog pagination work (touching the component anyway).

**Form instructions and associated inline errors:** existing auth forms (§3) already have real validation — confirm their error messages are properly associated (`aria-describedby` or equivalent) as part of Package C; not previously verified.

**Status live regions:** the review UI's existing stale-version 409 handling (§3) is a natural candidate for an `aria-live` region if it doesn't already have one — **[Unverified]**, check as part of Package G (already touching this component). Avoid excessive announcements — one live region per meaningfully distinct status change, not per keystroke.

**Contrast, reduced motion, 44px touch targets:** Site's confirmed design tokens (§4) appear high-contrast on inspection (navy-on-canvas, white cards on `#f6f4ef`) but were not formally contrast-ratio-tested by any subagent; touch-target sizing was not measured. Both are Package J verification tasks, not assumed-passing.

**Mobile safe areas, no horizontal overflow:** the Site's confirmed responsive pattern (sidebar → bottom-nav at `lg` breakpoint, §4) is a reasonable target; verify the runtime's plain-CSS implementation doesn't introduce horizontal scroll on any new route, especially the wide parity-matrix-style tables if any are rendered as tables rather than cards on mobile.

**Screen-reader names for icon-only actions:** the Site's hamburger/nav-toggle icons — **[Unverified]** whether they have accessible names in the Site source (not specifically checked); ensure the runtime's equivalent does, regardless of the Site's own state.

**Route loading/navigation feedback:** every new route (§5's Missing entries) needs an explicit loading state from the start (§8) — Next.js App Router's built-in loading/streaming conventions should be used consistently rather than ad-hoc per-page spinners.

**Performance budgets:** app shell, catalog (100+ row rendering once pagination is added), and the new eight-field review UI (likely the heaviest single page given evidence panels + diffs) should each have an explicit budget defined during their respective package's implementation, not retrofitted after the fact.

**Visual-regression scope:** every route in §5 needs desktop + 375px captures at minimum, both locales where the route renders locale-dependent content; routes changing disposition (extend/new) need explicit before/after captures.

---

## 15. Security, privacy, observability and audit plan

**Per-mutation treatment (already the runtime's existing pattern, §3/§10 — apply identically to every new mutation this plan proposes):** server-side role check via `requireWorkspaceRole` (not the array-allowlist pattern, per §6/§7 G9's refactor), workspace resolution via `forWorkspace`/RLS, Zod request/response validation, an audit event inside the same transaction as the mutation, and a version-id or idempotency-key check as appropriate. This applies specifically to: the new multi-product export endpoint (§10, §11 — needs its own idempotency key per export attempt, since re-running an export must not double-neutralize or double-charge anything), the manual-SHOPLINE-import-result recording endpoint (§10 — needs to be safely re-runnable if a merchant reports the same import result twice), and the freshness-gate check itself (a read-time assertion, not a mutation, but must run inside the same transaction as whatever it's gating to avoid a race between the check and the gated action).

**Cross-workspace/RLS negative tests:** the existing pattern (`repositories/memberships.integration.test.ts`'s cross-workspace assertion style, §3) should be replicated for every new tenant-scoped entity this plan introduces (batches read model, jobs ledger, quality read model, source-import records) — do not add a new table without an accompanying cross-workspace-denial test.

**XLSX MIME/signature/size/row validation:** already confirmed to exist for the import path (`upload_not_a_workbook` 400, `bulk_form_unreadable` 422, `bulk_form_too_many_rows` 413 at a 5,000-row cap — §3, `shopline-pilot-onboarding.md`). **[Unverified]** whether an explicit decompression-bounds/zip-bomb defense exists beyond the row cap — a Package E verification task, since the row cap alone doesn't necessarily bound decompressed memory use before the row count is even known.

**Formula-injection defence:** not currently applicable — the minimal-generation XLSX writer never preserves or writes formulas (§11). This becomes relevant **only if** ADR-9 is later revisited toward workbook-patching; note it there as a future requirement, not a current gap.

**Safe private-asset/presigned-URL handling:** already confirmed correct — workspace-prefixed storage keys, presign/finalize workspace-ownership checks (§3's asset intake pattern, referenced from the original file-map). No change needed.

**Log redaction:** `CLAUDE.md` states no credentials/signed-URLs/prompts/model-output/customer-content may appear in logs, enforced by a readiness gate (§3, subagent 5) — this must extend to any new logging added in Packages D–I (e.g. don't log full row contents when logging an import/export failure; log the digest/row-index instead).

**Correlation IDs:** propose a single correlation ID generated at import time and threaded through batch → review → export → manual-SHOPLINE-confirmation, surfaced in the new `/jobs` ledger (§10) — this is what makes "file generated" vs. "SHOPLINE import confirmed" distinguishable end-to-end, per master instruction §11's explicit requirement.

**Metrics:** stale-source rejections, version conflicts, partial-import counts, and retry counts should all be recorded (not necessarily a full observability platform — even structured audit-event counts suffice) as part of Package E/H, so the go/no-go criteria in §18 can be measured rather than eyeballed.

**Capability-truth telemetry:** the registry in ADR-11 must expose capability state only (Live/Pilot/Planned/Blocked) — never customer content, never raw configuration values.

---

## 16. File-level PR sequence and dependency graph

Ten packages, lettered to match the master instruction's own A–K skeleton (I is folded into the ledger/quality/admin work; there is no separate lettered package beyond what's listed — J and K remain distinct as hardening and rollout).

### Package A — Baseline and Opak contract freeze

- **Outcome:** repo state pinned and verified (already substantially done by this plan itself); fix the CI formatting failure (§2) as a trivial first commit.
- **Dependencies:** none.
- **Files:** none beyond a `prettier --write` pass on the newly-uploaded master-instruction Markdown file (or excluding it from the formatting check if that's the intended handling — **decision needed**, §21).
- **Reuse disposition:** N/A (process, not code).
- **API/data/migration impact:** none.
- **Feature flag:** none.
- **Auth/audit/idempotency:** N/A.
- **Tests/commands:** `pnpm format:runtime:check`.
- **Observability:** CI goes green.
- **Acceptance evidence:** CI run succeeds on the resulting commit.
- **Rollback:** revert the formatting commit.
- **Size:** S.

### Package B — Shared tokens, shell, i18n (no domain behavior change)

- **Outcome:** confirmed Site design tokens and locale-persistence land with zero behavior change to any existing feature.
- **Dependencies:** Package A.
- **Files:** `apps/web/app/globals.css` (add tokens, §8), `apps/web/app/(app)/layout.tsx` (nav structure only, no auth logic change), a new locale-cookie utility + provider (§13), workspace-profile-sourced label reads (ADR-6).
- **Reuse disposition:** extend (§6).
- **API/data/migration impact:** none (locale cookie is client-set, no schema change).
- **Feature flag:** none needed — purely additive/visual.
- **Auth/audit/idempotency:** N/A.
- **Tests/commands:** `pnpm --filter @wukong/web test`, `pnpm typecheck`, new locale-persistence test.
- **Observability:** N/A.
- **Acceptance evidence:** visual-regression capture of the shell in both locales/viewports (§14).
- **Rollback:** revert; no data implications.
- **Size:** M.

### Package C — Public entry and auth layout

- **Outcome:** `/`, `/signin`, `/register*`, `/forgot-password`, `/reset-password` adopt the Site's layout/copy; CSRF/secure-cookie defaults verified and hardened if needed (§7 G10, §12).
- **Dependencies:** Package B (tokens).
- **Files:** `apps/web/components/auth-form.tsx`, the five auth page files (§5), `apps/web/auth.ts` (only if CSRF/cookie hardening is needed).
- **Reuse disposition:** extend, visual layer only (§6) — plus a possible small auth-config addition.
- **API/data/migration impact:** none, unless CSRF hardening requires a new `trustedOrigins` config value (an env var addition, not a schema change).
- **Feature flag:** none.
- **Auth/audit/idempotency:** unchanged — existing mechanisms reused (§3).
- **Tests/commands:** existing `auth.test.ts`, `auth-flow.test.ts`, `flow-routes.test.ts` must stay green; add a CSRF-specific test if hardening is added.
- **Observability:** N/A.
- **Acceptance evidence:** existing tests green + visual capture, both locales/viewports.
- **Rollback:** revert.
- **Size:** M.

### Package D — Read-only dashboard, catalog, queue

- **Outcome:** `/catalog` gets real server-side pagination/search; `/dashboard` gets accurate (not 100-row-capped) counts where feasible; `/queue` gets built, wiring the existing `listing-queue.tsx` component.
- **Dependencies:** Package B.
- **Files:** `apps/web/app/api/catalog/route.ts`, `packages/db/src/repositories/platform-products.ts` (`listRecent` → paginated query), `apps/web/lib/catalog-contract.ts` (add fields, ADR-7), new `apps/web/app/(app)/queue/page.tsx`.
- **Reuse disposition:** extend (§6).
- **API/data/migration impact:** `GET /api/catalog` gains query params (additive, backward compatible); no schema migration needed if existing `createdAt`/`updatedAt`/`contentDigest` columns are simply surfaced (they already exist, §3).
- **Feature flag:** none needed.
- **Auth/audit/idempotency:** read-only, no audit events needed beyond existing access logging.
- **Tests/commands:** new integration test for >100-row workspaces; existing `catalog-control-center.test.ts`-style tests extended.
- **Observability:** N/A.
- **Acceptance evidence:** pagination test passes; `/queue` renders real data laned correctly.
- **Rollback:** revert; read-only changes carry no data risk.
- **Size:** M.

### Package E — Bulk Update contract fixes, `/listings/new` UI, and freshness gate

- **Outcome:** the four highest-severity items land: sheet-name fix (§7 G6, **done**, PR #51), Variant ID hard block (§7 G7, **done**, PR #51), `/listings/new` restructured into the Site's 3-tab IA with the "Existing products" tab wired to the already-working `POST /api/listings/import` (§7 G11, resolved-and-scoped, not yet built), and the source-import/freshness-gate function (§11, not yet built).
- **Dependencies:** Package A only — this can start immediately and should be prioritized ahead of B–D if resourcing is constrained, since it's the highest-risk area.
- **Files:** `packages/shopline/src/bulk-form-xlsx.ts` (sheet name, done), `packages/shopline/src/bulk-form.ts` (Variant ID, done), `apps/web/app/(app)/listings/new/page.tsx` (add 3-tab layout; move existing `ListingIntakeClient` into the disabled "New products" tab; new "Existing products" tab component calling `POST /api/listings/import`), new `sourceImportId` entity + `assertExportFreshness` service (§11), `apps/web/lib/bulk-form-import.ts` (call the new freshness assertion).
- **Reuse disposition:** extend, narrow fixes (§6) — this package touches the strongest-built code in the repo and should change as little as possible beyond the specific defects named.
- **API/data/migration impact:** possible new table/columns for the explicit `sourceImportId` entity if one doesn't already exist under another name (**verify first**, §11) — full expand/contract migration discipline required if so (§10).
- **Feature flag:** none — these are correctness fixes, not experimental features.
- **Auth/audit/idempotency:** the freshness gate itself becomes a new audit-relevant check point; log its pass/fail outcome.
- **Tests/commands:** extend `bulk-form.test.ts`, `bulk-form-xlsx.test.ts` with sheet-name and Variant-ID-block assertions; new tests for the freshness gate (stale-source rejection, digest-mismatch rejection).
- **Observability:** freshness-gate rejection reasons should be visible (feeds the `/jobs` ledger later, Package I).
- **Acceptance evidence:** golden-workbook round-trip test passes with sheet name `Default`; a synthetic Variant-ID row is confirmed blocked, not merely warned.
- **Rollback:** revert; these are additive/corrective, not replacing working behavior.
- **Size:** L.

### Package F — Attended batches read persistence

- **Outcome:** `/batches` gets a real list/detail view; the 1–5 wave-size cap is confirmed or added as a backend enforcement (§7 G12).
- **Dependencies:** Package E (batches must bind to the new `sourceImportId`/digest model).
- **Files:** new `GET /api/batches`, `/api/batches/[id]` routes, `apps/web/lib/enrichment-batch-service.ts` (add/confirm the wave-size cap check), new `apps/web/app/(app)/batches/page.tsx` read view (the create/advance UI may already exist — confirm before assuming a full rebuild is needed).
- **Reuse disposition:** extend (§6, §9 ADR-10).
- **API/data/migration impact:** likely additive read endpoints only, unless no persisted batch/wave table currently exists in a form that supports listing (verify against `packages/db/src/schema.ts` directly before assuming a new table is needed).
- **Feature flag:** none needed.
- **Auth/audit/idempotency:** reuse existing batch create/advance idempotency if present; add audit events for batch state transitions if not already covered.
- **Tests/commands:** new tests for the wave-size cap (reject a wave outside 1–5 server-side, not just via UI), list/detail read tests.
- **Observability:** batch state visible in the `/jobs` ledger (Package I).
- **Acceptance evidence:** a 6-item wave creation attempt is rejected by the API itself, confirmed by test.
- **Rollback:** revert.
- **Size:** M.

### Package G — SEO/keywords review fields, confirmation ledger, approval binding

- **Outcome:** the centerpiece of this plan, but smaller than an earlier draft scoped it — extend the _existing_ review UI with the 3 fields not already reviewed (`seo.title`, `seo.description`, `tags`, backing `seoTitleEn/Zh`, `seoDescriptionEn/Zh`, `seoKeywords`), and bind the whole approval flow (not just these 3 fields) to the freshness gate with a full confirmation ledger (§9 ADR-8, §11). `nameZh`/`summaryEn`/`summaryZh` already flow through `title`/`description` review today and need no new UI.
- **Dependencies:** Package E (freshness gate must exist first).
- **Files:** extend `listing-fields-form.tsx`/`listing-review-client.tsx`/`evidence-panel.tsx` with 3 new fields and their evidence/diff display, reusing `packages/core/src/workflow.ts`/`review.ts` and `packages/db/src/repositories/listings.ts`'s version-concurrency pattern (§6) unchanged, new confirmation-ledger schema/repository, new approval-binding fields (`expectedVersionId`, `sourceImportId`, `expectedSourceRowDigest`, `confirmationLedgerRevision`, §11).
- **Reuse disposition:** extend (§6) — no parallel review mode.
- **API/data/migration impact:** new confirmation-ledger table (full migration discipline, §10); extended approval request schema (additive fields, applies to the same review/approval path already in use, not a separate one).
- **Feature flag:** **Proposed** — gate the 3 new fields and the freshness-bound approval behind a capability flag (feeds ADR-11's registry) so they can ship dark and be enabled per-workspace once UAT (§18) passes.
- **Auth/audit/idempotency:** reuse existing role/RLS/audit/version-concurrency mechanisms exactly (§6, §10) — no new security model.
- **Tests/commands:** new tests for the 3 new fields' review/edit/approval, expected-version/source-digest conflict rejection, approval invalidation on content/evidence/source change.
- **Observability:** approval invalidation events visible in `/jobs`/`/quality` (Packages F/I).
- **Acceptance evidence:** a full review→approve cycle for a synthetic 5-product batch (exercising all 8 fields, only 3 of which are new UI), including one deliberately-staled item that correctly gets rejected.
- **Rollback:** disable the feature flag; underlying data model additions are additive.
- **Size:** M (down from an earlier L estimate, now that 3 of the 8 fields need no new UI).

### Package H — Multi-product changed-row XLSX and manifest

- **Outcome:** batch export capability built per §11's full spec.
- **Dependencies:** Package G (needs approved multi-field reviews to export).
- **Files:** new export endpoint (§10), extends `createBulkFormUpdate`/`bulk-form-xlsx.ts` for multi-row generation reusing the existing single-row neutralization/echo logic, new manifest generation + reparse-and-assert step.
- **Reuse disposition:** extend (§6) — reuses the single-row export logic as its per-row building block rather than reimplementing it.
- **API/data/migration impact:** new endpoint, additive; manifest could be a response payload rather than a new table if no durable manifest-history requirement exists — **[Proposed]** store it durably in the `/jobs` ledger (Package I) so past exports remain auditable.
- **Feature flag:** gate behind the same capability flag as Package G until UAT (§18) validates it.
- **Auth/audit/idempotency:** export attempt gets its own idempotency key (re-running an identical export must not double-neutralize deltas); full audit trail of what was exported.
- **Tests/commands:** golden multi-product round-trip test (byte/semantic equivalence of locked+pass-through cells vs. fresh source), no-op-product exclusion test, mixed-source-rejection test.
- **Observability:** manifest surfaced in `/jobs`.
- **Acceptance evidence:** a synthetic 3-product batch (one no-op, one changed, one from a mismatched source) produces exactly the correct 1-row export with a correct manifest.
- **Rollback:** disable feature flag.
- **Size:** L.

### Package I — Jobs, manual import proof, quality, admin capability truth

- **Outcome:** `/jobs`, `/quality`, `/system-map`, and `/admin`'s 4th tab all land, backed by the shared capability-registry and ledger patterns (§9 ADR-10, ADR-11).
- **Dependencies:** Package H (jobs ledger needs export events to show).
- **Files:** new `/api/jobs`, `/api/quality` read endpoints, new pages for all four routes, new capability-registry module consumed by both `/admin` and `/system-map`.
- **Reuse disposition:** new, following the shared read-model pattern from ADR-10 (§6).
- **API/data/migration impact:** additive read endpoints; capability registry can likely be a typed constant module rather than a new table (no dynamic runtime state needed beyond what other tables already track).
- **Feature flag:** the registry itself should show whether Packages G/H's features are enabled per-workspace.
- **Auth/audit/idempotency:** read-only for jobs/quality/system-map views; admin's existing role-gating (§3) extends to the new tab.
- **Tests/commands:** new tests per read endpoint; capability-registry consistency test (both surfaces show the same state).
- **Observability:** this package _is_ the observability surface for everything built in D–H.
- **Acceptance evidence:** each route renders real data (or a correct empty state) for a test workspace with no batches/exports yet.
- **Rollback:** revert; purely additive read surfaces.
- **Size:** L.

### Package J — Accessibility, responsive, security and performance hardening

- **Outcome:** close the gaps named in §14/§15 that weren't already fixed incidentally by earlier packages.
- **Dependencies:** all of B–I (this audits what they built, plus the pre-existing surface).
- **Files:** varies — this is an audit-and-fix pass, not a single feature.
- **Reuse disposition:** refactor in place where gaps are found.
- **API/data/migration impact:** none expected beyond minor fixes.
- **Feature flag:** none.
- **Auth/audit/idempotency:** N/A directly, though the CSRF/cookie item from Package C should be re-verified here as a final check.
- **Tests/commands:** accessibility-tree assertions, contrast checks, visual-regression suite across every route in §5.
- **Observability:** N/A.
- **Acceptance evidence:** WCAG 2.2 AA checklist passes for every affected route.
- **Rollback:** revert individual fixes as needed.
- **Size:** M.

### Package K — Controlled Opak UAT and staged rollout

- **Outcome:** the four-stage UAT sequence from §11/§18 executed and signed off.
- **Dependencies:** all of A–J.
- **Files:** none (process, not code) beyond whatever fixes UAT itself surfaces.
- **Reuse disposition:** N/A.
- **API/data/migration impact:** none from this package directly; UAT may surface defects requiring small follow-up PRs against earlier packages.
- **Feature flag:** the Package G/H flag gets enabled per-stage (1–5 → 30–50 → 50–100 → catalog-scale).
- **Auth/audit/idempotency:** N/A (process).
- **Tests/commands:** the full UAT coverage list in §17.
- **Observability:** UAT metrics (§15) must show clean numbers at each stage before advancing.
- **Acceptance evidence:** written Opak sign-off at each stage boundary.
- **Rollback:** per ADR-12 — stop the pipeline; no automatic reversal of completed SHOPLINE writes.
- **Size:** L (spans calendar time, not just engineering effort).

**Dependency graph (textual):** A → B → {C, D} (parallel); A → E (can run parallel to B/C/D); E → F → G → H → I; {C, D, E, F, G, H, I} → J → K.

**Recommended first PR:** see §20 (Package A, immediately followed by starting Package E in parallel with B/C/D).

---

## 17. Test strategy and commands

**Exact commands (all confirmed to exist verbatim at this commit, §3):**

```bash
pnpm format:runtime:check
pnpm runtime:forbidden:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
pnpm runtime:doctor <env>
pnpm --filter @wukong/db audit:verify
```

**Coverage plan, mapped to this document's findings:**

- **Route/function parity:** one acceptance test per §5 entry once built — start with §5's flagged unknowns (`/listings/new` wiring, `/batches` wave-cap) since those need confirmation before their disposition is even settled.
- **Public/protected boundaries:** verify every route in §5 enforces the role listed; add a negative test for each protected route confirming a lower-role session is rejected.
- **Both locales, desktop and 375px mobile:** per §14's visual-regression scope, every route.
- **Auth invitation/reset and role matrix:** extend existing `auth.test.ts`/`flow-routes.test.ts` coverage to the CSRF/cookie hardening from Package C once landed.
- **Cross-workspace/RLS denial:** replicate the existing `memberships.integration.test.ts` pattern for every new tenant-scoped table (§15).
- **Catalog pagination/search/cohorts:** new integration test for the >100-row case (§16 Package D).
- **Batch persistence, 1–5 backend cap, idempotent advancement:** §16 Package F.
- **Eight-field review/edit/approval:** §16 Package G.
- **Expected-version and source-digest conflict:** extend the existing stale-version-409 test pattern to the new confirmation-ledger fields (§11, §16 Package G).
- **Approval invalidation after content/evidence/source changes:** §16 Package G.
- **Exact 71-column golden round trip and workbook/cell types:** extend existing `bulk-form.test.ts`/`bulk-form-xlsx.test.ts` with the sheet-name fix (§16 Package E) — this test suite already exists and is strong; add to it rather than writing from scratch.
- **Leading-zero/alphanumeric/blank identifiers:** already covered by existing tests per §11's confirmed structural guarantees — verify existing test fixtures include a blank-Barcode case; add one if missing.
- **Blank, zero, negative and unlimited raw values:** extend existing `parseRow` tests with an explicit `無限數量` round-trip case (§11's flagged Unverified item).
- **Locked/pass-through equality and neutral deltas:** already tested for single-row export; extend to the new multi-row export (§16 Package H).
- **Multi-product changed-row export and manifest:** §16 Package H.
- **Partial SHOPLINE import recording and reconciliation:** new tests for the manual-import-result endpoint (§10, §16 Package I).
- **Queue redelivery/idempotency and audit completeness:** existing publish-job idempotency pattern (§3) should be extended to cover the new export endpoint's idempotency key (§16 Package H).
- **Keyboard, screen reader, focus, contrast, reduced motion:** §16 Package J.
- **Visual regression and capability-truth states:** §16 Packages I and J.

**Important caveat, restated from the master instruction:** the current CI (`AI_PROVIDER=fake`, `SHOPLINE_ADAPTER=mock`) proves only a synthetic runtime path. It is not evidence of real SHOPLINE workbook acceptance (that requires §18's UAT) or production readiness more broadly.

---

## 18. Rollout, Opak UAT, go/no-go and rollback

**Staged rollout (unchanged from master instruction, cross-checked against actual repo state):**

| Stage                    | Scope                                        | Gate to advance                                                                                                          | Current readiness                                                        |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1. Attended contract UAT | 1–5 products                                 | Sheet-name fix + Variant-ID hard block (Package E) land and pass; manual SHOPLINE re-import of a generated file succeeds | **Not ready** — both fixes are Proposed, not yet implemented (§7 G6, G7) |
| 2. Golden set            | 30–50 products                               | Stage 1 passes; freshness gate (Package E) and eight-field review (Package G) are live                                   | **Not ready** — both are Proposed                                        |
| 3. Shadow pilot          | 50–100 products, 2 weeks, manual import only | Stage 2 passes; multi-product export (Package H) is live; `/jobs` ledger (Package I) shows clean reconciliation          | **Not ready**                                                            |
| 4. Catalog-scale rollout | Full catalog                                 | Written Opak sign-off after Stage 3; all of Packages A–J complete                                                        | **Not ready**                                                            |

**Go/No-Go criteria per stage (restated from master instruction, unchanged):** 100% header/workbook acceptance; 100% intended-row import success with partial success explicitly reconciled; zero identifier coercion; zero locked/pass-through changes; zero unintended stock/price/status/category/supplier changes; exactly the approved eight-field changes; complete audit evidence; a tested rollback source file available at every stage.

**Rollback (ADR-12):** at every stage, rollback means _stop the pipeline_ — no new imports/enrichment/exports proceed. Already-approved-and-delivered listings are **not** automatically reverted; any correction to an already-written SHOPLINE product requires a separate, explicitly-authorized manual action, consistent with the existing `production-readiness.md` runbook's philosophy (§3). This must be communicated to and accepted by Opak before Stage 1 begins (§9 ADR-12's decision-owner requirement).

**Current overall readiness: No-Go.** Per master instruction §11's own rule, production remains No-Go while any source/workbook/digest/approval/locked-field/delta/identifier/variant/compliance/partial-import/rollback/authorization gate is unresolved — and this audit found several unresolved: the freshness gate (§7 G4), the Variant-ID block (§7 G7), the sheet-name mismatch pending UAT confirmation (§7 G6), and the wave-size cap enforcement location (§7 G12). None of these are difficult to resolve (§16's packages are appropriately scoped), but none are resolved today.

---

## 19. Risks, decisions, assumptions and stop conditions

**Open risks (consolidated from §7, ranked by severity):**

1. Freshness gate absence (G4) — highest severity; risk of acting on stale merchant data.
2. Variant ID non-blocking (G7) — high severity; risk of processing unvalidated variant rows in a live pilot.
3. Sheet-name mismatch (G6) — high severity but cheap to fix; risk is entirely in the _unknown_ SHOPLINE-side acceptance behavior, not the fix itself.
4. Review-UI/Bulk-Update disconnect (G5) — largest _scope_ risk (biggest single build item), not a safety risk per se.
5. Two overlapping master instructions (G8) — coordination risk, not a technical risk.
6. CSRF/secure-cookie unverifiable (G10) — moderate security risk, currently unknown rather than confirmed-bad.
7. `/listings/new` wiring unconfirmed (G11) — risk of building Package E/G on a misunderstood foundation.
8. Batch wave-cap enforcement location unconfirmed (G12) — moderate risk of UI-only limits being bypassable via direct API calls.

**Assumptions this plan makes, flagged explicitly:**

- That `platform_products` is the only place a durable source-import concept could live, and that no separately-named "import session" table already exists elsewhere in the schema (§11 — flagged as needing direct verification before Package E begins).
- That the Frontend Revamp master instruction (§2, §7 G8) and this plan's master instruction are meant to be reconciled rather than treated as sequential/independent — **this is an assumption, not a confirmed fact**, and the decision owner in §21 should confirm it explicitly.
- That Better Auth's actual pinned-version defaults are adequate for CSRF/cookie security once verified (§7 G10) — if verification reveals otherwise, Package C's scope grows.

**Stop conditions from the master instruction's own §20, checked against this audit's findings:**

- Repository/instructions/Site/workbook could not be inspected sufficiently → **Does not apply** — all four were inspected (§2).
- Source versions cannot be pinned → **Does not apply** — pinned exactly (§2).
- Workbook headers/digest conflict with repository fixtures with no resolvable owner → **Does not apply** — they match exactly (§2, §11).
- Working tree contains overlapping uncommitted changes → **Did apply at the start of this task** (local `main` was 422 commits stale) — **resolved** via the fast-forward pull the user explicitly approved (§2). The ~30 untracked scratch files were confirmed harmless/historical, not overlapping in-progress work.
- The plan file already exists → **Does not apply** — confirmed absent before writing (§16 Package A's predecessor check, and the original pre-flight check in this session).
- Site behavior materially conflicts with runtime security/business rules with no decision owner → **Partially applies** — see G8 (two master instructions) and ADR-5 (`/pilot` ownership), both flagged with a required decision owner in §21.
- A proposal would weaken workspace scoping/RLS/audit/workflow validation/approval binding/queue idempotency → **Does not apply** — every proposal in this plan explicitly reuses and extends the existing mechanisms rather than weakening them (§6, §10, §15).
- Completion would require credentials/production data/SHOPLINE writes/deployment/migration → **Does not apply to this planning document** — no such action was taken (see closing statement); several _proposed_ packages will eventually require a schema migration, but that is future implementation work, correctly deferred per §10's discipline, not a defect in this plan.
- A real variant is present but variant handling remains unvalidated → **Applies, and is exactly why G7 is flagged as urgent** — real Opak data may contain variant rows, and the pipeline currently only warns rather than blocks on them.
- Production readiness/merchant authorization is being assumed rather than evidenced → **Does not apply** — this plan's verdict (§1) is explicitly Blocked, not an assumed Go.

---

## 20. Recommended first PR

**Package A alone: fix the CI formatting failure.**

- **Why first:** it is the only fully risk-free item in this entire plan — a one-file Prettier/line-ending fix with no behavioral change, and it is what's currently keeping CI red on `main` (§2).
- **Files:** `docs/superpowers/plans/Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md` (reformat to satisfy `pnpm format:runtime:check` — likely just normalizing line endings) — **or**, if the intent is that user-uploaded reference documents shouldn't be subject to the runtime-formatting gate at all, add an explicit exclusion for this path in the formatting script instead of reformatting a document the user uploaded verbatim. **This choice is itself a small decision — see §21.**
- **Size:** S.
- **Acceptance evidence:** `pnpm format:runtime:check` passes; the next CI run on `main` goes green.
- **Immediately followed by (as its own second PR, still very small and low-risk):** the two Package E code fixes that need no design discussion — the `bulk-form-xlsx.ts` sheet-name literal (`"Sheet1"` → `"Default"`) and the `bulk-form.ts` `parseRow` Variant-ID handling (warning → hard block). Both are narrow, single-purpose, easily reviewed, and address this audit's two highest-severity confirmed defects (§7 G6, G7) without waiting on any of the larger, decision-dependent packages.

---

## 21. Decisions required before the first PR

**Before Package A specifically:** one small decision — whether to reformat the uploaded master-instruction document to satisfy `format:runtime:check`, or exclude user-uploaded reference documents from that check entirely. Either is low-risk; pick one and move on. **Decision owner:** runtime tech lead.

**Before the broader Package B–K sequence begins (not blocking Package A/the sheet-name/Variant-ID fixes):**

- **G8 — reconcile the two overlapping master instructions.** Decision owner: whoever owns both `docs/product/Wukong_Ecommerce_OS_Product_Frontend_Revamp_ChatGPT_Master_Instruction.md` and this plan's source document.
- **ADR-5 — `/pilot` ownership**, to avoid duplicating `wukong-ops-suite`. Decision owner: product/marketing owner.
- **G10 — confirm Better Auth's actual CSRF/cookie defaults** for the pinned version, before Package C is called complete. Decision owner: runtime tech lead.
- **G11 — confirm `/listings/new`'s actual current wiring** before any UI work proceeds on it. Decision owner: runtime tech lead.
- **G12 — confirm or add backend enforcement of the 1–5 batch wave-size cap** before Package F is called complete. Decision owner: runtime tech lead.
- **ADR-8/ADR-9 — confirm the review-mode and workbook-generation approach** with the Opak product owner before Package G/H begin in earnest, since these define the operator's actual day-to-day workflow.
- **ADR-12 — Opak's explicit acceptance of the stop-the-pipeline rollback model** before Stage 1 UAT begins (§18).

---

## 22. Implementation-ready checklist

Checking this plan document itself against the master instruction's own plan-quality gates:

- [x] Every discovered Site and runtime route appears exactly once in the parity matrix — §5.
- [x] Every current-state claim has evidence — file:line or route/locale/viewport citations throughout §2–§11.
- [x] Every Site action maps to a real or explicitly proposed contract — §5, §10.
- [x] Prototype/no-op states are not copied as production behavior — explicitly addressed, §7 G1, §12.
- [x] Working auth/security/runtime behavior is not downgraded — every disposition in §6 is reuse/extend, never a security-relevant replace.
- [x] Every reused artifact and every replacement is named and justified — §6 (no runtime artifact was disposed "replace" or "retire"; only the Site's own non-functional code is "retire," which is not a runtime artifact).
- [~] Every database change includes RLS, migration, compatibility and rollback — the _discipline_ is established (§10) and applied per-package (§16), but the exact migration scripts themselves are implementation-time work, correctly deferred by this plan rather than a gap in it.
- [x] Every mutation includes role, validation, audit and idempotency/version treatment — pattern stated once (§10, §15) and applied consistently to every new mutation proposed.
- [~] The eight writable, ten locked, 51 pass-through and two neutral-delta fields are tested — **already true today** for the existing single-row path (§11); new tests for the sheet-name/Variant-ID fixes and the multi-row path are specified (§17) but not yet written, since this is a plan, not an implementation.
- [~] Review and export bind to the exact source import, row digest and version — fully specified (§11, §9 ADR-8) but not yet built.
- [x] File generation and SHOPLINE import confirmation remain separate — already true in current code and explicitly preserved as an invariant (§11).
- [~] zh-HK/English, accessibility, responsive, loading, empty, error, stale, conflict, forbidden and retry states cover every affected route — fully specified per-route (§5, §8, §14) but not yet built for the Missing routes.
- [x] Rollout and rollback are executable — §18, ADR-12.
- [x] No phase enables production SHOPLINE writes — confirmed enforced and unoverridable today (§3), and no package in §16 proposes changing this.
- [x] Unknown, Inferred and Proposed items are never presented as shipped capability — labeling discipline (Observed/Inferred/Proposed/Unverified) applied throughout this document.

`[~]` marks items that are fully specified by this plan but correctly deferred to implementation (schema migrations, new tests, new UI) — this is expected for a planning-only deliverable and is not a gap in the plan itself.

---

> No application code, infrastructure, database, deployment or production SHOPLINE state was changed while preparing this plan.
