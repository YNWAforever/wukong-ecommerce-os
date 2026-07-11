# Wukong Shopline AI Listing MVP Design

**Date:** 2026-07-12  
**Status:** Approved for planning  
**Pilot workspace:** Opak Cellar  
**Primary platform:** SHOPLINE  

## 1. Objective

Build the first usable vertical slice of Wukong E-commerce OS: a multi-tenant SaaS workflow that turns product photos, supplier documents, and operator notes into a reviewable bilingual product listing, then publishes the approved listing to SHOPLINE or exports a validated SHOPLINE CSV.

Opak Cellar is the first pilot workspace. Its configuration proves the product on a real Hong Kong wine and spirits catalogue while all merchant-specific rules remain workspace data so a second merchant can be onboarded without code changes.

## 2. Product Outcomes

The MVP must let an authenticated Opak operator:

1. Create a product-listing job from images, a PDF, and/or pasted text.
2. Generate a structured English and Traditional Chinese listing with an AI agent.
3. See confidence, provenance, missing information, and compliance warnings per important field.
4. Edit the draft and approve it through a human-review gate.
5. Publish the approved product through a SHOPLINE connector when merchant API access is configured.
6. Download a validated SHOPLINE import CSV when API access is unavailable or as an operational fallback.
7. Inspect an audit trail and the model, prompt version, latency, token use, and estimated cost for every AI run.

The MVP is successful when this complete loop works for representative Opak wine listings without hand-editing raw JSON or database rows.

## 3. Scope

### Included

- Invite-only authentication and tenant-isolated workspaces.
- Opak Cellar pilot workspace and wine-listing profile.
- Image, PDF, and pasted-text input.
- AI extraction and listing generation.
- Bilingual English and `zh-Hant` product content.
- Wine-specific structured product fields.
- Per-field confidence, evidence, validation, and missing-data states.
- Human review, edit history, approval, and re-open flow.
- SHOPLINE field projection and validation.
- Direct SHOPLINE create/update through a connector.
- SHOPLINE CSV export fallback.
- Immutable audit events and AI cost logs.
- Responsive operator UI for desktop and tablet.

### Explicitly excluded from this MVP

- Billing, subscriptions, and quota enforcement.
- Shopify, Carousell, HKTVmall, and Google Merchant exporters.
- WhatsApp ingestion or customer-service agent behavior.
- Order, inventory, payment, and fulfilment synchronization.
- Automatic publication without human approval.
- Advanced image generation or background replacement.
- Supplier intelligence, marketplace taxonomy learning, analytics dashboards, and agency roll-up reporting.

These exclusions narrow the first build to the user-requested listing and AI-agent loop; they do not remove extension points required by the broader Phase 1 scope.

## 4. Recommended Architecture

Use a TypeScript monorepo with clear domain boundaries:

```text
apps/
  web/          Next.js operator application and API surface
  worker/       Long-running AI and publishing jobs
packages/
  core/         Product, workflow, review, and policy domain logic
  db/           Drizzle schema, migrations, and tenant-scoped repositories
  ai/           Provider gateway, prompt registry, schemas, and eval helpers
  shopline/     SHOPLINE connector, projection, validation, and CSV exporter
  ui/           Shared interface components and design tokens
```

Runtime choices:

- **Web:** Next.js App Router, React, TypeScript, Tailwind CSS, and accessible headless components.
- **Database:** PostgreSQL with Drizzle ORM. Neon pooled connections are used by application code and a direct connection is reserved for migrations.
- **Jobs:** BullMQ over Redis with separate queues for extraction, generation, and publishing. Payloads contain IDs, not source documents or secrets.
- **Assets:** S3-compatible object storage with workspace-prefixed keys and signed URLs.
- **Authentication:** Auth.js with invite-only email sign-in for the pilot. Workspace membership is checked on every server operation.
- **AI:** A provider-neutral gateway. The first production adapter supports multimodal structured output; feature code never imports a provider SDK directly.
- **Observability:** Structured logs with request, workspace, draft, and job IDs. AI calls record prompt version, provider, model, latency, usage, and estimated cost.

