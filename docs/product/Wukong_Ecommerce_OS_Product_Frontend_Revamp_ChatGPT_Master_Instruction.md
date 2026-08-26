# ChatGPT / Codex Master Instruction — Wukong Ecommerce OS Product Frontend Revamp

> 用途：把以下整份 Markdown 交給 ChatGPT、Codex 或其他可直接修改 GitHub repository 的 coding agent，作為 `wukong-ecommerce-os` 產品前端重塑的主指令。主要範圍是登入後的產品 runtime；`wukong-ops-suite` 只作為配套的公開市場與 pilot intake 介面。

---

## 1. Role

You are a world-class B2B SaaS product designer, ecommerce operations architect, information architect, accessibility specialist, design-system lead, senior Next.js engineer, frontend performance engineer, and product analytics strategist.

Revise and further develop the Wukong product frontend into a credible, enterprise-ready **Evidence-first Ecommerce Catalog Operations OS**.

Do not treat this as a visual reskin. Improve the complete operator experience, information architecture, workflow clarity, responsive behavior, accessibility, data presentation, product truthfulness, and frontend-to-backend integration.

Work against the repositories:

- Product runtime: `https://github.com/YNWAforever/wukong-ecommerce-os`
- Public marketing and pilot-intake surface: `https://github.com/YNWAforever/wukong-ops-suite`

The authenticated product runtime is the primary scope. The public site is a secondary alignment scope and must not become a duplicate operational application.

---

## 2. Product Positioning

Wukong must be presented as:

> An evidence-first catalog operations system that turns supplier files, product images, and existing platform records into reviewed, traceable, channel-ready catalog updates, while humans retain final approval.

Wukong is not primarily:

- a generic AI copywriter;
- a floating chatbot;
- an AI image generator;
- an all-purpose CRM;
- an unproven “eight autonomous agents” suite;
- a replacement for the merchant’s ecommerce platform.

The product should feel like a dependable operational control plane for merchants managing:

- many SKUs;
- bilingual product content;
- regulated or claim-sensitive products;
- multiple source files and evidence;
- human review and approval;
- platform-specific publishing requirements;
- retries, reconciliation, and audit history.

The initial product wedge is SHOPLINE catalog operations, piloted with Opak Cellar. The architecture and UI should be extensible to other categories and channels, but must not imply that unimplemented connectors are already live.

---

## 3. Source of Truth and Required Reading

Before changing code, inspect and understand the latest repository state. Read at minimum:

- `CLAUDE.md`
- `CONTEXT.md`
- root and application `package.json` files
- `apps/web/app/**`
- `apps/web/components/**`
- `apps/web/lib/**`
- `packages/core/src/**`
- `packages/db/src/schema.ts`
- `packages/db/src/repositories/**`
- `packages/ai/src/**`
- `packages/shopline/src/**`
- `apps/worker/src/**`
- current tests and Playwright fixtures
- `docs/product/ecommerce-os-product-plan.md`
- `docs/product/catalog-control-center-acceptance.md`
- current open and recently merged pull requests relevant to workspace administration, catalog operations, product-shot review, bulk approval, enrichment, publishing, and runtime reliability.

Use the existing backend, workflow state machine, role model, tenancy boundary, audit rules, and delivery mechanisms. Do not replace working infrastructure with mock frontend state.

If repository code and this instruction differ, preserve the latest verified runtime behavior and document the discrepancy.

---

## 4. Repository Boundary

### 4.1 `wukong-ecommerce-os`

This is the authenticated product runtime and system of record. It owns:

- workspace identity and membership;
- roles and permissions;
- source assets and evidence;
- canonical product and listing data;
- AI extraction and generation runs;
- review and compliance workflows;
- platform connections and delivery jobs;
- audit history;
- usage, cost, and operational status;
- the operator-facing application.

### 4.2 `wukong-ops-suite`

This is the public acquisition, education, and pilot-intake surface. It owns:

- product positioning;
- capability explanations;
- use cases and case studies;
- pricing or pilot packaging;
- demo conversion;
- merchant qualification;
- secure handoff into the product runtime.

It must not store the canonical operational catalog or reproduce the authenticated product interface.

---

## 5. Primary Objectives

Transform the current pilot-oriented frontend into a scalable operator product that:

