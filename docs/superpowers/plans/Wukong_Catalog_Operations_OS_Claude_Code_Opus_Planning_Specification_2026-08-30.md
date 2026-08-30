# Wukong Catalog Operations OS — Claude Code Opus Planning Specification

**Version:** 1.0  
**Date:** 30 August 2026  
**Purpose:** Paste-ready instruction for Claude Code Opus to inspect the updated Wukong Site and the existing runtime, then write a file-level integration plan only  
**UX reference:** https://wukong-catalog-ops.laichiwillyjp.chatgpt.site  
**UX repository:**https://github.com/YNWAforever/wukonggpt
**Runtime repository:** https://github.com/YNWAforever/wukong-ecommerce-os  
**Recommended plan output:** `docs/superpowers/plans/YYYY-MM-DD-wukong-catalog-operations-os-integration.md`

## How to use this document

1. Open the latest local checkout of `YNWAforever/wukong-ecommerce-os` in Claude Code Opus.
2. Make the actual Opak SHOPLINE Bulk Update workbook available locally as read-only evidence. Do not add the merchant workbook to Git.
3. Paste everything between **MASTER INSTRUCTION STARTS** and **MASTER INSTRUCTION ENDS** into Claude Code.
4. Claude must remain in planning mode. The only permitted write is the final Markdown plan.
5. Review and approve the plan before asking Claude to implement any application or infrastructure change.

## Audited starting point — revalidation required

This is a starting hypothesis, not permission to skip inspection.

- Repository `main` was inspected at commit `aac65e5429b86ae308c13a655210295ae7e4f05a` dated 26 August 2026.
- The latest inspected CI run, `33005551906`, was successful; the inspected commit also had a successful Vercel status.
- The runtime is a real pnpm/Turborepo application using Next.js 16, React 19, plain CSS, Cloudflare Workers/Queues/Hyperdrive/R2, Neon Postgres/Drizzle/RLS, Better Auth, Zod, Vitest and Playwright.
- The Site is an intended UX and workflow reference. It contains anonymous/sample data and several disabled or unconnected actions. It is not runtime capability evidence.
- The real Opak reference export previously profiled as one `Default` sheet, 71 columns, two bilingual header rows and 500 data rows. A fresh workbook must be inspected again before the plan is called implementation-ready.

---

## MASTER INSTRUCTION STARTS

You are **Claude Code Opus**, acting as a principal software architect, senior Next.js engineer, ecommerce catalog-operations architect, security reviewer, accessibility specialist and migration planner.

Your task is to inspect the updated Wukong frontend reference and the existing production-oriented codebase, then write a detailed, evidence-backed, file-level implementation plan.

This is a **PLANNING-ONLY** task. Do not implement the plan.

### 1. Inputs

#### Intended UX, layout, IA and workflow reference

`https://wukong-catalog-ops.laichiwillyjp.chatgpt.site`
`https://github.com/YNWAforever/wukonggpt`


#### Existing runtime to preserve and extend

`https://github.com/YNWAforever/wukong-ecommerce-os`

#### Opak Cellar contract evidence

- The actual Opak SHOPLINE 71-column Existing Product Bulk Update workbook supplied for this project.
- The approved Opak operational and content rules.
- Repository fixtures and automated tests only where they agree with the real workbook.

Do not commit the merchant workbook, credentials, production data, screenshots containing merchant-sensitive values or generated exports.

### 2. Required outcome

Produce one self-contained Markdown implementation plan at:

`docs/superpowers/plans/YYYY-MM-DD-wukong-catalog-operations-os-integration.md`

The plan must explain how to adopt the Site's updated layout and intended functions inside the existing `wukong-ecommerce-os` runtime while maximising reuse of verified code, data contracts, security boundaries, workflow logic and tests.

The plan must be implementable by another engineer without rediscovering architecture or inventing missing decisions.

### 3. Hard execution boundary

- Remain in planning mode.
- Do not edit application source, tests, configuration, migrations or infrastructure.
- Do not install, remove or update dependencies.
- Do not create a branch, commit, pull request, issue or deployment.
- Do not run database migrations, provision resources, send email, call SHOPLINE write endpoints, upload merchant files or use production credentials.
- Do not enable feature flags or change environment variables.
- Do not begin a “quick implementation” or visual reskin.
- The only permitted filesystem change is the final Markdown plan file named above.
- If that exact plan file already exists, do not overwrite it. Report the conflict and stop.
- If the checkout contains overlapping uncommitted changes, record the affected paths and stop before writing the plan.
- Read-only inspection commands are allowed. Existing CI evidence may be inspected, but do not mutate caches or claim a test was run when it was not.

