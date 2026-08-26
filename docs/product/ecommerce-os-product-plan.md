# Wukong Ecommerce OS — Product Direction and Delivery Plan

## 1. Product decision

Wukong should not initially compete as a broad, all-in-one commerce suite. Its strongest and most defensible wedge is an **evidence-first catalog operations OS** for merchants that manage many SKUs, bilingual content, regulated or claim-sensitive products, and multiple publishing destinations.

The near-term product promise is:

> Turn supplier files, product images, and existing platform records into reviewed, traceable, channel-ready catalog updates — with humans retaining final approval.

This position is narrower than “AI agents for every ecommerce task,” but it is supported by the current codebase and creates a credible route to a wider operating system.

## 2. Repository roles

### `wukong-ecommerce-os`

This is the product runtime and system of record. It owns:

- workspace identity, membership, roles, and policy;
- source assets and evidence;
- canonical product/listing data;
- AI extraction and generation runs;
- compliance and review workflows;
- platform connectors and delivery jobs;
- audit history, cost, and operational status;
- the authenticated operator experience.

### `wukong-ops-suite`

This should remain the public product, education, and sales surface. It owns:

- product positioning and use cases;
- capability explanations and case studies;
- pricing and demo conversion;
- qualification of platform mix and SKU volume;
- trial or pilot intake.

It must not become a second application runtime or duplicate catalog data. Its demo form should submit to a secure lead/trial endpoint and then hand qualified users into `wukong-ecommerce-os`.

## 3. Current strengths

1. **Grounded AI rather than generic copy generation.** Extraction and generation are separated, facts carry source evidence, and protected values are not allowed to be invented.
2. **Human approval is represented as a real state machine.** Received, processing, needs-information, review, approval, publishing, published, and failure states are explicit.
3. **Operational safety is already part of the architecture.** Idempotency keys, leases, retries, immutable listing versions, audit events, and workspace scoping are first-class concepts.
4. **SHOPLINE is an actual connector, not a mock integration.** Product create, update, verification, and status checks are represented behind a connector contract.
5. **The platform already tracks AI cost and quality signals.** Prompt versions, model runs, token usage, latency, estimated spend, and extraction evaluation are persisted or testable.
6. **The Opak Cellar pilot gives a concrete design partner.** The current alcohol schema and bilingual review flow provide a real workflow to validate before generalisation.

## 4. Product gaps that block an Ecommerce OS claim

### 4.1 Catalog model is still a vertical listing model

The canonical schema currently combines product facts, channel copy, price, stock, and images in one alcohol-specific listing. It assumes HKD and English plus Traditional Chinese. This is appropriate for the pilot but not yet a reusable commerce kernel.

The next model must separate:

- `Product`: shared identity, taxonomy, brand, attributes, and evidence;
- `Variant`: SKU, option values, barcode, weight, dimensions, and pack structure;
- `ChannelListing`: platform-specific title, description, SEO, tags, status, and remote ID;
- `Price`: currency, market, compare-at price, validity window, and source;
- `InventorySnapshot`: location, available quantity, timestamp, and source;
- `Asset`: original, transformed, approved, channel-specific rendition, and usage rights;
- `PolicyResult`: rule, severity, evidence, resolution, and approver;
- `AutomationRun`: trigger, steps, cost, output, retry state, and approval gate.

### 4.2 There is no catalog control plane

Operators can process individual drafts, but until this change there was no single view of platform products, Wukong draft linkage, review state, blockers, and publication status. The new **Catalog Control Center** is the first control-plane surface and should become the default operating view.

### 4.3 Connector capabilities are too narrow

The current connector contract covers connection verification and product create/update/status. A multi-channel OS needs an explicit capability model so each adapter can declare what it supports:

- catalog read and write;
- variants and options;
- images and media;
- price and inventory;
- webhooks and incremental sync;
- orders, fulfilment, returns, and customers;
- platform rate limits, idempotency behavior, and bulk limits.

Unsupported capabilities must be visible in the UI instead of being implied by marketing copy.

### 4.4 The system lacks closed-loop reconciliation

Publishing is not the end of the workflow. Wukong must detect when remote data changes, when a delivery only partially succeeds, when inventory or price becomes stale, and when another operator edits the platform directly.

Every channel listing should eventually expose one of these states:

- `in_sync`;
- `local_changes_pending`;
- `remote_changes_detected`;
- `conflict`;
- `delivery_failed`;
- `unsupported`.

### 4.5 SaaS administration is incomplete

The workspace administration work in the current open pull request is the right foundation. Remaining product requirements include:

- invitation email delivery and acceptance flow;
- workspace switching and removal of hard-coded Opak identity from the shell;
- plans, entitlements, quotas, and usage limits;
- billing or pilot contract status;
- data retention and export controls;
- support tooling and operator impersonation with a strict audit trail.

### 4.6 Product analytics need merchant outcomes

Technical tests are strong, but product success must be measured in merchant terms:

- median time from source upload to publish;
- human minutes per SKU;
- first-pass approval rate;
- percentage of required fields supported by evidence;
- publish success and retry rate;
- AI cost per successfully published SKU;
- percentage of catalog in sync;
- edit distance between AI draft and approved copy;
- weekly active operators and completed work items.

## 5. Product architecture

### Control plane

- Catalog Control Center
- Work queue and saved views
- Review and approval
- Bulk actions
- Workspace policy and permissions
- Usage, cost, and operational health

### Execution plane

- Intake and normalization
- AI extraction and generation
- Image transformation
- Rule and compliance evaluation
- Delivery jobs and retries
- Sync and reconciliation

### Intelligence and evidence plane

- Source assets
- Field-level evidence
- Prompt and model versions
- Human edits and approvals
- Merchant-specific terminology and style guidance
- Outcome feedback for future evaluations

The system must keep these planes connected through durable IDs and audit events rather than through UI-only state.

## 6. Delivery roadmap

### Phase 0 — Pilot hardening

Goal: make the Opak Cellar workflow dependable enough for weekly production use.

- Merge the workspace administration pull request after review.
- Complete invitation delivery and acceptance.
- Launch Catalog Control Center for recent platform products.
- Replace hard-coded workspace/operator labels with session-derived data.
- Add pilot analytics: time-to-review, approval rate, publish success, cost per SKU.
- Add searchable audit and failed-job views.
- Run a fixed Opak evaluation set before every prompt or model change.

Exit criteria:

- at least 95% successful delivery after retry;
- no invented protected fact in the evaluation set;
- median operator time per SKU measured and trending down;
- all production failures visible and recoverable without database access.

### Phase 1 — Catalog operations OS

Goal: move from a listing assistant to a reusable catalog operating layer.

- Introduce Product, Variant, and ChannelListing entities without breaking pilot data.
- Add paginated catalog search, saved cohorts, and bulk editing.
- Add field-level remote/local diff and reconciliation.
- Add taxonomy and attribute templates by merchant category.
- Add reusable policy packs and approval rules.
- Add channel capability declarations and adapter contract tests.
- Add usage entitlements and workspace-level limits.

Exit criteria:

- one canonical product can drive more than one channel listing;
- operators can identify and resolve every out-of-sync item from the UI;
- a new category can be configured without changing the core listing schema.

### Phase 2 — Multi-channel expansion

Goal: prove the operating model beyond SHOPLINE.

- Add a second full connector, preferably Shopify, using the same capability contract.
- Add channel-specific projection previews and validation.
- Add cross-channel price, inventory, and content comparison.
- Add scheduled and webhook-driven sync.
- Add bulk approval and publishing with budget and concurrency controls.

Exit criteria:

- the same product and variant data can be reviewed once and projected safely to two channels;
- channel differences are explicit, testable, and reversible;
- connector failures do not corrupt the canonical catalog.

### Phase 3 — Wider ecommerce operations

Only after the catalog wedge is repeatable should Wukong expand into:

- order exception handling;
- customer service drafting with policy and order context;
- fulfilment and return workflows;
- campaign and merchandising operations;
- forecasting and replenishment suggestions.

These modules should consume the catalog and workflow kernel rather than introduce separate agent silos.

## 7. Immediate backlog after Catalog Control Center

1. Add cursor pagination and server-side search to the catalog endpoint.
2. Add a direct “create draft from platform product” action that preserves the mirror link and prefill data.
3. Add remote/local field diff and an `out_of_sync` cohort.
4. Add bulk cohort actions: enrich, request review, approve, publish, retry.
5. Add workspace-derived brand and operator identity to the application shell.
6. Add job health and cost widgets to the dashboard.
7. Connect the `wukong-ops-suite` demo form to a real lead/trial endpoint; do not show success until the submission is persisted.
8. Publish a capability matrix so marketing claims always match shipped connectors and modules.

## 8. Scope guardrails

- AI never publishes a protected fact without evidence or an explicit human override.
- Automation is represented as durable jobs and state transitions, not long browser requests.
- Every platform write is idempotent, auditable, and retryable.
- Canonical data and channel projection remain separate.
- A connector can only advertise declared, tested capabilities.
- The marketing site never stores operational product data.
- New modules must improve measurable merchant outcomes, not merely increase the number of named “agents.”