All external systems have in-memory or local-development adapters so the workflow can be developed and tested without production credentials. Production resource provisioning and secret changes require separate approval.

## 5. Core Domain Model

### Tenant and access records

- `users`
- `workspaces`
- `workspace_memberships`
- `workspace_profiles`

Every tenant-owned record contains `workspace_id`. Application repositories require a workspace context, and PostgreSQL row-level security provides defense in depth.

### Listing records

- `listing_drafts`: identity, status, target platform, active version, timestamps.
- `listing_versions`: immutable snapshots of generated or operator-edited content.
- `source_assets`: uploaded files, extracted text, hashes, MIME type, and storage key.
- `field_evidence`: source asset, page/region or text span, confidence, and extraction note.
- `compliance_flags`: field, rule, severity, status, and resolution reason.
- `review_events`: field edits, rejection, approval, reopen, actor, and timestamp.

### Operations records

- `prompt_versions`: prompt name, version, schema version, body, and activation state.
- `ai_runs`: task type, prompt version, provider/model, usage, cost, latency, and outcome.
- `shopline_connections`: encrypted credential reference and non-secret merchant metadata.
- `publish_jobs`: connector, idempotency key, request digest, result, and remote product ID.
- `audit_events`: append-only actor/action/entity metadata.

## 6. Canonical Wine Listing Schema

The canonical schema is platform-neutral but initially projects to SHOPLINE. Fields are divided into required, conditional, and optional groups.

### Identity and merchandising

- Internal SKU
- English title
- Traditional Chinese title
- Brand / producer
- Product type
- Country
- Region and sub-region
- Appellation / classification
- Vintage or non-vintage marker
- Grape varieties
- Bottle volume
- Alcohol by volume
- Pack quantity
- Barcode, when supplied
- Selling price in HKD
- Compare-at price, when supplied
- Stock policy and initial quantity, only when explicitly provided

### Content

- English short description
- Traditional Chinese short description
- English full description
- Traditional Chinese full description
- Tasting notes
- Food pairing
- Serving and storage guidance
- Producer story
- Awards and critic scores, each tied to evidence
- SEO title and description in both languages
- Image ordering and alt text
- Tags and collection suggestions

### Governance fields

- Confidence per extracted field
- Provenance reference per factual field
- Missing-required-field list
- Unverifiable-claim flags
- Alcohol-age and responsible-marketing checks

The agent must not invent vintage, critic score, region, ABV, volume, price, stock, or awards. Unknown values remain empty and appear as `Needs information`.

## 7. Opak Cellar Workspace Profile

The seed profile contains:

- Store name: Opak Cellar.
- Storefront URL: `https://www.opakcellar.com/`.
- Platform: SHOPLINE.
- Currency: HKD.
- Content locales: English and Traditional Chinese.
- Catalogue focus: wine and spirits, including single bottles and multi-bottle packs.
- Tone: knowledgeable, concise, premium, and non-exaggerated.
- Required alcohol fields: producer, country/region, product type, bottle volume, and ABV when evidence is available.
- Pack-title convention for case products.
- Claim policy: ratings, awards, exclusivity, health effects, and superlatives require evidence.
- Mandatory human approval before any connector or CSV export.

Public Opak catalogue pages may be used as non-authoritative examples for development fixtures. Price and stock are never copied into a new listing unless supplied by an authorized operator input.

## 8. Listing Agent Pipeline

### Step 1: Intake

The operator starts a listing, selects SHOPLINE, and attaches up to ten images, one PDF, and optional notes. Client and server validation check file type, size, and total count. The server stores assets and creates a `Received` draft.

### Step 2: Extraction

The worker extracts visible label text, document text, tables, and relevant image regions. It returns structured candidate facts with evidence references. Extraction is independent from marketing-copy generation.

### Step 3: Reconciliation

Deterministic rules normalize units, currency, pack quantity, vintage, and identifiers. Conflicting source values are preserved as conflicts rather than silently choosing one. Required facts without trustworthy evidence remain missing.

