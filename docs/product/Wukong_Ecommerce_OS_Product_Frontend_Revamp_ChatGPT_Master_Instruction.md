# ChatGPT / Codex Master Instruction — Wukong Ecommerce OS Product Frontend Revamp

**Version:** 2.0 — Strict execution specification  
**Updated:** 26 August 2026  
**Primary repository:** `https://github.com/YNWAforever/wukong-ecommerce-os`  
**Secondary repository:** `https://github.com/YNWAforever/wukong-ops-suite`

> 用途：把本文件整份交給 ChatGPT、Codex、ChatGPT Sites，或其他可修改前端／GitHub repository 的 coding agent。這不是單純視覺改版 prompt，而是一份產品、UX、工程、資料真確性、安全、測試與交付契約。

---

## 0. Operating Mandate

You are a world-class B2B SaaS product designer, ecommerce operations architect, information architect, accessibility specialist, design-system lead, senior Next.js engineer, frontend performance engineer, product analytics strategist, and production-readiness reviewer.

Revise and further develop Wukong into a credible, enterprise-ready **Evidence-first Ecommerce Catalog Operations OS**.

This assignment is **not** complete when the application merely looks more polished. Completion requires the operator journey, backend contracts, permissions, state transitions, evidence, error recovery, responsive behavior, accessibility, and product claims to remain truthful and verifiably functional.

### Command hierarchy

When instructions conflict, follow this order:

1. Current verified runtime behavior and security boundaries.
2. Database and domain invariants.
3. Existing tests and explicit acceptance criteria.
4. This product instruction.
5. Visual preference.

Never weaken a working invariant in order to simplify the frontend.

### Completion integrity

Do not report a feature as complete unless all of the following are true:

- the user can reach it through the real route;
- the action uses the real API or server action;
- the backend durably accepts or rejects it;
- the result survives refresh;
- permission and workspace boundaries are enforced server-side;
- failure, loading, empty, stale, and retry states exist;
- tests cover the critical path;
- the preview build is reviewable;
- the final report states what is live, pilot-only, mocked, blocked, or deferred.

A beautiful disconnected prototype is not a completed product frontend.

---

## 1. Product Positioning

Present Wukong as:

> An evidence-first catalog operations system that turns supplier files, product images, and existing platform records into reviewed, traceable, channel-ready catalog updates, while humans retain final approval.

Wukong is not primarily:

- a generic AI copywriter;
- a floating chatbot;
- an AI-image playground;
- an all-purpose CRM;
- an unverified autonomous eight-agent suite;
- a replacement for SHOPLINE or another merchant platform.

The initial product wedge is SHOPLINE catalog operations, piloted with Opak Cellar. The architecture may prepare for other categories and channels, but the interface must not imply that an unimplemented integration is live.

The frontend should communicate five product promises:

1. **Evidence before claims.** Facts and risky claims must show where they came from.
2. **Humans retain control.** AI proposes; authorized people review and approve.
3. **Every action has state.** Processing, approval, delivery, failure, and retry are explicit.
4. **Remote writes are safe.** Create versus update, duplicate safety, and current delivery state are understandable.
5. **Operations are recoverable.** Normal failures should not require direct database access.

---

## 2. Repository Boundary

### `wukong-ecommerce-os`

This is the authenticated product runtime and system of record. It owns:

- identity, session, workspace, membership, and role resolution;
- source assets and evidence;
- canonical listing and future catalog data;
- AI extraction, generation, evaluation, cost, and prompt versions;
- review, compliance, approval, delivery, retries, and audit;
- platform connectors and platform-product links;
- the operator-facing application.

### `wukong-ops-suite`

This is the public education, acquisition, qualification, and pilot-intake surface. It owns:

- positioning;
- use cases;
- capability truth;
- case studies;
- pilot packaging;
- demo conversion;
- secure lead or pilot handoff.

It must not become a second operational catalog application or a second source of truth.

---

## 3. Execution Modes

Determine the active tool mode before implementation.

### Mode A — GitHub / Codex implementation mode

When repository write access is available:

- inspect the latest branch and open pull requests;
- create a bounded feature branch from the correct base;
- change production code, tests, and documentation;
- open or update a pull request;
- run the full repository verification pipeline;
- save a reviewable preview deployment;
- do not push directly to `main`;
- do not enable real SHOPLINE writes without explicit operator approval.

### Mode B — ChatGPT Sites design mode

When only a design/prototype environment is available:

- reproduce every in-scope route and state as a high-fidelity product prototype;
- preserve route/function parity in the design;
- use an explicit prototype adapter or fixture boundary;
- label prototype-only data and actions internally;
- never claim that a backend mutation, email, upload, publish, retry, or audit action is integrated unless it actually is;
- deliver an implementation handoff containing component specs, route map, API contracts, design tokens, states, and responsive behavior;
- do not publish the prototype as the production application.

### Mode C — Hybrid mode

When ChatGPT Sites is used for design and Codex for implementation:

- keep the design artifact and runtime repository separate;
- maintain one shared route/function parity document;
- map every designed component to a real route, API, role, and state;
- treat the runtime repository as the final source of truth.

---

## 4. Required Onboarding Before Any Redesign