1. Makes the catalog, workflow status, blockers, evidence, and next actions immediately understandable.
2. Removes hard-coded Opak-specific identity from the reusable product shell.
3. Gives operators one clear control plane instead of disconnected screens.
4. Makes AI recommendations explainable through field-level evidence and confidence.
5. Makes human review fast, safe, and auditable.
6. Makes publishing, retry, and remote-state visibility understandable.
7. Supports dense desktop workflows and usable mobile review.
8. Presents only capabilities that are actually implemented or clearly labelled Pilot or Planned.
9. Preserves workspace isolation, role gates, approval policy, and audit requirements.
10. Creates a frontend foundation that can later support Product, Variant, Channel Listing, Price, Inventory, Asset, Policy Result, and Automation Run entities.

---

## 6. Non-negotiable Product Rules

- Do not bypass human approval.
- Do not permit AI to silently publish or overwrite protected facts.
- Do not fabricate metrics, remote states, prices, inventory, usage, or connector support.
- Do not show a successful action until the backend has durably accepted it.
- Do not use fake data in production routes.
- Do not derive workspace identity from client input.
- Do not expose SHOPLINE access tokens or other secrets to the browser.
- Do not weaken RLS, session resolution, role checks, audit events, idempotency, leases, or retry behavior.
- Do not redesign only the dashboard and stop. Complete all routes and states in the agreed scope.
- Do not remove existing functions merely because they are visually inconvenient.
- Do not replace the existing workflow with a long-running browser request.
- Do not describe Planned integrations as Live.
- Do not merge to production or enable real platform writes without explicit approval.

---

## 7. Capability Truth Model

Every major capability shown in the product or marketing site must have one of these states:

- **Live** — implemented, production-wired, and covered by tests.
- **Pilot** — implemented but limited to a controlled merchant, environment, category, feature flag, or approval process.
- **Planned** — designed or marketed as roadmap, but no complete production workflow exists.

Initial guidance, subject to verification against the latest code:

### Live or Pilot

- SHOPLINE listing intake and review
- Evidence-backed AI extraction and generation
- Bilingual English and Traditional Chinese content
- Human approval
- Compliance flags
- Audit history
- CSV and SHOPLINE delivery paths
- Publishing retries and job status
- SHOPLINE bulk-form import and export
- Platform-product mirror
- Catalog Control Center
- Workspace administration
- Product-shot review where the runtime path is merged and enabled

### Planned until verified otherwise

- Shopify
- Carousell
- HKTVmall
- Google Merchant end-to-end sync
- WhatsApp customer-service automation
- supplier intelligence as a complete product module
- logistics operations
- order management
- fulfilment and returns
- campaign operations
- a complete autonomous eight-agent suite

Show capability states in integration pages and the public site. Do not clutter the main operational workflow with roadmap marketing.

---

## 8. Existing Route and Function Parity

First generate a current route/function inventory from the repository. Preserve all working routes, APIs, permissions, and actions.

Known product surfaces include, but are not limited to:

- `/` — authenticated redirect or entry routing
- `/signin`
- `/register`
- `/forgot-password`
- `/reset-password`
- `/dashboard`
- `/catalog`
- `/listings/new`
- `/listings/[id]`
- `/admin`

Known functional areas include:

- listing creation and asset upload;
- AI processing and retry;
- listing collection and queue;
- catalog mirror and listing linkage;
- review editing;
- compliance flag resolution;
- approval and bulk approval;
- CSV, bulk-form, and SHOPLINE delivery;
- create-versus-update publishing visibility;
- workspace membership and invitation management;
- SHOPLINE connection management;
- workspace settings;
- audit and job processing.

Do not rely only on this list. Crawl the current App Router and API tree and create a route/function parity document before refactoring.

---

## 9. Target Information Architecture

Use a consistent authenticated application shell.

### Primary navigation

Recommended desktop navigation:

1. **Overview** — `/dashboard`
2. **Catalog** — `/catalog`
3. **Work Queue** — a catalog/listing cohort focused on actionable work
4. **Create / Import** — `/listings/new` plus catalog import entry points
5. **Automations / Jobs** — only when backed by real job data
6. **AI Quality & Usage** — only when backed by real AI run data
7. **Admin** — `/admin`, role-gated

The first implementation may keep existing routes, but navigation labels and grouping should communicate the product model rather than the code structure.

### Global shell requirements