### Step 4: Listing generation

The AI gateway receives only normalized facts, approved workspace tone rules, and the active prompt version. It produces schema-validated bilingual copy, SEO fields, tags, and collection suggestions. Factual fields remain locked to extracted or operator-provided facts.

### Step 5: Validation and compliance

Deterministic schema checks run first. Claim rules then flag unsupported ratings, awards, exclusivity, guarantees, health claims, and prohibited superlatives. A draft with missing required data enters `Needs Info`; otherwise it enters `In Review`.

### Step 6: Human review

The review screen shows source evidence beside draft fields. The reviewer can edit fields, resolve warnings with a reason, reject the generation, or approve the whole listing. Every change creates a new immutable version and an audit event.

### Step 7: Delivery

Only an `Approved` version can be projected to SHOPLINE. The user chooses direct publish or CSV download. Both paths use the same mapping and validator so their outputs cannot drift.

## 9. Workflow State Machine

```text
Received -> Processing -> Needs Info -> Processing
                      \-> In Review -> Approved -> Publishing -> Published
                                      \-> Reopened
Publishing -> Publish Failed -> Publishing
Processing -> Failed -> Processing
```

Rules:

- State transitions happen through one domain service.
- Every transition writes an audit event.
- Approval always references an immutable listing version.
- Editing an approved version creates a new version and moves the draft to `Reopened`.
- Export and publish services reject any version that is not currently approved.
- Unresolved blocking compliance flags prevent approval and delivery.

## 10. SHOPLINE Connector Design

The `CommerceConnector` contract exposes:

- `verifyConnection()`
- `validateProduct()`
- `createProduct()`
- `updateProduct()`
- `getProductStatus()`

The SHOPLINE implementation maps the canonical schema to a versioned SHOPLINE product payload. The mapping covers bilingual content, variants or pack options, price, images, SEO fields, tags, and publication visibility supported by the merchant API version.

Safety and reliability requirements:

- Direct API access is enabled only after Opak grants merchant OpenAPI access or installs the Wukong Developer Center app.
- Credentials are encrypted and never returned to the browser or written to logs.
- No API call occurs before server-side approval validation.
- Publish operations use an idempotency key derived from workspace, approved version, action, and target.
- Retries may repeat safe reads and idempotent writes; ambiguous write failures require a remote-status check before retry.
- The remote product ID and payload digest are stored with the publish result.
- Updating an existing product requires an explicit remote product link and operator confirmation.
- If API access is absent or verification fails, the UI offers CSV export and does not imply that the store is connected.

The CSV exporter and direct connector share one projection model. CSV validation reports missing required columns, length violations, invalid numeric formats, and image URL problems before download.

## 11. Operator Interface

### Dashboard

Shows drafts grouped by `Needs Info`, `In Review`, `Approved`, `Published`, and `Failed`, plus clear next actions.

### New listing

A short wizard collects files and notes, displays upload progress, and confirms target workspace and platform.

### Review workspace

Uses a two-pane layout: evidence viewer on the left and grouped listing fields on the right. Low-confidence, conflicting, missing, and flagged fields are filterable. The approval action remains visible but explains any blocking issue.

### Delivery panel

Displays connection status, validation results, direct-publish action, CSV fallback, last delivery result, and remote product link when available.

### Settings

Allows an admin to edit workspace tone and listing rules, manage the SHOPLINE connection, and inspect the active prompt version. Secrets are write-only.

The core flow is keyboard accessible and uses Traditional Chinese as the primary operator language with clear English SaaS labels where useful.

## 12. Error Handling

- Invalid input is rejected before storage when possible and explained per file.
- Extraction failure preserves the draft and inputs; users can retry without re-uploading.
- Schema-invalid AI output is repaired once through the provider gateway, then fails visibly without overwriting the last valid version.
- Provider timeout or rate limiting uses bounded exponential backoff and records the final reason.
- Missing information never becomes guessed content.
- Connection verification distinguishes invalid credentials, missing SHOPLINE permission, network failure, and unsupported API behavior.
- Publish failures preserve approval and can be retried safely.
- CSV generation cannot succeed with blocking mapping errors.
- User-facing errors include a correlation ID; secrets and raw provider responses are not exposed.