Inspect the latest repository state. Read at minimum:

- `CLAUDE.md`
- `CONTEXT.md`
- root and workspace `package.json` files
- `apps/web/app/**`
- `apps/web/components/**`
- `apps/web/lib/**`
- `packages/core/src/**`
- `packages/db/src/schema.ts`
- `packages/db/src/repositories/**`
- `packages/ai/src/**`
- `packages/shopline/src/**`
- `packages/assets/src/**`
- `packages/jobs/src/**`
- `apps/worker/src/**`
- current unit, integration, and Playwright tests
- `docs/product/ecommerce-os-product-plan.md`
- `docs/product/catalog-control-center-acceptance.md`
- current open and recently merged pull requests affecting admin, catalog, product shots, bulk approval, enrichment, publishing, authentication, or runtime reliability.

Do not infer a capability from a component name or marketing sentence. Trace the complete path:

```text
UI control
→ request contract
→ API / server action
→ role check
→ workspace scope
→ repository / domain mutation
→ audit or job record
→ response contract
→ refreshed UI state
```

If any link is absent, classify the feature as incomplete.

---

## 5. Mandatory Baseline Artifacts

Before significant code changes, create or update the following artifacts under `docs/product/frontend-revamp/`:

1. `route-function-parity.md`
   - every page route;
   - every API route;
   - purpose;
   - actor roles;
   - input and output;
   - current UX state;
   - redesign status;
   - test coverage.

2. `role-action-matrix.md`
   - viewer, operator, reviewer, admin, owner;
   - visible navigation;
   - read actions;
   - edit actions;
   - approval actions;
   - delivery actions;
   - administration actions;
   - backend enforcement location.

3. `frontend-state-matrix.md`
   - loading;
   - empty;
   - success;
   - partial data;
   - validation failure;
   - permission denied;
   - stale version;
   - backend unavailable;
   - retryable failure;
   - non-retryable failure;
   - mobile behavior.

4. `current-frontend-findings.md`
   - severity;
   - evidence file/path;
   - operator impact;
   - proposed fix;
   - acceptance test.

5. `design-system-contract.md`
   - tokens;
   - typography;
   - density;
   - statuses;
   - focus;
   - responsive breakpoints;
   - reusable primitives;
   - prohibited one-off patterns.

6. Baseline screenshots or browser captures for every route at:
   - 1440px desktop;
   - 1024px tablet;
   - 375px mobile;
   - at least one loading, empty, failure, and permission state.

Do not start a broad visual refactor without these baseline artifacts.

---

## 6. Verified Current Frontend Findings — Treat as P0/P1 Until Rechecked

The following findings were observed in the current frontend branch on 26 August 2026. Re-verify them against the latest code, then fix them or document why the implementation has changed.

### P0 — Product truth and safety

1. **Shared identity remains hard-coded.**
   - Shared shell, dashboard, sign-in, registration, and footer still reference `Opak Cellar`, `Opak operator`, or a permanent `PILOT` label.
   - Replace these with a server-derived application-shell context.
   - Do not accept workspace identity from client JSON.

2. **Unsaved edits can be followed by approval.**
   - The review form keeps local field edits, while the approval action can approve the currently persisted version.
   - Add dirty-state detection and prevent approval until edits are saved, or implement one atomic save-and-approve contract with optimistic concurrency.
   - Never silently discard unsaved edits.

3. **Product-shot background choice is not sent by the review client.**
   - The UI stores `white` or `brand`, and the approval API accepts `background`, but the current approval request sends an empty object.
   - Send the selected choice, test both values, test no-cutout fallback, and verify the persisted final asset.

4. **Invitation success copy overstates reality.**
   - Workspace administration currently says “Invite sent” after creating an invitation record, while email delivery is an explicit non-goal of the merged admin implementation.
   - Use truthful copy such as “Invitation created” and expose a safe manual sharing or copy-link workflow only if the backend supports it.

5. **Upload retry copy does not match client behavior.**
   - The UI says successful files will not be uploaded again, but retrying the current client flow begins new presign/upload/finalize calls and asset keys use random UUIDs.
   - Either persist per-file finalized asset IDs and resume safely, or remove the promise.
   - Show real per-file state, not a simulated shared `uploading` state.

6. **Bulk approval does not fully handle HTTP failure and partial outcomes.**
   - Check `response.ok`, validate the response shape, keep successful and failed rows visible, support retry of failed items, and never clear selection before a valid result is received.
   - Add deliberate confirmation that states exactly how many listings will be approved.

7. **Dangerous actions lack adequate confirmation.**
   - Approval, publish, token rotation, member removal, role change, and invitation revocation must use consequence-specific confirmation patterns.
   - Confirmation must not rely on a generic browser `confirm()`.

### P1 — State truth, workflow clarity, and recoverability

8. **Domain states are collapsed in the UI.**
   - `reopened` is displayed as `in_review`, `publishing` as `approved`, and `publish_failed` as generic `failed` in some view models.
   - Preserve the exact domain status in contracts and analytics.
   - A separate display cohort may group statuses, but it must not erase the true state.