- Session-derived workspace name
- Session-derived operator identity
- Workspace role indicator
- Workspace switcher only when switching is implemented
- Global search entry point
- Clear current-page state
- Responsive navigation drawer
- Help and support entry point
- Sign-out access
- No permanent “PILOT” label in the reusable shell; show pilot status in workspace/account context where appropriate
- Do not hard-code “Opak Cellar” or “Opak operator” in shared layout components

### Desktop behavior

Prefer a stable left sidebar or compact rail for operational navigation. A top header may contain workspace context, search, environment, help, and profile.

### Mobile behavior

Use an accessible drawer or compact bottom navigation for core routes. Avoid squeezing desktop navigation into two wrapped rows.

---

## 10. Visual Design Direction

Create a premium, calm, trustworthy enterprise operations interface.

### Desired qualities

- Evidence-led
- Operational
- Precise
- Human-controlled
- Modern but not fashionable for its own sake
- Data-dense without feeling crowded
- Suitable for bilingual Hong Kong teams
- Clear under pressure when a publish or compliance action fails

### Avoid

- purple AI gradients everywhere;
- glowing robot illustrations;
- oversized marketing headlines inside operational screens;
- generic card grids with no hierarchy;
- status conveyed only by color;
- excessive animation;
- glassmorphism that reduces readability;
- fake real-time dashboards;
- decorative charts without operational decisions.

### Suggested palette

Evolve the current product palette rather than discarding it:

- Deep navy / primary ink: `#17324D`
- Main text: `#182432`
- Secondary text: `#506070`
- Muted text: `#7B8790`
- Warm action amber: `#B36A24`
- Warm amber hover: `#8D4E17`
- Stone background: `#F6F4EF`
- Surface: `#FFFFFF`
- Border: `#DFE2E1`
- Success: `#2E6B58`
- Warning: use an accessible amber/brown pair
- Danger: `#A53E35`
- Information: a restrained blue distinct from primary navy

Meet WCAG contrast requirements. Status colors must always include icon and text labels.

### Typography

For the authenticated product:

- Use a modern sans-serif interface font, such as Inter, Geist, or system sans.
- Include `Noto Sans TC` or a robust Traditional Chinese fallback.
- Use monospace only for SKU, remote ID, job ID, version, digest, and code-like data.
- Limit serif typography to public storytelling or occasional empty-state editorial moments; do not use it for dense product headings and tables.

### Spacing and density

- Use a clear 4px or 8px spacing system.
- Support comfortable and compact table density where useful.
- Keep touch targets at least 44px on mobile.
- Use consistent page widths, gutters, section spacing, and sticky action areas.

---

## 11. Design System and Reusable Components

Build or consolidate a small product design system. Prefer existing dependencies and local typed components over adding a large UI library without need.

Required primitives:

- `AppShell`
- `SidebarNavigation`
- `MobileNavigationDrawer`
- `WorkspaceContext`
- `PageHeader`
- `Breadcrumbs`
- `PrimaryButton`, `SecondaryButton`, `DangerButton`, `IconButton`
- `StatusBadge`
- `CapabilityBadge`
- `MetricCard`
- `DataTable`
- `TableToolbar`
- `SearchInput`
- `FilterMenu`
- `SavedViewSelector`
- `BulkActionBar`
- `EmptyState`
- `LoadingSkeleton`
- `InlineAlert`
- `ErrorState`
- `PermissionState`
- `ConfirmationDialog`
- `SidePanel` or `DetailsDrawer`
- `ActivityTimeline`
- `EvidenceCard`
- `ConfidenceIndicator`
- `ComplianceFlagCard`
- `DiffViewer`
- `CostBadge`
- `JobStatusBadge`
- `IntegrationCard`
- `FormField`
- `StepProgress`
- `Toast` or live-region notification system

All components must support:

- keyboard interaction;
- visible focus;
- screen-reader labels;
- loading and disabled states;
- error states;
- Traditional Chinese text without truncation defects;
- long SKU and remote-ID values;
- mobile layouts.

---

## 12. Page Requirements

## 12.1 Dashboard — Operations Overview

Purpose: tell the operator what needs attention now and whether the catalog workflow is healthy.

Replace a generic greeting-first layout with an operational hierarchy.

### Header

Show:

- workspace name;
- current operator role;
- concise summary such as “3 products need review, 1 publish needs retry”;
- primary action: create or import product data.

### Priority queue

The first section should surface actionable cohorts:

- Needs information
- Needs review
- Blocking compliance flags
- Publish failed
- Unlinked platform products
- Stuck or retryable jobs when available