End the plan with this exact statement:

> No application code, infrastructure, database, deployment or production SHOPLINE state was changed while preparing this plan.

### 4. Source hierarchy and conflict policy

Use this precedence order:

1. Executable repository code and tests define current runtime capability.
2. The actual Opak workbook and approved business rules define the SHOPLINE data contract.
3. The updated Site defines intended UX, information architecture, wording and interaction design.
4. Current first-party external documentation is supporting evidence only.
5. Older specs, plans and runbooks are historical evidence and may be stale.

Never use a Site mock, sample value, enabled-looking control or disabled control as proof of backend capability. Never downgrade a working runtime feature merely because the Site prototype labels it unavailable.

Examples that must be reconciled explicitly:

- The Site auth forms describe themselves as an unconnected prototype, while the runtime has Better Auth, password/magic-link flows, invite enrolment and real invite email code. Adopt the layout and truthful states; reuse the working auth contracts.
- The Site exposes `/batches`, `/queue`, `/jobs`, `/quality`, `/system-map` and `/pilot`; these pages were absent from the inspected runtime.
- The Site presents batch changed-row XLSX delivery; the inspected runtime exposes only single-listing Bulk Update export.
- The Site shows source freshness and immutable-fingerprint gates; the inspected runtime only has row digests and manual freshness instructions.
- The Site shows a full eight-field Bulk Update review; the inspected runtime review UI does not expose every SEO/keyword field written by export.

When sources conflict, record:

- the conflicting claims;
- exact evidence for each claim;
- operational and security consequences;
- the recommended resolution;
- the decision owner;
- whether implementation must stop until the decision is made.

Label material statements as **Observed**, **Inferred**, **Proposed** or **Unverified**.

### 5. Phase 0 — establish an immutable evidence baseline

Before recommending changes, record:

- repository URL, local branch, HEAD SHA, dirty/clean status and UTC inspection time;
- the difference between current HEAD and the audited reference SHA `aac65e5429b86ae308c13a655210295ae7e4f05a`;
- latest relevant CI run and status;
- Site URL, access state, inspection time, locale and viewport;
- Opak workbook filename, SHA-256, file size, sheet names, used range, header rows, data start row, row count and representative cell types;
- whether the workbook is a fresh SHOPLINE export or only the 21 May 2026 reference snapshot.

Read completely before planning:

- `CLAUDE.md`
- `CONTEXT.md`
- root `package.json`, workspace configuration and package scripts
- `docs/product/ecommerce-os-product-plan.md`
- `docs/product/catalog-control-center-acceptance.md`
- `docs/runbooks/local-development.md`
- `docs/runbooks/production-readiness.md`
- `docs/runbooks/shopline-pilot-onboarding.md`
- relevant dated designs and plans under `docs/superpowers/specs/` and `docs/superpowers/plans/`
- all page and layout files under `apps/web/app`
- relevant components under `apps/web/components`
- relevant services under `apps/web/lib`
- worker ingress, listing pipeline, queue consumers and SHOPLINE delivery code
- `packages/core`, `packages/db`, `packages/ai`, `packages/shopline`, `packages/assets` and `packages/jobs`
- migrations, RLS boundaries, repositories, audit verification, CI and relevant unit/integration/Playwright tests.

At minimum, inspect these implementation paths and name the relevant symbols in the plan:

- `apps/web/app/(app)/layout.tsx`
- `apps/web/app/globals.css`
- `apps/web/components/auth-form.tsx`
- `apps/web/components/catalog-control-center.tsx`
- `apps/web/components/listing-queue.tsx`
- `apps/web/components/listing-intake-client.tsx`
- `apps/web/components/listing-review-client.tsx`
- `apps/web/components/listing-fields-form.tsx`
- `apps/web/components/evidence-panel.tsx`
- `apps/web/components/delivery-panel.tsx`
- `apps/web/components/admin-tabs.tsx`
- `apps/web/lib/session-context.ts`
- `apps/web/lib/bulk-form-import.ts`
- `apps/web/lib/enrichment-batch-service.ts`
- `apps/web/lib/listing-approval.ts`
- `apps/web/lib/delivery-service.ts`
- `packages/core/src/listing-schema.ts`
- `packages/core/src/workflow.ts`
- `packages/db/src/schema.ts`
- `packages/db/src/client.ts`
- `packages/db/src/repositories/platform-products.ts`
- `packages/shopline/src/bulk-form.ts`
- `packages/shopline/src/bulk-form-xlsx.ts`
- `packages/shopline/src/bulk-form-source.ts`
- `packages/shopline/src/bulk-form-digest.ts`
- `packages/shopline/src/csv.ts`
- `packages/shopline/src/delivery-policy.ts`
- `apps/worker/src/listing-pipeline.ts`
- `apps/worker/src/publish-product.ts`
- `.github/workflows/ci.yml`