9. **Compliance severity and affected field are not fully represented.**
   - The review model treats flags as one blocking type and does not clearly render severity or the affected field.
   - Separate blocking versus warning flags, link each flag to its field and evidence, and preserve the backend rule code.

10. **Evidence navigation is incomplete.**
    - `EvidencePanel` supports an active field but the review client does not connect field focus to it.
    - Source IDs are shown as raw identifiers rather than useful file metadata or preview links.
    - “Saved” must not be presented as “verified.”

11. **Delivery state is dropped.**
    - The listing response contains delivery status, queue status, remote ID, and errors, but the view model exposes little of it and sets the remote URL to `null`.
    - Show create/update intent, queue state, attempt state, error category, retry eligibility, remote product, version, and last update.
    - Include the existing bulk-form path where applicable.

12. **Connected does not necessarily mean publishing is enabled.**
    - Distinguish credential connection, successful verification, connector capability, environment publish flag, and the operator’s permission.
    - Do not promise that a connected store can be written to unless all gates are open.

13. **Dashboard metrics are sample-derived and semantically weak.**
    - The current list endpoint returns a bounded recent collection, while the UI presents counts as operational totals.
    - Use aggregate queries for true totals or label the figures as “within the current result set.”
    - “Blocked” must include the agreed business definition, not only generic failed statuses.

14. **Catalog summary is based on the most recent 100 records.**
    - Do not label sample counts as full-catalog KPIs.
    - Add server-side search, cursor pagination, sorting, aggregate counts, result-set context, and data-freshness information.

15. **Unlinked catalog action loses platform-product context.**
    - Linking an unlinked row to generic `/listings/new` does not preserve its remote product, source row, digest, or facts prefill.
    - Implement an explicit “Create linked draft” action with idempotency and mirror-link preservation.

16. **Catalog mobile behavior is still a 900px table with horizontal scrolling.**
    - Provide a real mobile card or stacked-row representation.
    - Keep status, blockers, SKU, source, and primary action visible without horizontal exploration.

17. **Catalog and dashboard loading/error states are minimal.**
    - Add skeletons, retry actions, stale-data messaging, background refresh state, and session-expiry handling.
    - Do not leave a failed page as one uncontextualized warning line.

18. **Roadmap copy appears inside operational UI.**
    - Do not use live product screens to advertise future features such as “next phase will add…”.
    - Keep roadmap messaging in release notes, capability pages, or documentation.

### P1 — Administration and authentication

19. **Admin tabs are local-only UI state.**
    - Add URL-addressable tabs or nested routes.
    - Support arrow-key tab behavior, focus management, refresh persistence, and unsaved-change protection.

20. **Admin mutations use one global busy state.**
    - Use row/action-level pending states so unrelated controls remain understandable.
    - Preserve the prior value on failure and show the error beside the affected action.

21. **Member and token actions need better consequence copy.**
    - Explain role capabilities in plain language.
    - Show last-admin and self-action restrictions before the request fails.
    - Token rotation must explain that the old token becomes unusable and must offer Cancel.

22. **Authentication surfaces remain pilot-specific and copy is partly misleading.**
    - Remove Opak-specific branding from reusable auth routes.
    - Replace “Request admin access” with invite-only registration language unless a real request-access workflow exists.
    - Preserve anti-enumeration behavior.

### P2 — Code and design-system debt

23. **Runtime view-model files contain fallback demo objects.**
    - Remove unused production fallback catalog/review data or isolate fixtures under test/story/demo boundaries that cannot enter production behavior.

24. **Global CSS and route-specific CSS follow mixed patterns.**
    - Consolidate tokens and primitives without a big-bang rewrite.
    - Avoid generic global selectors such as `.active` for unrelated components.

25. **The review form lacks provenance changes after human edits.**
    - A human-edited field must not continue to look like the untouched AI value with the same confidence.
    - Show origin, dirty state, changed state, evidence state, and saved version.

These findings are not optional design suggestions. They are the initial defect ledger for the revamp.

---

## 7. Non-negotiable Product Rules

- Do not bypass human approval.
- Do not permit AI to silently publish or overwrite protected facts.
- Do not fabricate metrics, remote state, price, inventory, usage, connector support, or delivery success.
- Do not show success until the backend durably accepts the operation.
- Do not use fake production data or silent fallback data.
- Do not derive workspace authority from client input.
- Do not expose access tokens, credentials, signed URLs beyond intended use, or secret-bearing exceptions.
- Do not weaken RLS, role checks, audit writes, idempotency, leases, retries, or optimistic concurrency.
- Do not redesign only the dashboard and stop.
- Do not remove an existing function because it is visually inconvenient.
- Do not turn durable jobs into long browser requests.
- Do not label Planned capability as Live.
- Do not enable real platform writes or replace production without explicit approval.
- Do not combine approval and publishing into one ambiguous control.
- Do not approve a stale version or a version that differs from the visible edited state.
- Do not report browser verification unless an authenticated browser flow was actually tested.

---

## 8. Capability Truth Model

Every major capability must be one of:

- **Live** — production-wired and covered by current tests.
- **Pilot** — implemented but restricted by merchant, environment, category, feature flag, or approval process.
- **Planned** — no complete production workflow exists.

Re-verify the following guidance:

### Live or Pilot candidates

- SHOPLINE listing intake and review;
- evidence-backed extraction and generation;
- English and Traditional Chinese content;
- human approval;
- compliance flags;
- audit history;
- CSV, bulk-form, and SHOPLINE delivery paths;
- publishing retries and job state;
- SHOPLINE catalog import/export;
- platform-product mirror;
- Catalog Control Center;
- workspace administration;
- product-shot review and flattening only when the production path is enabled and the selected background is correctly persisted.

### Planned until verified

- Shopify;
- Carousell;
- HKTVmall;
- end-to-end Google Merchant sync;
- WhatsApp customer-service automation;
- supplier intelligence as a complete module;
- logistics operations;
- order management;
- fulfilment and returns;
- campaign operations;
- a complete autonomous eight-agent suite.

The authenticated product should focus on operational work. Capability marketing belongs in the public site or a dedicated integration/capability page.

---

## 9. Route and Function Parity

Crawl the current App Router and API tree. Do not rely only on this list.

Expected user routes include:

- `/`
- `/signin`
- `/register`
- `/forgot-password`
- `/reset-password`
- `/dashboard`
- `/catalog`
- `/listings/new`
- `/listings/[id]`
- `/admin`

Expected functional areas include:

- authentication and invite-only registration;
- asset presign, upload, and finalize;
- listing creation and processing;
- processing retry;
- collection and work queue;
- catalog mirror and linkage;
- review editing and optimistic concurrency;
- evidence;
- compliance resolution;
- approval and bulk approval;
- product-shot choice and finalization;
- CSV, bulk-form, and SHOPLINE delivery;
- create-versus-update publishing;
- publish jobs and recovery;
- workspace members and invitations;
- SHOPLINE connection and token rotation;
- workspace settings;
- audit and operational verification.

Every redesign pull request must update `route-function-parity.md` for the routes it touches.

---

## 10. Target Information Architecture

### Primary navigation

Use a consistent authenticated shell with:

1. **Overview** — operational priorities and system health.
2. **Catalog** — product mirror, linkage, sync, blockers, and channel state.
3. **Work Queue** — actionable review, information, failure, and delivery cohorts.
4. **Create / Import** — files, platform catalog import, and linked-draft creation.
5. **Jobs / Recovery** — only when backed by real pipeline, enrichment, and publish data.
6. **AI Quality / Usage** — only when backed by real AI run and evaluation data.
7. **Admin** — role-gated.

Do not create empty navigation destinations to make the product appear larger.

### Application-shell contract

Create a server-derived shell context containing only safe display information:

- workspace name;
- workspace status or pilot context when persisted;
- authenticated user display name or email;
- role;
- available navigation from permissions;
- connection health summary when supported;
- sign-out action.

The shell context must not become a second source of authorization. APIs still enforce roles and workspace scope.

### Desktop

Use a stable sidebar or compact navigation rail for operational density. Keep page title, environment/workspace context, and primary action clear.

### Mobile

Use a proper navigation drawer or compact bottom/top navigation. Preserve current-page state, role-gated links, sign-out, and keyboard/focus behavior.

---

## 11. Visual and Design-System Direction

The product should feel:

- calm;
- evidence-led;
- operational;
- trustworthy;
- precise;
- high-density without being cramped;
- suitable for prolonged back-office use.

Avoid:

- generic AI gradients as the primary visual language;
- oversized marketing headings inside operational screens;
- decorative dashboards with fake charts;
- glassmorphism that reduces contrast;
- excessive rounded cards around every field;
- colour-only status meaning;
- duplicated complete Chinese and English paragraphs in dense workflows;
- emoji as the only status communication;
- speculative agent illustrations inside core operations.

### Token system

Define semantic tokens rather than page-specific colours:

- canvas;
- surface;
- raised surface;
- text primary/secondary/muted;
- border subtle/strong;
- focus;
- action primary/secondary/destructive;
- status neutral/info/warning/blocking/success;
- evidence supported/missing/human-edited;
- sync in-sync/pending/conflict/failure/unsupported.

### Required reusable primitives

At minimum:

- AppShell
- Sidebar / MobileNav
- PageHeader
- Breadcrumbs
- StatusBadge
- CapabilityBadge
- MetricCard with scope label
- DataTable
- MobileRecordCard
- FilterBar
- SearchField
- Pagination
- EmptyState
- ErrorState with retry
- Skeleton
- InlineFieldError
- EvidenceBadge
- EvidencePanel
- FieldProvenance
- ComplianceFlag
- VersionBadge
- DiffViewer
- JobStatus
- ConnectionStatus
- ConfirmationDialog
- DestructiveActionDialog
- Toast for secondary feedback only
- StickyActionBar
- Drawer / Sheet

Do not duplicate status mappings across pages.

---

## 12. Route-level Product Contracts

## 12.1 Overview — `/dashboard`

Purpose: tell the operator what requires attention now.

Required:

- server-scoped workspace identity;
- data freshness and result scope;
- true aggregate counts or clearly labelled sample counts;
- priority work ordered by business urgency;
- separate cohorts for missing information, review, blocking compliance, publish failure, and processing failure;
- job/system health where backed by data;
- clear next action per item;
- background refresh state;
- retry for load failure;
- empty-workspace onboarding.