Each item must show:

- product title;
- SKU;
- current status;
- blocker or next action;
- last update;
- direct action link.

### Operational metrics

Show only real, backend-supported metrics. Appropriate metrics include:

- Active work items
- Awaiting review
- Blocking issues
- Published in the last 7 or 30 days
- Delivery success after retry
- AI cost per completed SKU
- Evidence coverage
- Catalog linked percentage

When a metric is not yet implemented, either add a correctly scoped backend query or omit it. Never display invented values.

### Activity

Show recent meaningful events:

- imported;
- AI processed;
- edited;
- approved;
- published;
- failed;
- retried;
- integration changed.

The event timeline must use audit data where available.

### Empty state

For a new workspace, guide the user through:

1. Connect SHOPLINE
2. Import catalog or create first listing
3. Invite a reviewer
4. Review and approve
5. Publish safely

---

## 12.2 Catalog Control Center

Purpose: become the main operating surface for platform products and Wukong workflow status.

Preserve and improve the current `/catalog` implementation.

### Summary area

Show real counts for:

- total mirrored platform products;
- linked drafts;
- unlinked products;
- review required;
- attention required;
- published;
- in-sync or out-of-sync only after reconciliation exists.

### Toolbar

Provide:

- server-side search when implemented;
- client-side search only as an interim bounded behavior;
- filters for listing status, origin, blocking flags, connector, updated date, and linkage;
- saved views when backend support exists;
- column visibility;
- table density;
- reset filters;
- result count.

### Table columns

Recommended columns:

- selection
- Product
- SKU
- Remote product ID
- Source/origin
- Wukong linkage
- Workflow status
- Blocking flags
- Last update
- Sync state when implemented
- Next action

### Product cell

Show product title, SKU, channel, and a small source indicator. Avoid forcing the operator to identify a product only by remote ID.

### Row actions

For linked products:

- Open review
- View evidence
- View activity
- Prepare delivery when allowed

For unlinked platform products:

- Create linked draft from platform product
- Preserve mirror record, remote ID, source row, digest, and facts prefill

Do not route an unlinked product to a generic empty intake form after the direct linked-draft endpoint is implemented.

### Details drawer

Open a side panel showing:

- platform identity;
- listing linkage;
- source/import details;
- current content summary;
- compliance blockers;
- publishing history;
- recent activity;
- remote/local comparison when reconciliation exists.

### Bulk actions

Do not add visually enabled bulk actions until corresponding backend endpoints exist and preserve approval policy.

Future approved bulk actions:

- add to enrichment batch;
- request review;
- approve eligible items;
- publish approved items;
- retry failed delivery;
- export.

Every bulk response must show per-item success or failure rather than one misleading global status.

### Pagination

Move from a fixed recent-100 view to cursor pagination and server-side search. Keep filters in the URL so views are shareable and browser navigation works.

---

## 12.3 Create / Import

Purpose: make intake understandable for both manually created products and existing platform catalogs.

### Entry choices

Clearly distinguish:

- Upload product evidence
- Import SHOPLINE bulk form
- Create from an existing unlinked platform product
- Retry an existing failed intake

### Upload flow

Keep the existing upload limits and backend validation. Improve the UI with:

- drag and drop;
- file type and size labels;
- upload progress;
- per-file error messages;
- retry and remove actions;
- clear explanation of how files will be used;
- privacy and retention information;
- no claim that a file is accepted until finalize succeeds.

### Intake form

Use a step-based flow only where it improves comprehension:

1. Source files
2. Known facts and notes
3. Processing summary
4. Review required information

Do not create an unnecessary multi-step wizard for a simple upload.

### Processing state

Show:

- queued;
- processing;
- needs information;
- failed and retryable;
- completed for review.

Explain which step failed without exposing secrets or raw exception messages.

### Import flow

For catalog imports, show:

- file validation summary;
- row count;
- warnings and errors;
- products created, refreshed, unchanged, or rejected;
- estimated AI enrichment cost before starting a batch;
- no automatic uncapped AI processing of every imported product.

---

## 12.4 Listing Review Workspace

Purpose: let a human verify facts and content quickly, with evidence and policy context visible.

This is the most important product screen. Treat it as an operational review workspace, not a conventional edit form.

### Large-screen layout

Use a two- or three-pane design:

- Evidence and source assets
- Editable listing fields and channel preview
- Compliance, changes, and delivery context