Inspect every reachable Site route in Traditional Chinese and English and at desktop and mobile widths. Capture normal, loading, empty, error, disabled, stale, forbidden and success states where available. If access prevents inspection, mark the affected routes Unverified and do not infer hidden behavior.

Evidence format:

- Repository claim: `path:line-range`, symbol and inspected commit SHA.
- Site claim: exact route, locale, viewport and UTC capture time.
- Workbook claim: sheet, row/column/header identity and workbook digest.
- External claim: direct source URL and access date.

Avoid vague statements such as “reuse the existing backend.” Name the exact endpoint, component, service, repository, schema, test and invariant.

### 6. Anti-rewrite and reuse policy

This is an integration and migration, not a greenfield rebuild.

Preserve unless evidence proves a narrow replacement is necessary:

- pnpm/Turborepo package boundaries;
- Next.js App Router and React;
- the existing plain-CSS approach and CSS custom properties;
- ports-and-adapters dependency injection;
- server-session-derived workspace identity;
- `db.forWorkspace(...)` and forced Postgres RLS;
- the role order `viewer < operator < reviewer < admin < owner`;
- bootstrap-only owner semantics;
- `transitionListing` workflow enforcement;
- immutable listing versions and stale-edit protection;
- audit events for domain mutations;
- queue leases, idempotency keys and retry behavior;
- Better Auth and existing mail/crypto contracts;
- Zod request/response validation;
- the existing API, repository and test contracts.

Do not introduce Tailwind, shadcn/ui, Supabase, a parallel frontend app, a second operational datastore, duplicate API clients, global service singletons or a competing domain workflow merely to match the Site.

Treat the Site as a visual and behavioral reference. Do not paste generated Site code into the runtime.

For every affected artifact, provide a reuse disposition:

- `reuse as-is`
- `extend`
- `refactor in place`
- `replace`
- `retire`

Every `replace` or `retire` decision must prove why extension is insufficient and list all consumers, compatibility steps, regression tests and rollback.

Do not put the broad future Product/Variant/ChannelListing domain generalisation on the critical path unless inspection proves it is required for the Opak Bulk Update integration. Prefer the smallest compatible extension of the current model.

### 7. Updated layout and design-system contract

Extract the design language from the Site and translate it into the existing plain-CSS system.

Starting reference to verify:

- desktop navy sidebar and sticky top bar;
- accessible mobile navigation sheet plus a small fixed bottom navigation;
- canvas `#f6f4ef`, navy `#17324d`, text `#182432`, border `#dfe2e1`, muted `#5f6e7b`;
- primary CTA `#b36a24`, hover `#8d4e17`, active accent `#d39a63`;
- `Noto Sans TC` with Inter/system fallbacks;
- white cards, approximately 16px radius, restrained shadows and clear density hierarchy;
- green = fresh/ready, amber = warning/UAT, red = stale/blocked;
- responsive catalog table-to-card behavior;
- responsive review layout: stacked mobile, two-column intermediate, three-column wide;
- 44px minimum interactive targets, visible focus, reduced motion and safe-area padding.

The plan must define:

- tokens and ownership in existing CSS;
- shared page shell and route layout boundaries;
- role-aware navigation;
- session-derived workspace/operator identity;
- workspace-specific Opak/pilot labels supplied by configuration rather than hard-coded shared-shell copy;
- loading skeletons, empty states, errors, stale/conflict states and retry states;
- accessible drawer/dialog/table/card patterns;
- desktop and 375px mobile acceptance captures;
- visual-regression scope.

Add a skip link to the authenticated shell if inspection confirms it is missing.

### 8. Route and function parity matrix

Produce one row for every Site route and every runtime route. Use these parity labels:

`Exact`, `Partial`, `Missing`, `Site-only concept`, `Runtime-only`, `Blocked`, `Deliberately excluded`.

For each row include:

- route and user goal;
- public/protected status and minimum role;
- Traditional Chinese/English behavior;
- desktop/mobile states;
- actions and capability-truth state;
- current runtime route;
- reusable component/API/service/repository/test;
- visual parity, interaction parity and real capability parity separately;
- missing data/API contract;
- proposed disposition and priority;
- dependencies;
- acceptance test and evidence.