## 13. Security and Tenant Isolation

- All reads and writes use workspace-scoped repositories.
- Cross-workspace access tests cover records, assets, AI logs, exports, and connection metadata.
- Signed asset URLs expire and are generated only after authorization.
- Uploads are MIME-checked and size-limited; virus scanning is an implementation-plan requirement for PDFs and office documents.
- Connector credentials are encrypted using a server-side key and redacted from telemetry.
- Audit and AI run records are append-only through the application API.
- Sensitive document contents are not sent to analytics systems.

## 14. Testing Strategy

### Unit tests

- Wine-field normalization and validation.
- State-machine transitions and approval gate.
- Compliance rules and flag resolution.
- SHOPLINE projection and CSV escaping.
- Idempotency-key generation.

### Integration tests

- Workspace isolation against PostgreSQL policies and repositories.
- Upload finalization and signed asset access.
- AI gateway structured-output parsing with a deterministic fake provider.
- SHOPLINE connector against recorded official contract fixtures and a mock server.
- Audit and cost-log creation for every AI run and transition.

### AI evaluation

Maintain a versioned pilot corpus of representative wine labels, supplier sheets, and expected structured facts. Measure required-field recall, unsupported factual claims, bilingual copy review acceptance, and latency. The launch target is at least 90% recall on facts present in standard pilot inputs with zero accepted unsupported critical facts.

### End-to-end tests

Automate the full browser flow:

1. Sign in to the Opak workspace.
2. Upload a representative image/PDF bundle.
3. Generate a draft.
4. Inspect and edit a low-confidence field.
5. Resolve a compliance warning.
6. Approve the version.
7. Prove pre-approval delivery is rejected.
8. Download and validate the SHOPLINE CSV.
9. Publish through the mock SHOPLINE connector and verify the stored remote ID.

Live Opak publication is a separate controlled acceptance test requiring merchant credentials and explicit authorization before any write.

## 15. MVP Acceptance Criteria

The build is ready for pilot onboarding only when:

- A second test workspace cannot access any Opak record or asset.
- The standard input bundle produces an `In Review` draft within three minutes at p90 in the pilot environment.
- At least 90% of required facts that exist in the evaluation input are extracted with evidence.
- No critical factual field is invented when absent from sources.
- English and Traditional Chinese content pass schema and workspace policy checks.
- Every field edit, approval, state change, AI call, and delivery attempt is audited.
- Delivery is rejected from every server path before approval.
- Blocking claims prevent approval until resolved with an auditable reason.
- The SHOPLINE CSV passes the versioned mapping validator.
- Direct-publish contract tests pass and connection errors produce an honest CSV fallback.
- The full end-to-end test passes on a clean environment.
- A human can complete the workflow without developer tools or database edits.

## 16. Rollout and External Dependencies

Implementation proceeds locally with mock external adapters, then against separately approved development resources. Before a live Opak pilot, the owner must provide or authorize:

- SHOPLINE OpenAPI enablement or installation of the Wukong Developer Center app.
- A non-production SHOPLINE test shop or explicit permission to create a hidden test product.
- Pilot source documents and permission to retain them for evaluation.
- Production AI-provider, database, Redis, storage, email, and hosting resources.

No production secret rotation, paid resource provisioning, or write to Opak Cellar is implied by approval of this design document.

## 17. Key Decisions

- Build a pilot-first vertical slice, not the entire Phase 1 backlog.
- Keep multi-tenancy and auditability in the first build because they define the SaaS boundary.
- Use one canonical product model and one SHOPLINE projection for both API and CSV delivery.
- Make direct SHOPLINE publishing the preferred experience and CSV the guaranteed fallback.
- Treat human review, evidence, and no-export-before-approval as product features, not optional safeguards.
- Store Opak rules as workspace configuration so the MVP remains a reusable ecommerce OS.