Do not use greeting copy as the main information hierarchy.

Bulk approval must:

- select only currently eligible items;
- explain why ineligible rows cannot be selected;
- confirm exact count and consequence;
- validate the HTTP result;
- display per-item success and failure using product title/SKU, not only UUID;
- preserve failed selection for retry;
- prevent duplicate submissions.

## 12.2 Catalog Control Center — `/catalog`

Purpose: become the central control plane for platform products and Wukong workflows.

Required server contract:

- cursor pagination;
- server-side search;
- sorting;
- aggregate counts independent of the current page;
- channel and connection context;
- data freshness / last import or sync time;
- exact listing status;
- link state;
- blocker count by severity;
- remote product ID;
- origin;
- source/spec version;
- next action;
- capability state where relevant.

Required filters:

- all;
- unlinked;
- needs information;
- needs review;
- blocking compliance;
- approved / ready to deliver;
- publishing;
- published;
- publish failed;
- processing failed;
- imported versus Wukong-created;
- future sync states only when real backend data exists.

Required interactions:

- URL-persisted query, filters, sort, and page cursor where practical;
- details drawer or product page;
- open linked workflow;
- create linked draft from platform product;
- bulk actions only when the backend supports safe cohort actions;
- retry and refresh;
- keyboard-operable rows and drawer;
- mobile record cards rather than a desktop table requiring 900px horizontal scroll.

The “create linked draft” path must preserve:

- platform-product row;
- remote product ID;
- connection ID;
- raw imported row;
- facts prefill;
- content digest;
- source/spec version;
- idempotency;
- audit event.

## 12.3 Create / Import — `/listings/new`

Offer explicit entry paths:

1. Create from files and notes.
2. Import or refresh a SHOPLINE bulk form.
3. Create from an existing unlinked platform product.

File intake must provide:

- drag and drop plus accessible file picker;
- append, remove, and replace behavior;
- real file type, size, count, and composition validation;
- actual per-file state;
- persisted finalized asset ID;
- safe resume or truthful restart behavior;
- retry only the failed step where possible;
- clear orphan-cleanup policy for uploaded-but-unlinked assets;
- real processing enqueue result;
- no false “uploaded” or “not uploaded again” statement.

Processing must show:

- draft created;
- queue accepted or retry required;
- current pipeline status;
- last update;
- failure category;
- retry eligibility;
- safe navigation away and return.

## 12.4 Listing Review — `/listings/[id]`

Use a review workspace, not one long form.

### Desktop layout

- left: source/evidence navigation;
- center: fields and bilingual content;
- right: compliance, version, and delivery readiness;
- sticky bottom action bar.

### Mobile layout

- tabs or drawers for Fields, Evidence, Compliance, and Delivery;
- sticky safe actions without covering fields;
- preserve field/evidence context.

### Field contract

Every field should represent:

- current value;
- required/optional status;
- data type and constraints;
- provenance: imported, extracted, generated, human-edited;
- evidence state;
- confidence only while meaningful;
- dirty state;
- validation error;
- version changed state;
- protected-fact status.

After human editing, do not continue presenting the original AI confidence as though the value is unchanged.

### Evidence contract

- selecting/focusing a field filters or focuses matching evidence;
- selecting evidence highlights affected fields;
- show file name, asset type, page, excerpt, and confidence;
- provide safe preview/download where available;
- distinguish “stored,” “supported,” “verified,” and “missing”;
- do not show only raw source UUIDs.

### Bilingual contract

- side-by-side on wide screens;
- tabs on smaller screens;
- character counts and channel limits;
- terminology consistency;
- no full duplicate paragraph noise;
- preserve SEO, tags, images, and non-edited canonical fields.

### Compliance contract

- separate blocking and warning;
- show affected field;
- show rule code and plain-language explanation;
- show evidence gap;
- link to the field;
- show resolution actor/time/reason when available;
- keep approval disabled for unresolved blocking flags;
- do not let a reason alone visually imply that the underlying content was fixed unless policy allows an explicit override.

### Version and concurrency contract

- show current version and base version;
- show unsaved changes;
- show human versus AI changes;
- offer before/after diff;
- prevent approval of stale or hidden content;
- handle 409 stale-version response with a compare/reload flow;
- warn before navigation with unsaved edits.

### Approval contract

- approval is a deliberate action;
- confirmation identifies listing, version, unresolved warnings, and product-shot choice;
- the selected product-shot background must be included in the API request;
- save-before-approve or atomic save-and-approve must be guaranteed;
- result must refresh to the exact persisted status and version.

## 12.5 Delivery and Sync

Before delivery show:

- channel;
- connection domain and verification state;
- publish enablement state;
- permission gate;
- create versus update;
- remote product ID when known;
- listing version;
- payload validation;
- blocking flags;
- image readiness;
- delivery method: CSV, bulk form, or API;
- duplicate-safety explanation;
- consequence-specific confirmation.

After delivery show:

- queued;
- current publish job status;
- attempt count;
- last attempt;
- last update;
- remote product ID/link;
- success;
- error category;
- retry eligibility;
- next retry or recovery action.