Use this audited route hypothesis only as a checklist to revalidate:

| Site route | Intended purpose | Inspected runtime starting point |
|---|---|---|
| `/` | Front-page workspace entry/login context | Runtime root redirects to `/dashboard`; public/auth boundary needs an explicit decision |
| `/signin` | Functional workspace sign-in | Functional auth exists; adopt layout/i18n without disabling the working flow |
| `/register` | Invite-only enrolment | Existing route and auth component |
| `/register/set-password` | Invite-token password setup | Existing separate runtime route |
| `/forgot-password` | Enumeration-safe recovery | Existing route/API |
| `/reset-password` | Token-validated reset | Existing route/API |
| `/pilot` | Public positioning and pilot intake only | Missing in runtime; public marketing ownership must not duplicate `wukong-ops-suite` |
| `/dashboard` | Source readiness, gaps, risk and UAT overview | Existing dashboard, but data and IA are partial and copy is hard-coded |
| `/catalog` | Existing-product control centre | Existing read-only control centre; inspected endpoint is limited to recent records/client filtering |
| `/queue` | Risk-laned work queue | Missing route; reusable listing queue components and status data exist |
| `/listings/new` | Existing-product Bulk Update import, with Create separated | Existing route is primarily new-listing intake; route ownership/compatibility requires an ADR |
| `/batches` | Attended enrichment cohorts/waves | Missing route; create/advance APIs exist, but list/read persistence is missing |
| `/listings/[id]` | Evidence/diff review of exact eight writable fields | Existing route and review components; Bulk Update mode is partial |
| `/jobs` | Import, processing, export and SHOPLINE confirmation ledger | Missing route and list/read model |
| `/quality` | Real content gaps, evidence, human edits and cost | Missing route and read model; do not invent telemetry |
| `/admin` | Members, integrations, brand/policy and system truth | Existing members/connection/settings UI and APIs; partial |
| `/system-map` | Route/capability truth | Missing route; decide access/ownership and avoid exposing sample claims as runtime truth |

Do not preserve the Site's anonymous direct access to protected workspace routes. A public demo, if approved, must use isolated synthetic data and a separate non-merchant route; it must never bypass session, membership or RLS boundaries.

### 9. Functional planning requirements by product area

#### Public entry and authentication

- Decide the ownership of `/`, `/signin` and `/pilot` without duplicating the public `wukong-ops-suite` application.
- Reuse Better Auth, password/magic-link, invitation, mailer and membership logic.
- Use the updated two-panel auth layout and zh-HK/English copy.
- Do not carry the Site's “prototype unavailable” warning into a connected runtime.
- Never show fake login, registration, reset-email or pilot-submission success.
- Cover invitation-only registration, token expiry, non-enumerating recovery, rate limiting, CSRF/origin protection, redirect allowlisting, secure cookies, session fixation defence and previous-session revocation after reset.

#### Dashboard

- Derive counts from real workspace data and import sessions; never hard-code `500/499/489/7` outside synthetic fixtures.
- Show source freshness, header contract, content gaps, review readiness, export/UAT status and capability truth.
- Keep “file generated” distinct from “SHOPLINE import confirmed.”

#### Catalog

- Extend the existing Catalog Control Center rather than replace it.
- Plan server-side pagination/search, content-gap cohorts, source freshness, eligibility, warnings and details drawer data.
- Preserve Product ID/SKU/Barcode as strings.
- Define selection rules and bulk-action authorization.

#### Import and Create separation

- Existing Product Bulk Update is the confirmed Opak flow.
- Supplemental evidence may attach to already imported products.
- New Product Create, images and direct API delivery remain separate and blocked for this Opak update pilot until their own contracts are validated.
- Resolve whether `/listings/new` is repurposed, tabbed or split into dedicated routes without breaking existing deep links/tests.

#### Attended batches

- Reuse the existing create/advance service and endpoint contracts.
- Add the missing reload/list/detail read model and UI only after verifying repository state.
- One batch targets one measurable content-gap cohort.
- Enforce Opak pilot wave size 1–5 on the backend, not only in UI; the inspected API allowed a wider range.
- Require a positive cost cap, manual sequential advancement, idempotent queueing and visible overshoot risk.

#### Evidence review and approval

- Provide current-versus-proposed diff, source/evidence, confidence and editing for all eight Opak writable fields.
- Keep English name, prices, SKU, Barcode, stock, category, supplier and other pass-through facts reference-only.
- Bind save and approval to the exact active version, source import and row digest reviewed.
- Preserve whole-listing approval unless a separately approved ADR changes it.
- Add a durable confirmation ledger and automatic invalidation rules.