Allow panels to collapse or resize if practical.

### Small-screen layout

Use one primary content column with evidence and compliance in accessible drawers or tabs. Keep the approval action visible but do not obscure fields.

### Field presentation

For each important field show:

- current value;
- source evidence;
- confidence;
- whether the value was extracted, imported, generated, or edited by a human;
- missing or unsupported state;
- changed state;
- validation error;
- protected-fact status where relevant.

### Evidence

Evidence should be directly connected to fields. Clicking a field should focus or filter the matching evidence. Clicking evidence should identify affected fields.

Show:

- source file;
- page when relevant;
- excerpt;
- confidence;
- asset preview;
- verified or unsupported state.

Do not hide evidence behind a generic “AI generated” label.

### Bilingual editing

Provide a clear English / Traditional Chinese structure. Avoid long forms where both languages are mixed without hierarchy.

Recommended behavior:

- side-by-side on wide screens;
- tabs on narrower screens;
- character counts and platform validation;
- copy consistency warnings;
- channel preview.

### Compliance

Show blocking and warning flags separately.

Each flag must include:

- rule code or plain-language name;
- severity;
- affected field;
- reason;
- source or evidence gap;
- resolution state;
- resolution action and note when permitted.

Approval must remain disabled when unresolved blocking flags exist.

### Version and diff

Show:

- current version;
- base version;
- fields changed by AI;
- fields changed by human;
- remote version or payload when available;
- simple before/after diff for edited text.

### Sticky approval bar

Include:

- Save draft
- Request more information or reopen where valid
- Approve
- Delivery readiness
- Unsaved changes indicator

Use clear confirmation for approval and publishing. Do not combine approval and publishing into one ambiguous action unless product policy explicitly requires it.

### Keyboard support

Add safe shortcuts only where discoverable, such as:

- save;
- next flagged field;
- previous flagged field;
- open evidence;

Never make a single-key shortcut trigger approval or publish.

---

## 12.5 Delivery and Sync

Purpose: explain exactly what will happen to the remote platform.

Before delivery show:

- channel;
- create versus update;
- target remote product ID when known;
- listing version;
- validation status;
- blocking flags;
- image readiness;
- payload summary;
- delivery method;
- idempotency or duplicate-safety explanation in operator language.

After delivery show:

- queued;
- publishing;
- published;
- failed;
- retry available;
- remote product link;
- last attempt;
- error category;
- next action.

Never expose raw credentials, signed URLs beyond their intended display, or internal stack traces.

### Future reconciliation

Prepare the UI model for:

- In sync
- Local changes pending
- Remote changes detected
- Conflict
- Delivery failed
- Unsupported

Do not show these as active states until backend reconciliation data exists.

---

## 12.6 Work Queue, Jobs, and Recovery

Create a dedicated operational view only if the backend can supply meaningful job and audit data.

Show:

- listing processing jobs;
- enrichment batches;
- publish jobs;
- state;
- attempt count;
- last update;
- cost where relevant;
- failure category;
- retry eligibility;
- next scheduled retry or lease information in operator-friendly language.

Operators should recover normal failures without database access.

Do not expose queue implementation details that are not actionable.

---

## 12.7 AI Quality and Usage

Create this section when backed by real `ai_runs`, evaluation, and usage data.

Possible views:

- spend over time;
- cost per completed SKU;
- task type;
- prompt version;
- model version;
- latency;
- required-fact recall;
- unsupported protected facts;
- human edit distance;
- approval outcome.

This is an operational quality screen, not a model leaderboard.

Do not reveal customer content in analytics logs or cross-workspace reports.

---

## 12.8 Admin

Preserve role-gated access.

Recommended tabs:

1. Members
2. Invitations
3. Integrations
4. Brand and content policy
5. Workspace settings
6. Usage and plan when implemented
7. Data retention and export when implemented
8. Audit access when implemented

### Members and invitations

- Show role descriptions in plain language.
- Clearly separate owner, admin, reviewer, operator, and viewer capabilities.
- Preserve last-admin protection.
- Prevent self-removal or unsafe self-demotion according to backend policy.
- Show invitation status and expiry when available.
- Do not imply that email was sent if only an invitation record was created.

### SHOPLINE connection

- Show connected domain and status.
- Never return or render stored token values.
- Token rotation must require deliberate confirmation.
- Show verification result and last verified time when supported.
- Distinguish connection configuration from publish enablement.

### Brand and policy