Do not discard `delivery.status`, `queueStatus`, or `delivery.error` in the frontend view model.

Prepare, but do not fake, future reconciliation states:

- in sync;
- local changes pending;
- remote changes detected;
- conflict;
- delivery failed;
- unsupported.

## 12.6 Jobs and Recovery

Only create a dedicated route when real job data is available.

Show pipeline runs, enrichment batches, and publish jobs with:

- entity/SKU;
- type;
- status;
- attempt;
- timestamps;
- cost where relevant;
- failure category;
- retry eligibility;
- operator-safe explanation;
- audit link.

Do not expose implementation jargon such as a lease token unless it directly helps the operator.

## 12.7 AI Quality and Usage

Only use real `ai_runs`, prompt versions, evaluation data, and approved product analytics.

Possible views:

- cost per completed SKU;
- spend over time;
- model and prompt version;
- task type;
- latency;
- required-fact recall;
- unsupported protected facts;
- first-pass approval;
- human edit distance;
- failure and retry rate.

This is an operational quality screen, not a model leaderboard.

## 12.8 Admin

Use URL-addressable tabs or nested routes:

1. Members
2. Invitations
3. Integrations
4. Brand and policy
5. Workspace settings
6. Usage and plan when implemented
7. Data retention/export when implemented
8. Audit access when implemented

Members/invitations:

- plain-language role descriptions;
- actor-level pending state;
- truthful invitation state;
- invitation expiry and link only when supported;
- confirmation for role change/removal/revocation;
- proactive explanation of last-admin and self-action restrictions;
- responsive table/card view.

SHOPLINE integration:

- domain;
- credential configuration state;
- verification state;
- last verified time;
- connector capability;
- publish enablement;
- safe token rotation with confirmation and cancel;
- never render stored token values.

Settings:

- only persist settings used by the runtime;
- show saved versus unsaved state;
- support reset/clear where the backend supports it;
- explain where the setting is used.

## 12.9 Authentication and Onboarding

Authentication must remain invite-only unless a real self-service access-request flow is implemented.

Required:

- reusable Wukong branding, not hard-coded Opak branding;
- clear invite-only registration copy;
- anti-enumeration preserved;
- safe callback handling;
- accessible labels and status;
- session-expiry flow;
- password visibility and requirements where appropriate;
- generic public response but useful safe operational logging;
- no promise that an email was sent when mail was not attempted or accepted.

First-run onboarding should be based on persisted state:

1. Workspace context
2. SHOPLINE connection
3. Catalog import or first listing
4. Required fields and claim policy
5. Invite reviewer/operator
6. Review first draft
7. Controlled publish

Do not mark a step complete from local browser state alone.

---

## 13. Interaction and State Integrity

For every mutation:

- disable only the affected action where possible;
- protect against double submission;
- validate `response.ok`;
- validate response shape;
- show typed, actionable errors;
- keep the visible result until acknowledged;
- refresh or reconcile server state;
- preserve successful partial results;
- retain failed items for retry;
- announce important changes accessibly;
- never rely only on a toast.

For destructive or irreversible actions use a dedicated dialog with:

- object name;
- exact consequence;
- create versus update where relevant;
- version or member/role context;
- cancel as the safe default;
- progress state;
- final durable result.

---

## 14. Frontend Engineering Requirements

Follow the current repository versions and conventions. Do not downgrade dependencies.

### Architecture

- Use Next.js App Router correctly.
- Prefer Server Components for initial data and shell context.
- Use Client Components only for interaction that requires them.
- Keep route/API contracts typed and runtime-validated.
- Centralize exact domain status mapping.
- Separate exact status from display cohort.
- Keep search/filter/sort/page in URL state where useful.
- Avoid N+1 queries.
- Use aggregate queries for aggregate metrics.
- Use cursor pagination for catalog scale.
- Use error boundaries and route-level loading states.
- Do not duplicate request/error helpers across every component without reason.
- Do not introduce a large state-management library unless the current complexity demonstrates the need.

### Data fetching

- Avoid blank client-only initial screens when safe server rendering is practical.
- Distinguish initial load, background refresh, stale data, and action pending.
- Cancel obsolete requests.
- Prevent interval polling from continuing when the page is hidden when practical.
- Back off or stop polling after terminal state or repeated failure.

### Styling

- Consolidate semantic tokens.
- Prefer scoped modules or established primitives.
- Remove global one-off styles only after parity is proven.
- Do not introduce a heavy component library only for visual polish.
- Keep bundle impact documented.

### Performance

Create a baseline before claiming improvement.

At minimum:

- no unnecessary full-page client hydration;
- no large unpaginated catalog payload;
- no avoidable duplicate fetch on initial render;
- image previews appropriately sized;
- no layout overflow at 375px;
- no material regression in route JS or production build output without explanation;
- use Core Web Vitals or an equivalent measured preview baseline where available.

### Runtime safety

- Never expose secret-bearing messages.
- Never log product content, customer files, credentials, signed URLs, or personal data in analytics.
- Treat files and platform payloads as untrusted.
- Preserve CSRF/same-origin, MIME, size, count, and rate-limit controls.

---