#### Jobs and SHOPLINE proof

- Add a real read model for imports, enrichment waves, processing, exports and manual SHOPLINE import results.
- Model partial success, failed rows, error artifacts, retry and reconciliation.
- Retry must reuse source digests and idempotency keys and must not duplicate drafts or remote products.

#### AI quality

- Report real content-gap coverage, evidence coverage, human edit distance, approval rate, cost and latency only when backed by stored data.
- Do not build a generic model leaderboard or invent success metrics.
- Keep protected identity/commercial/logistics facts outside AI enrichment cohorts.

#### Admin and capability truth

- Reuse existing member, invite, role, connection and workspace settings APIs.
- Add workspace-derived brand/policy configuration only if persistence and pipeline consumption are real.
- Show `Live`, `Pilot`, `Planned` and `Blocked` from a single capability registry rather than hard-coded marketing copy.
- Keep `SHOPLINE_PUBLISH_ENABLED=false` visible and enforced.

### 10. Data and API contract plan

For every user action map:

`UI → endpoint/method → minimum role → Zod request/response → domain service → repository → queue, if any → audit event → idempotency/version key`

Inventory and reuse existing endpoints before proposing new ones, including:

- private asset presign/finalize;
- auth password, magic link, invite enrolment and recovery;
- catalog read;
- listing create/read/process/review/approve/bulk-approve/deliver;
- XLSX import;
- enrichment batch create/advance;
- compliance resolution;
- workspace members/invites/settings/connection.

Explicitly evaluate the gaps suggested by the Site:

- paginated/searchable `GET /api/catalog` with source/gap/readiness fields;
- list/detail `GET` contracts for enrichment batches;
- job/import/export/UAT ledger read contracts;
- quality/cost read contracts;
- multi-product changed-row Bulk Update export;
- manual SHOPLINE import-result recording and reconciliation;
- source-import freshness and fingerprint enforcement.

For every proposed schema change include:

- expand/contract migration strategy;
- indexes and uniqueness rules;
- RLS policy and cross-workspace negative tests;
- backfill/default semantics;
- compatibility window;
- audit behavior;
- rollback.

Do not prescribe a database migration if existing tables can be extended safely at the service/view-model layer.

### 11. Mandatory Opak 71-column Bulk Update contract

This is an **Existing Product Bulk Update** artifact keyed by `Product ID (DO NOT EDIT)`. It is not the separate 15-column Wukong create CSV, not a verified Opak Bulk Create template and not an image-delivery format.

Confirmed workflow language:

`Fresh SHOPLINE export → import immutable snapshot → choose content-gap cohort → attended AI enrichment → evidence/diff review → approval → changed-row XLSX → manual SHOPLINE import → import confirmation and reconciliation`

Never label XLSX generation as “published.”

#### Exact field classification to reverify against the workbook

**Ten locked fields — echo the original cell exactly:**

`productId`, `quantity`, `variantId`, `variantEn`, `variantZh`, `variantQuantity`, `slStockId`, `warehouse`, `slKey0`, `slKey1`

**The only eight Wukong-writable fields:**

`nameZh`, `summaryEn`, `summaryZh`, `seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`

`nameEn` is deliberately excluded because it is an Opak product identity/search handle.

**Two neutral-only stock deltas:**

`updateQuantity`, `updateVariantQuantity`

Never echo a non-zero delta. Resolve the documented/implemented contradiction for a source-null delta using real SHOPLINE evidence: current documentation says `+0`, while inspected code may preserve blank. Warn and audit any neutralisation.

**The remaining 51 fields are strict pass-through.** They may be displayed as context but must not be AI-written or edited in the Opak enrichment pilot.

#### Workbook invariants

- Match the full ordered bilingual header contract, including punctuation, spaces and case. Counting to 71 is insufficient.
- Preserve the expected sheet identity, two header rows, data start row, workbook structure and accepted cell types.
- The reference workbook used `Default`; the inspected writer rebuilt a minimal `Sheet1` with inline strings. Do not assume SHOPLINE accepts that output.
- Preserve identifiers as strings end to end, including leading-zero SKU/Barcode, alphanumeric Barcode and blank Barcode.
- Preserve blank, null, `0`, `0.0` and `+0` as distinct raw states.
- Treat Sale Price `0`/`0.0` as “no sale,” not a free product, while preserving the original raw cell on pass-through.
- Preserve raw inventory such as `-1` and the literal `無限數量`; show any normalized interpretation separately and never export normalized `0` over raw source.
- Preserve multi-path category cells and in-cell newlines.
- Cost fields must not enter AI prompts.
- Product Summary is not a full Product Description.
- The Bulk Update form has no Images field.
- A non-empty Variant ID must block this Opak pilot until a real variant contract and round trip are validated.
- A listing without a `platform_products` remote Product ID link is not eligible for Bulk Update.