Support current brand-background setting and progressively add:

- brand tone;
- required fields;
- claim policy;
- terminology;
- approved phrases;
- prohibited claims;
- category templates.

Do not add frontend-only settings that the runtime does not persist or use.

---

## 12.9 Authentication and Onboarding

### Authentication

Improve signin, password, magic-link, recovery, and registration pages while preserving anti-enumeration behavior and invite-only access.

Requirements:

- clear error and status messaging;
- no misleading “request access” copy if there is no self-service access request path;
- accessible form labels;
- password requirements where relevant;
- resend and expiry messaging;
- safe callback behavior;
- no leak of whether an email is eligible.

### First-run onboarding

Create a guided onboarding experience after the backend supports the necessary state.

Suggested sequence:

1. Workspace profile
2. Connect SHOPLINE
3. Import a catalog or create a sample listing
4. Configure required fields and claim policy
5. Invite reviewer or operator
6. Review first generated draft
7. Complete a sandbox or controlled publish

Show progress based on real persisted state, not local browser completion flags.

---

## 13. UX States That Must Be Designed

For every major route, implement and test:

- initial loading;
- background refresh;
- empty workspace;
- no search results;
- partial data;
- validation error;
- network failure;
- backend unavailable;
- permission denied;
- session expired;
- retryable job failure;
- non-retryable validation failure;
- stale version conflict;
- action already completed or idempotent replay;
- mobile layout;
- reduced-motion mode.

Do not use only toast notifications for important failures. Keep actionable error context visible in the page.

---

## 14. Copy and Content Rules

The product may be bilingual, but copy must remain concise and operational.

### Preferred structure

- Traditional Chinese primary label
- Short English secondary label only where it improves cross-team understanding
- Avoid repeating complete paragraphs in both languages inside dense screens

### Tone

- Clear
- Calm
- Specific
- Non-judgmental
- Action-oriented

### Avoid vague AI language

Do not use:

- “Unlock limitless AI potential”
- “Autonomous agent magic”
- “Revolutionary intelligence”
- “One-click perfect content”

Prefer:

- “2 required fields need evidence.”
- “This delivery will update SHOPLINE product 12345.”
- “The source file does not support the stock quantity.”
- “3 products can be approved; 1 has a blocking flag.”

---

## 15. Frontend Engineering Requirements

Follow the repository’s current technology and conventions. Inspect actual versions before implementation and do not downgrade them.

### Architecture

- Use Next.js App Router conventions.
- Prefer Server Components for data loading and static structure.
- Use Client Components only for interaction, local filtering, forms, drawers, and optimistic states.
- Keep API contracts typed.
- Use Zod or existing runtime validation at boundaries.
- Use Suspense and error boundaries where appropriate.
- Avoid duplicated fetch logic.
- Keep domain status mapping centralized and exhaustive.
- Keep URL state for filters, search, pagination, and selected view where practical.
- Avoid N+1 API or database patterns.
- Add cursor pagination before increasing catalog result limits.

### Styling

- Consolidate tokens.
- Prefer scoped CSS modules or the project’s established styling convention.
- Remove duplicated ad hoc styles after replacement is verified.
- Do not add a heavy component library solely for visual polish.
- If introducing Radix, shadcn, or another library, document why existing primitives are insufficient and keep bundle growth controlled.

### Performance

- Do not ship large data sets to the browser for filtering once server-side search exists.
- Virtualize very large tables only after profiling.
- Avoid unnecessary client hydration.
- Optimize images and previews.
- Keep loading feedback immediate.
- Preserve Turbo and Next build behavior.

### Error handling

- Map typed backend errors to clear user actions.
- Preserve safe structured logging.
- Never display secret-bearing raw exceptions.
- Do not mislabel unrelated failures as queue or platform errors.

---

## 16. Security and Tenancy Requirements

- Resolve workspace context from the authenticated session.
- Never accept a workspace ID from untrusted client JSON as the authority.
- Keep all database work inside the existing workspace-scoped repository boundary.
- Preserve RLS defense in depth.
- Enforce roles in the API and domain layer, not only by hiding buttons.
- Keep tokens encrypted at rest and absent from responses.
- Do not log product content, customer files, credentials, signed URLs, or personal details unless an existing approved audit policy requires them.
- Maintain CSRF, same-origin, upload, MIME, size, count, and rate-limit protections.
- Treat imported files and images as untrusted input.
- Preserve idempotency for publish and other irreversible actions.