## 15. Accessibility Contract

Meet WCAG 2.2 AA where practical.

Required:

- semantic landmarks;
- one meaningful H1 per page;
- logical heading hierarchy;
- keyboard-operable navigation, tabs, drawers, dialogs, tables, filters, and bulk selection;
- visible focus;
- roving focus or correct arrow-key behavior for true tablists;
- focus restoration after dialogs/drawers;
- accessible names for icon controls;
- errors linked to fields;
- `aria-live` only where useful, not noisy;
- status meaning not dependent on colour;
- no hover-only information;
- reduced-motion support;
- 44px touch targets on mobile;
- mobile alternatives to dense tables;
- correct language metadata;
- no automatic focus stealing during background refresh.

Test keyboard-only navigation and a 375px viewport for every primary route.

---

## 16. Copy and Language Rules

Use concise, operational copy.

Preferred pattern:

- Traditional Chinese primary label;
- short English secondary label only where it helps cross-team use;
- no duplicated full paragraphs in two languages in dense screens.

Tone:

- calm;
- precise;
- non-judgmental;
- consequence-aware;
- action-oriented.

Avoid:

- “Unlock limitless AI potential”;
- “Autonomous agent magic”;
- “One-click perfect content”;
- “Connected” when only credentials were stored;
- “Sent” when only a database record was created;
- “Verified” when an object is merely stored;
- “All catalog products” when only 100 records were loaded.

Prefer:

- “2 required fields need evidence.”
- “You have unsaved edits. Save before approval.”
- “This will update SHOPLINE product 12345 using listing version 7.”
- “Invitation created. Email delivery is not configured.”
- “83 products shown from the latest import; 1,240 products in the catalog.”

---

## 17. Product Analytics

Instrument only after confirming the project analytics boundary.

Suggested events:

- dashboard_viewed
- catalog_viewed
- catalog_searched
- catalog_filter_applied
- platform_product_opened
- linked_draft_started
- evidence_opened
- listing_edit_saved
- stale_version_detected
- compliance_flag_resolved
- listing_approved
- bulk_approval_completed
- delivery_started
- delivery_succeeded
- delivery_failed
- retry_started
- onboarding_step_completed

Do not include raw product content, tokens, file names containing personal data, customer messages, or credentials.

Measure merchant outcomes:

- median source-to-publish time;
- human minutes per SKU;
- first-pass approval rate;
- evidence coverage;
- publish success after retry;
- AI cost per completed SKU;
- linked catalog percentage;
- in-sync percentage when reconciliation exists;
- human edit distance;
- weekly active operators;
- completed work items.

---

## 18. Public `wukong-ops-suite` Alignment

After the runtime frontend is stable:

- lead with evidence-first catalog operations;
- add Live / Pilot / Planned badges;
- remove or qualify unsupported Shopify, Carousell, HKTVmall, Google Merchant, WhatsApp, logistics, order, and full-agent claims;
- replace unsupported self-service pricing with scoped pilot/design-partner packaging until plans, entitlements, metering, and billing exist;
- connect the demo form to a protected server-side lead endpoint;
- persist the lead and accepted uploads before success;
- provide consent, privacy, retention, anti-bot, rate limiting, idempotency, and structured failure handling;
- return a lead or trial ID for runtime handoff;
- never store the operational catalog in the marketing application.

---

## 19. Bounded Delivery Plan

Do not combine every stage into one unreviewable pull request.

## Stage 0 — Truth and safety corrections

Fix before broad redesign:

- product-shot background request wiring;
- unsaved-edit approval protection;
- exact status preservation;
- invitation truth copy;
- upload retry truth/resume behavior;
- bulk approval HTTP/partial-result handling;
- delivery/queue/error visibility;
- consequence-specific confirmations.

Acceptance:

- focused regression tests fail before and pass after;
- no schema migration unless independently justified;
- full CI green;
- reviewable PR.

## Stage 1 — Audit, shell, and design foundation

Deliver:

- required baseline artifacts;
- session-derived shell context;
- reusable navigation;
- design tokens and primitives;
- route-level loading/error boundaries;
- mobile navigation;
- removal of shared hard-coded Opak identity;
- removal or isolation of production fallback demo data.

Acceptance:

- route parity preserved;
- role navigation correct;
- keyboard and focus pass;
- 375px shell usable;
- no fake workspace switcher.

## Stage 2 — Dashboard and Catalog

Deliver:

- true aggregate dashboard metrics;
- priority work cohorts;
- robust bulk approval;
- server-side catalog search, sort, pagination, and aggregates;
- mobile catalog cards;
- details drawer;
- linked-draft creation;
- freshness and refresh behavior.

Acceptance:

- totals are truthful;
- workspace scoping tested;
- filters persist;
- generic `/listings/new` is not used for a linked platform-product action;
- no 900px-only mobile table.

## Stage 3 — Intake and Review

Deliver:

- explicit intake modes;
- real per-file upload/resume states;
- processing recovery;
- evidence-linked fields;
- provenance and dirty state;
- bilingual editing;
- compliance severity/field linkage;
- version diff;
- safe approval including product-shot choice.

Acceptance:

- unsaved edits cannot be lost or bypassed;
- stale version is handled;
- blocking flags prevent approval;
- evidence navigation works by keyboard;
- mobile review is usable.

## Stage 4 — Delivery, Jobs, Admin, and Onboarding

Deliver:

- complete delivery state;
- retry/recovery actions;
- jobs view when supported;
- URL-addressable admin IA;
- truthful invitations;
- integration verification and publish enablement states;
- persisted onboarding.

Acceptance:

- no secret leakage;
- ordinary failures recover without database access;
- permissions enforced server-side;
- mutations audited;
- admin tables/cards usable on mobile.

## Stage 5 — Quality, Usage, and Public Alignment

Deliver:

- AI quality and cost view backed by real data;
- merchant outcome reporting;
- capability matrix;
- revised public site;
- persisted pilot intake.

Acceptance:

- public and runtime capability states agree;
- no unsupported Live claim;
- no form success without persistence.

---

## 20. Verification Matrix

Run the full repository pipeline and add route-specific tests.

### Required repository gates

- runtime formatting;
- forbidden legacy-runtime check;
- build;
- migrations where applicable;
- lint;
- TypeScript;
- unit tests;
- integration tests;
- production Next build;
- native dependency bundling checks;
- Playwright acceptance;
- audit verification;
- Vercel preview.

### Required role coverage

Verify representative routes/actions as:

- signed out;
- viewer;
- operator;
- reviewer;
- admin;
- owner.

### Required workflow coverage

Verify:

- received;
- processing;
- needs_info;
- in_review;
- reopened;
- approved;
- publishing;
- published;
- publish_failed;
- failed.

### Required viewport coverage

- 1440px;
- 1024px;
- 768px;
- 375px.

### Required browser evidence

For every changed primary route:

- authenticated screenshot;
- mobile screenshot;
- empty/loading/failure screenshot or automated assertion;
- console error check;
- overflow check;
- focus-order check;
- reduced-motion check.

Do not claim visual verification when the preview was inaccessible and no authenticated browser test ran.

---

## 21. Pull Request and Change-Control Rules

- One bounded stage or coherent slice per PR.
- Include before/after screenshots.
- Include route/function parity changes.
- Include test evidence.
- Include migration/deploy order when applicable.
- Do not mix a major data-model migration with a broad visual rewrite.
- Do not push directly to `main`.
- Preserve reviewable commits.
- Keep feature flags and real platform writes disabled unless explicitly approved.
- State known limitations in the PR body.
- A green build is necessary but not sufficient; verify the operator workflow.

---

## 22. Definition of Done

The frontend revamp is complete only when:

1. Every in-scope route is implemented and reviewed.
2. Existing functions and backend integrations are preserved.
3. Shared identity is session-derived.
4. Exact workflow states remain truthful.
5. Catalog metrics and scopes are truthful.
6. Evidence, provenance, and compliance are first-class.
7. Unsaved or stale content cannot be approved accidentally.
8. Product-shot choice reaches and affects the approval path.
9. Delivery exposes create/update, queue, attempt, error, retry, remote state, and method.
10. Invitations and uploads use truthful copy.
11. Loading, empty, permission, error, stale, and mobile states are complete.
12. Keyboard and accessibility checks pass.
13. Full CI and production build pass.
14. An authenticated reviewable preview exists.
15. Production is not replaced and publish flags are not enabled without explicit approval.

---

## 23. Required Final Report

At the end of each stage report:

### Completed

- routes changed;
- components created/consolidated;
- APIs used/added;
- defects fixed;
- UX states completed;
- tests added.

### Product truth

- Live;
- Pilot;
- Planned;
- mocked or design-only;
- feature flags still disabled.

### Preserved

- workspace isolation;
- role gates;
- audit behavior;
- approval rules;
- publishing/idempotency behavior;
- existing routes.

### Verification

- commands;
- CI run;
- browser sizes;
- roles tested;
- console/accessibility findings;
- preview status;
- screenshots.

### Deferred

- backend dependencies;
- known limitations;
- blocked items;
- next bounded sprint.

### Release recommendation

Choose one:

- Ready for review
- Ready to merge but not enable production writes
- Blocked by a verified issue
- Not ready to merge

Never describe placeholder UI as a completed feature.

---

## 24. Immediate Implementation Order

Begin in this order:

1. Re-run repository onboarding and generate the required baseline artifacts.
2. Fix the P0 truth/safety defects before broad visual work.
3. Remove hard-coded shared identity using a server-derived shell context.
4. Establish the token system, primitives, responsive navigation, and error/loading patterns.
5. Correct dashboard metric scope and bulk approval behavior.
6. Upgrade Catalog with server search, cursor pagination, aggregate counts, mobile cards, freshness, and linked-draft creation.
7. Rebuild Review around dirty state, provenance, field-linked evidence, severity-aware compliance, version diff, and safe approval.
8. Surface complete delivery/job state and recovery.
9. Improve URL-addressable admin, truthful invitations, integrations, and persisted onboarding.
10. Align `wukong-ops-suite` with capability truth and persisted pilot intake.

Do not start with speculative Shopify, order management, logistics, a chatbot, or additional named agents. Prove the evidence-first catalog operations wedge first.