#### Immutable source-import and freshness gate

Evaluate a durable source-import record containing at minimum:

- source import ID;
- workspace and SHOPLINE connection IDs;
- original filename and source workbook SHA-256;
- header-contract SHA-256;
- sheet name and row count;
- merchant-attested SHOPLINE export timestamp;
- importer and import timestamp;
- spec version;
- ordered raw row snapshots and row digests.

Bind every batch item, generated listing version, review, approval and export manifest to:

`sourceImportId + remoteProductId + sourceRowDigest + activeVersionId`

At export, block unless:

- source freshness satisfies an Opak-approved policy;
- the active version is exactly the reviewed version;
- the current stored row digest equals the reviewed digest;
- header fingerprint and spec version still match;
- products share workspace, connection and compatible source contract;
- UAT has a fresh SHOPLINE export imported immediately before generation.

Do not hard-code the Site's 24/72-hour thresholds until Opak approves them. Until then, use an explicit attended freshness attestation.

#### Review confirmation and invalidation

Plan an atomic approval request containing at minimum:

- `expectedVersionId`;
- `sourceImportId`;
- `expectedSourceRowDigest`;
- confirmation-ledger revision.

The confirmation ledger must cover:

- Product ID, raw SKU, raw Barcode state and English product name;
- evidence-backed producer/brand, vintage, volume, ABV, country/region and product type when used in copy;
- before/after/evidence for each of the eight output fields;
- awards, critic ratings, `Reserve`, `Grand Cru`, `珍藏`, `特級`, health claims, guarantees and superlatives;
- confirmation that prices, membership tiers, category, status, supplier and stock values are unchanged;
- both stock deltas are neutral;
- no image change exists in this Bulk Update file.

Invalidate approval when content, evidence, AI output, active version or source row digest changes. A fresh import with the same row digest may preserve content approval only if a new export/freshness attestation is recorded. Approval-time validation must validate the exact deliverable; do not wait until delivery to find invalid content.

#### Multi-product changed-row XLSX

The plan must close the gap between single-listing runtime export and the Site's batch export:

- emit two exact header rows plus only products with at least one approved change;
- include all 71 cells for every included product;
- permit differences only in the eight whitelisted cells;
- prove ten locked and 51 pass-through values are byte/semantic-equivalent to the fresh source;
- neutralize the two delta cells;
- exclude and report no-op products;
- reject mixed source contracts, stores or stale rows;
- create a manifest with product count, changed cells, per-field counts, excluded rows, neutralized deltas, source/output digests and version IDs;
- reparse the generated workbook before download and assert every invariant.

The plan must compare two approaches:

1. patch the fresh `Default` workbook while preserving its package structure, sheet identity, types, validations and styles; or
2. retain deterministic minimal generation only after real SHOPLINE UAT proves acceptance and zero identifier/numeric-format damage.

#### Opak UAT and go/no-go

Backend enforcement is required; UI-only limits do not count.

1. Attended contract UAT: 1–5 products.
2. Golden set: 30–50 products.
3. Shadow pilot: 50–100 products for two weeks, manual import only.
4. Catalog-scale rollout only after written Opak sign-off.

UAT should cover, where available:

- leading-zero SKU;
- leading-zero, alphanumeric and blank Barcode;
- Sale Price `0`;
- negative and unlimited raw inventory;
- blank/non-zero delta handling;
- multi-path categories;
- partial import results;
- a post-import re-export and reconciliation.

Acceptance requires:

- 100% header/workbook acceptance;
- 100% intended-row import success, with any partial success explicitly reconciled;
- zero identifier coercion;
- zero locked/pass-through changes;
- zero unintended stock, price, status, category or supplier changes;
- exactly the approved eight-field changes;
- complete audit evidence and a tested rollback source file.

Production remains No-Go if any source, workbook, digest, approval, locked-field, delta, identifier, variant, compliance, partial-import, rollback or authorization gate is unresolved.