---

## 17. Accessibility Requirements

Meet WCAG 2.2 AA where practical.

Required:

- semantic landmarks;
- one meaningful H1 per page;
- logical H2/H3 structure;
- accessible names for icon buttons;
- keyboard-operable menus, tabs, dialogs, drawers, tables, and bulk selection;
- visible focus;
- proper labels and descriptions;
- status announcements through `aria-live` where appropriate;
- errors linked to fields;
- color-independent status communication;
- reduced-motion support;
- no hover-only information;
- 44px touch targets on mobile;
- table alternatives or responsive card patterns on small screens;
- correct `lang` behavior if language switching is introduced.

Test at 375px width and with keyboard-only navigation.

---

## 18. Responsive Requirements

### Desktop

- Optimize for 1280–1600px operational workspaces.
- Support dense tables, split review panes, sticky toolbars, and side drawers.

### Tablet

- Collapse secondary panels into drawers or tabs.
- Keep filters and bulk actions usable.

### Mobile

- Do not merely shrink the desktop table.
- Use card rows, progressive disclosure, horizontal scrolling only where necessary, and sticky safe actions.
- Keep evidence accessible during review.
- Avoid fixed elements covering form controls.
- Test long Traditional Chinese labels, SKUs, IDs, and error messages.

---

## 19. Analytics and Product Measurement

Instrument meaningful product events only after confirming the project’s analytics approach.

Suggested events:

- dashboard_viewed
- catalog_viewed
- catalog_searched
- catalog_filter_applied
- platform_product_opened
- linked_draft_started
- evidence_opened
- listing_edit_saved
- compliance_flag_resolved
- listing_approved
- bulk_approval_completed
- delivery_started
- delivery_succeeded
- delivery_failed
- retry_started
- onboarding_step_completed

Do not include raw product content, tokens, customer messages, or personal data in event payloads.

Create reporting around merchant outcomes:

- median source-to-publish time;
- human minutes per SKU;
- first-pass approval rate;
- evidence coverage;
- publish success after retry;
- AI cost per completed SKU;
- catalog linked percentage;
- catalog in-sync percentage when reconciliation exists;
- human edit distance;
- weekly active operators;
- completed work items.

---

## 20. Public `wukong-ops-suite` Alignment

After the authenticated runtime frontend is stable, revise the public site so it accurately represents the shipped product.

### Positioning

Lead with:

> Evidence-first catalog operations for bilingual, high-SKU ecommerce teams.

Use the broader Ecommerce OS roadmap as a future architecture, not as a claim that every module is live.

### Required changes

- Add Live / Pilot / Planned badges to each capability and agent card.
- Rewrite the hero around safe catalog operations, evidence, review, and SHOPLINE workflow.
- Remove or qualify unsupported multi-platform, customer-service, logistics, and full eight-agent claims.
- Replace fixed self-service pricing with clearly scoped pilot or design-partner packages until plans, entitlements, metering, and billing exist.
- Add an Opak pilot workflow or case-study section without exposing private merchant data.
- Connect the demo form to a real protected server-side lead endpoint.
- Persist the lead and uploads before showing success.
- Add consent, privacy, retention, anti-bot, rate limiting, idempotency, and structured failure handling.
- Return a lead or trial ID that can be handed into product onboarding.
- Do not store operational catalog data in the marketing application.

---

## 21. Delivery Stages

Work in bounded, reviewable stages. Do not mix a large data-model migration with a full visual redesign in one unreviewable change.

## Stage A — Audit, route parity, and design foundation

Deliver:

- Current route/function inventory
- Current role/action inventory
- Current component and CSS audit
- UX issue list with severity
- Design tokens
- Typography and status system
- App shell prototype implemented in code
- No functional regression

Acceptance:

- Existing routes remain reachable
- Session and role behavior remains intact
- No hard-coded reusable Opak identity in the app shell
- Mobile navigation works
- Keyboard and focus behavior pass

## Stage B — Dashboard and Catalog Control Center

Deliver:

- Operational dashboard
- Improved catalog table
- Search/filter URL state
- Details drawer
- Empty/loading/error states
- Cursor pagination and server-side search where backend work is approved

Acceptance:

- No fake metrics
- Every catalog item has a clear status and next action
- Workspace scoping is tested
- 375px layout is usable
- Unit and API tests pass

## Stage C — Intake and Review Workspace

Deliver:

- Improved create/import entry
- Upload progress and per-file errors
- Processing state
- Evidence-linked field review
- Compliance hierarchy
- Bilingual editor
- Version and diff presentation
- Sticky save/approve actions

Acceptance:

- Approval rules are preserved
- Blocking flags prevent approval
- Save and stale-version failures are visible
- Evidence can be navigated by keyboard
- Mobile review is usable

## Stage D — Delivery, recovery, admin, and onboarding

Deliver:

- Clear create/update delivery preview
- Publish status and retry UX
- Admin IA and settings polish
- Honest invitation state
- Integration status
- First-run onboarding backed by persisted state

Acceptance:

- No secret appears in browser responses or markup
- Operators can understand and recover normal failures
- Role restrictions are enforced server-side
- All state transitions remain audited

## Stage E — Usage, quality, and marketing alignment

Deliver:

- AI quality and cost view backed by real data
- Operational KPI reporting
- Capability matrix
- Revised public site and persisted pilot intake

Acceptance:

- Product and marketing capability states agree
- No public success state without persisted submission
- No unsupported capability is labelled Live

---

## 22. Test and Verification Requirements

Run and keep green the repository’s full verification pipeline.

At minimum:

- runtime formatting check;
- forbidden legacy runtime check;
- TypeScript and lint;
- unit tests;
- database integration tests;
- production Next build;
- native dependency bundling checks;
- Playwright acceptance flow;
- audit verification;
- Vercel preview build.

Add focused tests for:

- route authentication;
- role gating;
- workspace scoping;
- status mapping exhaustiveness;
- loading, empty, error, and permission states;
- search and filters;
- catalog pagination;
- linked-draft creation;
- evidence interaction;
- compliance and approval rules;
- create-versus-update delivery copy;
- mobile navigation;
- keyboard interactions;
- no token or secret leakage;
- marketing demo submission failure and success.

For visual verification:

- inspect desktop and 375px mobile views;
- check browser console errors;
- check overflow and clipped text;
- check focus order;
- check empty and failure states;
- capture reviewable screenshots or a preview deployment.

Do not claim visual verification if the preview is inaccessible behind authentication and no authenticated browser test was performed. State the limitation honestly.

---

## 23. Definition of Done

The frontend revision is complete only when:

1. Every in-scope route is implemented and reviewed, not only the dashboard.
2. Existing functionality and backend integrations are preserved.
3. The application shell is reusable and session-derived.
4. Catalog state and next actions are understandable without database knowledge.
5. Evidence and compliance are first-class in the review experience.
6. Publishing clearly distinguishes create, update, queued, failed, retry, and success.
7. No unsupported capability is presented as live.
8. Loading, empty, error, permission, and mobile states are complete.
9. Accessibility and keyboard behavior have been tested.
10. Full CI and production build pass.
11. A reviewable preview deployment exists.
12. Production is not replaced or publish flags enabled without explicit approval.

---

## 24. Required Final Report

At the end of each stage, report:

### Completed

- Routes changed
- Components created or consolidated
- APIs used or added
- UX states completed
- Tests added

### Preserved

- Existing workflows
- Security boundaries
- Role gates
- Audit behavior
- Publishing behavior

### Verification

- Commands and CI results
- Browser sizes checked
- Console and accessibility findings
- Preview deployment status

### Deferred

- Backend dependencies
- Planned capabilities
- Known limitations
- Next bounded sprint

### Release recommendation

Choose one:

- Ready for review
- Ready to merge but not enable production writes
- Blocked by a verified issue
- Not ready to merge

Never present unfinished placeholder UI as a completed product feature.

---

## 25. Immediate First Implementation Priority

Begin with this exact order:

1. Generate route/function parity.
2. Remove hard-coded workspace/operator identity from the shared shell.
3. Establish the design tokens and responsive navigation.
4. Upgrade the dashboard into an actionable operations overview.
5. Upgrade Catalog Control Center with server-side pagination, search, filters, and a details drawer.
6. Implement “create linked draft from platform product” while preserving mirror linkage and facts prefill.
7. Redesign the listing review workspace around evidence, compliance, bilingual editing, and safe approval.
8. Improve delivery, retry, and failure recovery.
9. Polish admin and onboarding.
10. Align the public site with capability truth and persisted pilot intake.

Do not begin with speculative Shopify, order management, logistics, or an AI chatbot. Prove the catalog operations wedge first.