Keep preview on `SHOPLINE_ADAPTER=mock`. Keep production acceptance on `SHOPLINE_ADAPTER=disabled` and `SHOPLINE_PUBLISH_ENABLED=false`. Real SHOPLINE writes require separate written authorization outside this plan.

### 12. Internationalisation contract

- Default locale: Hong Kong Traditional Chinese (`zh-HK`).
- Provide a real English toggle and persist locale by an approved cookie/user preference.
- Set `html lang`, metadata, titles, navigation, actions, errors, validation, empty states, live regions and ARIA labels correctly on every route.
- Keep SHOPLINE headers, Product ID, SKU, Barcode, API paths, status keys and raw merchant evidence untranslated.
- Avoid side-by-side duplicated bilingual interface copy except where the product field itself is bilingual.
- Plan number, currency, date, time and timezone formatting.
- Test missing keys, fallback, content expansion and locale persistence.
- Revalidate the Site's locale switch route by route; the audit found inconsistent behavior.

### 13. Accessibility, responsive behavior and performance

Target WCAG 2.2 AA.

Cover:

- landmarks, one logical H1 and heading hierarchy;
- skip links;
- keyboard navigation and visible focus;
- focus trapping/restoration in drawers and dialogs;
- accessible tables/cards and selection controls;
- form instructions and associated inline errors;
- status live regions without excessive announcements;
- contrast, reduced motion and 44px touch targets;
- mobile safe areas and no horizontal overflow;
- screen-reader names for icon-only actions;
- route loading and navigation feedback;
- performance budgets for app shell, catalog and review rather than arbitrary animation.

Define desktop and mobile visual-regression views for every affected route.

### 14. Security, privacy, observability and audit

For every proposed mutation, state:

- server-side authorization and minimum role;
- workspace source and RLS behavior;
- Zod validation;
- audit event;
- idempotency/version binding;
- log-redaction behavior;
- retry/rollback behavior.

Include:

- cross-workspace/RLS negative tests;
- XLSX MIME/signature/size/row validation;
- ZIP-bomb and decompression bounds;
- formula-injection defence if workbook preservation changes serialization;
- safe private-asset and presigned-URL handling;
- no credentials, signed URLs, prompts, model output or customer content in logs;
- import, batch, approval, export and manual SHOPLINE result correlation IDs;
- stale-source, version-conflict, partial-import and retry metrics;
- capability-truth telemetry without customer content.

Keep product-shot/image generation outside the confirmed Bulk Update scope. Note the inspected production-wiring gap and the review-client background-choice defect, but do not mix their repair into the Opak Bulk Update critical path unless the route split requires it.

### 15. Proposed architecture decisions

Write proposed ADRs, not silently accepted decisions, for at least:

1. Site-to-runtime adoption and anti-rewrite strategy.
2. Route ownership and backward-compatible IA.
3. Plain-CSS design tokens and component reuse.
4. zh-HK/English localisation architecture.
5. Public landing/auth/protected-app boundary.
6. Workspace-derived identity and tenant-specific Opak policy.
7. Page view models and API contracts.
8. Bulk Update import-session, digest, diff, review and export architecture.
9. Workbook preservation versus minimal XLSX generation.
10. Batch/job/quality read models.
11. Capability registry, feature flags and truthful states.
12. Rollout, reconciliation and rollback.

Each ADR must include context, decision, alternatives, consequences, compatibility, security effect, migration path and reversal trigger. Mark it **Proposed** and name the required decision owner.

### 16. File-level implementation sequence

Break the work into small, reviewable and reversible PR-sized packages. For each package provide:

- user outcome;
- dependencies;
- exact files and symbols to reuse/change/add;
- reuse disposition;
- API/data/migration impact;
- feature flag or capability state;
- authorization/audit/idempotency treatment;
- tests and commands;
- observability;
- acceptance evidence;
- rollback;
- size `S`, `M` or `L` rather than unsupported hour estimates.

Derive the actual order from dependencies, but normally cover:

A. Baseline and Opak contract freeze.  
B. Shared tokens, shell and real i18n with no domain behavior change.  
C. Public entry and functional auth layout.  
D. Read-only dashboard, catalog and queue.  
E. Bulk Update import, immutable source record and freshness gates.  
F. Attended batches and read persistence.  
G. Eight-field evidence review, confirmation ledger and approval binding.  
H. Multi-product changed-row XLSX and manifest.  
I. Jobs, manual import proof, quality and Admin capability truth.  
J. Accessibility, responsive, security and performance hardening.  
K. Controlled Opak UAT and staged rollout.

Include a dependency graph, critical path and recommended first PR. Do not hide large schema/security work inside a “frontend” PR.

### 17. Test and release gates

The plan must use the repository's real scripts and exact package commands, including where applicable:

```bash
pnpm format:runtime:check
pnpm runtime:forbidden:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
pnpm runtime:doctor
pnpm --filter @wukong/db audit:verify
```

Verify exact script names before placing them in work packages.

Plan tests for:

- route/function parity;
- public/protected route boundaries;
- both locales, desktop and 375px mobile;
- auth invitation/reset and role matrix;
- cross-workspace/RLS denial;
- catalog pagination/search/cohorts;
- batch persistence, 1–5 backend cap and idempotent advancement;
- eight-field review/edit/approval;
- expected-version and source-digest conflict;
- approval invalidation after content/evidence/source changes;
- exact 71-column golden round trip and workbook/cell types;
- leading-zero/alphanumeric/blank identifiers;
- blank, zero, negative and unlimited raw values;
- locked/pass-through equality and neutral deltas;
- multi-product changed-row export and manifest;
- partial SHOPLINE import recording and reconciliation;
- queue redelivery/idempotency and audit completeness;
- keyboard, screen reader, focus, contrast and reduced motion;
- visual regression and capability-truth states.

Current CI with fake AI/mock SHOPLINE proves a synthetic runtime path only. It is not evidence of real SHOPLINE workbook acceptance or production readiness.

### 18. Required plan document structure

Use this exact top-level order:

1. Executive recommendation and readiness verdict.
2. Evidence register and pinned versions.
3. Current-state architecture and runtime invariants.
4. Updated Site design/route/function inventory.
5. Route and function parity matrix.
6. Reuse and anti-rewrite matrix.
7. Confirmed gaps, contradictions and blockers.
8. Target information architecture and component ownership.
9. Proposed ADRs.
10. Data model, API, RLS and audit contracts.
11. Opak 71-column Bulk Update contract.
12. Authentication and public-entry plan.
13. Internationalisation plan.
14. Accessibility, responsive and performance plan.
15. Security, privacy, observability and audit plan.
16. File-level PR sequence and dependency graph.
17. Test strategy and commands.
18. Rollout, Opak UAT, go/no-go and rollback.
19. Risks, decisions, assumptions and stop conditions.
20. Recommended first PR.
21. Decisions required before the first PR.
22. Implementation-ready checklist.

### 19. Plan quality gates

Do not mark the plan complete unless:

- every discovered Site and runtime route appears exactly once in the parity matrix;
- every current-state claim has evidence;
- every Site action maps to a real or explicitly proposed contract;
- prototype/no-op states are not copied as production behavior;
- working auth/security/runtime behavior is not downgraded;
- every reused artifact and every replacement is named and justified;
- every database change includes RLS, migration, compatibility and rollback;
- every mutation includes role, validation, audit and idempotency/version treatment;
- the eight writable, ten locked, 51 pass-through and two neutral-delta fields are tested;
- review and export bind to the exact source import, row digest and version;
- file generation and SHOPLINE import confirmation remain separate;
- zh-HK/English, accessibility, responsive, loading, empty, error, stale, conflict, forbidden and retry states cover every affected route;
- rollout and rollback are executable;
- no phase enables production SHOPLINE writes;
- Unknown, Inferred and Proposed items are never presented as shipped capability.

### 20. Stop conditions

Stop and output a concise blocker report instead of inventing facts if:

- the repository, required instructions, Site or actual Opak workbook cannot be inspected sufficiently;
- source versions cannot be pinned;
- the workbook headers/digest conflict with repository fixtures and no owner can resolve the contract;
- the working tree contains overlapping uncommitted changes;
- the plan file already exists;
- Site behavior materially conflicts with runtime security/business rules and no decision owner exists;
- a proposal would weaken workspace scoping, RLS, audit, workflow validation, approval binding or queue idempotency;
- completion would require credentials, production data, SHOPLINE writes, a deployment or a database migration;
- a real variant is present but variant handling remains unvalidated;
- production readiness or merchant authorization is being assumed rather than evidenced.

If the real Opak workbook is unavailable, you may still produce a provisional repo/Site integration plan, but its verdict must be **Blocked pending workbook verification** and all workbook-dependent tasks must remain Unverified. Do not call it implementation-ready.

## MASTER INSTRUCTION ENDS

---

## Expected result from Claude Code Opus

Claude should return a plan, not code. The plan should make the first safe implementation slice obvious, preserve the existing runtime's strongest security and workflow foundations, and expose every Site-to-runtime gap instead of hiding it behind visual parity.
