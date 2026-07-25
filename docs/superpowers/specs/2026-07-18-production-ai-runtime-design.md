# Wukong Production AI Runtime Design

**Date:** 2026-07-18
**Status:** Approved design, pending written-spec review
**Pilot tenant:** Opak Cellar
**Primary commerce platform:** SHOPLINE

## 1. Purpose

Complete the production runtime for the existing Wukong listing-management vertical slice. An authenticated Opak operator must be able to upload product source material, create a listing, have the AI pipeline process it asynchronously, review and edit the bilingual result, resolve compliance flags, approve it, and export a validated SHOPLINE CSV. Direct SHOPLINE publication remains approval-gated and is exercised against a real shop only after a separate launch confirmation.

The listing UI, domain workflow, worker pipeline, AI provider, database repositories, SHOPLINE projection, CSV exporter, and mock end-to-end tests already exist. This design supplies the missing managed infrastructure and the durable web-to-worker handoff needed to run that workflow in production.

## 2. Scope

### In scope

- Cloudflare R2 as the S3-compatible source-asset store.
- Upstash Redis as the BullMQ transport.
- A continuously running Railway worker using the existing `@wukong/worker` application.
- A shared, versioned queue contract used by both Vercel and Railway.
- Automatic enqueue after listing creation and a safe manual retry when enqueueing fails.
- Consistent R2 credentials and settings in the Vercel web runtime and Railway worker runtime.
- Production configuration for the existing OpenAI listing provider.
- Deployment, operational diagnostics, and an Opak end-to-end acceptance run.

### Out of scope

- New listing features, additional commerce platforms, billing, analytics, or batch imports.
- Replacing Neon, Better Auth, Resend, Vercel, or the existing AI/domain model.
- Automatically publishing an unreviewed product.
- Creating a real SHOPLINE product without a separate final confirmation from the user.
- A general-purpose workflow orchestration platform or a custom operations console.

This scope is one implementation unit: production infrastructure plus the single missing handoff required to activate the already-built listing workflow.

## 3. Selected Approach

Use managed services with clear runtime ownership:

| Concern          | Service                | Responsibility                                                                                                          |
| ---------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Web and API      | Vercel                 | Authentication, presigned uploads, listing CRUD, review, approval, CSV, SHOPLINE delivery request, and queue publishing |
| Relational state | Existing Neon Postgres | Tenant-scoped listings, assets, AI runs, evidence, flags, versions, review events, audit events, and publish records    |
| Source assets    | Cloudflare R2          | Private images and PDFs addressed by workspace-prefixed keys                                                            |
| Job transport    | Upstash Redis          | BullMQ queue state, retry state, and idempotent job identity                                                            |
| AI processing    | Railway                | Long-running BullMQ consumer that reads R2, calls OpenAI, and commits results to Neon                                   |
| AI model         | OpenAI Responses API   | Structured extraction and bilingual listing generation through the existing provider                                    |

This is preferred over running the worker in Vercel because the current BullMQ consumer is a persistent process. It is preferred over synchronous AI processing because uploads and model calls can outlive a web request and require retries. It is preferred over a custom queue because the repository already has tested BullMQ behavior and recovery semantics.

## 4. Component Boundaries

### 4.1 Shared listing-job package

Create a small workspace package that owns only the queue protocol:

- queue name;
- payload schema and TypeScript type;
- canonical and BullMQ-safe idempotency-key construction;
- queue creation;
- bounded retry and backoff options;
- `enqueueListingPipeline`.

The payload contains only `workspaceId`, `draftId`, and `activeVersionSequence`. It never contains file bytes, signed URLs, prompts, API keys, or merchant credentials. The Vercel publisher and Railway consumer import this package, eliminating drift between two independently deployed runtimes. The existing worker implementation remains responsible for processing, not protocol ownership.

### 4.2 Web queue publisher

A server-only web runtime constructs one lazy BullMQ queue from `REDIS_URL`. Route handlers depend on a narrow publisher interface so tests do not connect to Redis. The connection is reused within a warm Vercel instance and is never created in client code.

The listing-creation handler continues to validate and commit the listing, source-asset attachments, and audit event in Neon before it publishes the job. It derives the queue payload from the authenticated workspace and newly persisted listing; the browser cannot supply tenant identity, status, or version sequence.

### 4.3 Railway listing worker

Railway starts the existing worker from the monorepo with Node 24 and pnpm 11.7. The worker:

1. consumes the shared listing queue;
2. opens the tenant-scoped Neon repositories;
3. retrieves private source assets through short-lived R2 read URLs;
4. runs the existing OpenAI extraction and generation pipeline;
5. writes AI-run metadata, evidence, compliance flags, and the active listing version;
6. moves the listing to `in_review`, `needs_info`, or `failed` according to existing domain rules.

The Railway service is private and exposes no public application route. It uses an always-on worker process with restart-on-failure behavior and deployment logs as the first operational signal.

### 4.4 R2 asset adapter

Both runtimes use the same explicit variables and `S3AssetStore` behavior:

- `S3_BUCKET`
- `S3_ENDPOINT`
- `S3_REGION=auto`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE=false`

The worker runtime is changed to pass these credentials explicitly rather than relying on the AWS SDK's ambient `AWS_ACCESS_KEY_ID` convention. Workspace keys retain the existing `ws/{workspaceId}/sources/...` prefix. The bucket is private. R2 CORS permits uploads only from `https://wukong-ecommerce-os.vercel.app`, the single Vercel preview origin selected for acceptance, and `http://localhost:3000` during local verification. The policy allows only the required `PUT`, `HEAD`, and browser preflight operations and required content headers.

## 5. End-to-End Data Flow

1. An authenticated Opak operator requests a short-lived upload URL from Vercel.
2. Vercel validates file metadata and returns a signed R2 `PUT` URL for a workspace-prefixed key.
3. The browser uploads directly to R2 and calls the finalize endpoint.
4. Vercel verifies the object and stores the finalized source-asset record in Neon.
5. The browser submits the finalized asset IDs and optional notes.
6. Vercel creates the `received` listing, attaches the owned assets, and writes `listing.created` in one database unit of work.
7. After the database commit, Vercel enqueues `{ workspaceId, draftId, activeVersionSequence: 0 }` using the shared idempotency key.
8. Railway consumes the job. The pipeline claims or recovers the run using existing database idempotency semantics and transitions the listing to `processing`.
9. The worker generates the evidence-backed bilingual version and transitions the listing to `in_review` or `needs_info`. A terminal provider or infrastructure error transitions it to `failed` without deleting its assets.
10. The dashboard and review screen read the committed state from Neon. No queue state is treated as the listing system of record.
11. The operator edits fields, resolves blocking compliance flags, approves the version, and exports the SHOPLINE CSV.
12. Direct SHOPLINE delivery is available only for an approved version with a verified tenant connection, and its first real product write requires separate user confirmation.

## 6. Enqueue Failure and Retry Semantics

Database creation and Redis publication cannot be one atomic transaction, so failure is represented explicitly rather than hidden.

### Creation response

`POST /api/listings` always returns the persisted listing after the database commit:

- `201` with `processing.state = "queued"` and the job ID when Redis accepts the job;
- `201` with `processing.state = "retry_required"` and a stable non-secret error code when the listing exists but Redis publication fails.

The second response is not reported as total creation failure. The client redirects to the listing screen and shows a clear retry action; successful uploads are not repeated.

### Retry endpoint

`POST /api/listings/{id}/process` is workspace-scoped and requires the existing `operator` role or higher (`operator`, `reviewer`, `admin`, or `owner`). It repairs only the database-to-queue publication gap. It may enqueue only a listing that:

- is `received`;
- has finalized source assets;
- is not currently owned by a live pipeline run; and
- has not already produced the requested active version sequence.

The server derives the revision identity from Neon. Repeated clicks return the existing BullMQ job because the canonical idempotency key is stable. A conflict response explains when processing is already active or the listing is no longer retryable.

### Recovery

BullMQ makes three attempts with exponential backoff beginning at two seconds. Worker restarts and duplicate delivery are safe because both the queue job ID and the database pipeline-run claim are idempotent. A terminal failure is recorded with a safe error code and audit metadata; it never exposes source content, signed URLs, or secrets. Retrying a terminal `failed` pipeline run is not part of this increment because it requires a separate database lease-reset contract; the operator sees a diagnostic state and the source assets remain available for support recovery.

## 7. Configuration and Secret Ownership

No secret is committed to Git, printed in test output, or returned to the browser.

### Vercel production

- Existing authentication, Resend, Neon, encryption, and SHOPLINE configuration.
- `REDIS_URL` for publishing only.
- R2 variables listed in section 4.4.
- The canonical production application URL used by Better Auth and upload CORS.

Vercel does not receive `OPENAI_API_KEY`; AI calls belong to Railway.

### Railway worker

- `DATABASE_URL` using the Neon runtime connection.
- No admin or migration database URL. Production migrations run once in the deployment workflow before the new worker version starts; worker startup never performs migrations.
- `REDIS_URL`.
- R2 variables listed in section 4.4.
- `AI_PROVIDER=openai`.
- `OPENAI_API_KEY`.
- `OPENAI_LISTING_MODEL=gpt-5.6-terra`, matching the tested provider default. Model access is validated before deployment; lack of access blocks deployment and requires an explicit design amendment rather than an implicit substitution.

Railway does not receive Better Auth, Resend, or SHOPLINE merchant secrets.

### Managed-resource access

- Use a dedicated private R2 bucket and least-privilege object token limited to that bucket.
- Use the Upstash TLS Redis URL and keep eviction disabled/compatible with BullMQ durability.
- Keep Railway and Vercel environment scopes production-specific.
- Sensitive values are entered through provider dashboards or approved CLIs and are never pasted into project files or chat output.

## 8. Error Handling and Operator Experience

| Failure                            | Persisted state                                        | Operator behavior                                                            |
| ---------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| R2 presign/upload/finalize failure | No listing until at least one valid asset is finalized | Show the affected file error and retry only that file                        |
| Redis unavailable after creation   | `received`                                             | Redirect to listing and show "processing not started" with retry             |
| Duplicate enqueue                  | Existing job retained                                  | Treat as success and show processing state                                   |
| Worker restart                     | Claimed or queued run recovered                        | No operator action unless retries terminate                                  |
| OpenAI timeout/transient error     | BullMQ retry, then `failed` if exhausted               | Show a safe diagnostic state; preserve assets and notes for support recovery |
| Required product fact missing      | `needs_info`                                           | Ask operator to add or correct the missing facts                             |
| Blocking compliance flag           | `in_review` with open flag                             | Disable approval until resolved                                              |
| SHOPLINE disconnected              | Approved listing remains unchanged                     | Keep CSV available and explain connection requirement                        |
| SHOPLINE write failure             | Approved listing and publish record retained           | Safe retry without creating an untracked duplicate                           |

Server logs use structured events containing service, action, listing ID, workspace ID, job ID, attempt, duration, and safe error code. They exclude credentials, uploaded content, raw prompts, full model output, and signed URLs.

## 9. Provisioning and Deployment Sequence

1. Implement and verify the shared queue contract, publisher, retry endpoint, UI state, and unified R2 configuration locally with test doubles.
2. Create the private R2 bucket, restricted token, and CORS policy.
3. Create the Upstash Redis database and validate BullMQ connectivity over TLS.
4. Configure Vercel preview variables and deploy PR #8 plus the runtime changes to a preview.
5. Create the private Railway worker service from the same GitHub repository and branch; configure Node 24, the worker start command, restart policy, and preview secrets.
6. Run the preview integration flow with a synthetic product and verify R2, Redis, Railway, OpenAI, and Neon evidence.
7. Merge only after repository checks and the preview flow pass.
8. Add production-scoped variables, run the approved migration workflow, deploy Vercel production, and deploy the Railway production worker.
9. Run the Opak production acceptance flow through review and CSV export.
10. Verify the Resend event and mailbox receipt for `laichiwillyjp@gmail.com` as a separate authentication acceptance item.
11. Stop before the first real SHOPLINE product write and request final confirmation.

Resource creation is authorized by the user's approval of the managed-runtime option. Actual spend, identifiers, and final environment scopes must be reported after provisioning.

## 10. Testing Strategy

### Unit and route tests

- Shared payload validation, queue name, job ID, and retry options.
- Listing creation returns `queued` when publication succeeds.
- Listing creation returns `retry_required` while retaining the committed listing when publication fails.
- Retry endpoint rejects cross-workspace access, unauthorized roles, any status other than `received`, absent assets, and active processing.
- Repeated enqueue returns the same job identity.
- Web and worker R2 configuration use the same explicit credential variables.

### Integration tests

- BullMQ duplicate enqueue and consumption against Redis.
- Worker recovery after a claimed-run interruption.
- R2-compatible signed upload, object existence, and signed read behavior against a test adapter or isolated bucket.
- Pipeline persistence against Postgres for `in_review`, `needs_info`, and terminal failure.

### Preview acceptance

Using a synthetic wine product:

1. register/sign in;
2. upload an image and optional PDF;
3. create the listing and observe queued/processing state;
4. verify the Railway worker consumes the job;
5. verify evidence, bilingual fields, AI-run metadata, and compliance flags in Neon-backed UI;
6. edit and resolve required review items;
7. approve;
8. download and validate the SHOPLINE CSV;
9. exercise mock SHOPLINE delivery only.

### Production acceptance

- Repeat the non-destructive flow in the Opak workspace with approved pilot material.
- Verify deployment-specific Vercel and Railway logs and the persisted database state.
- Verify the registration email event in Resend and receipt at `laichiwillyjp@gmail.com`.
- Do not make the first real SHOPLINE product write during this acceptance run.

## 11. Rollback and Operational Safety

- Vercel can roll back to the last known-good deployment without losing listings because Neon is authoritative.
- Railway can roll back or stop independently; queued jobs remain in Redis and resume when a compatible worker returns.
- If Redis is unavailable, new listings remain visible as `received` and can be retried after recovery.
- If R2 is unavailable, finalized metadata remains in Neon and assets are not silently deleted.
- Queue payload changes require backward-compatible versioning or draining the old queue before deployment.
- Database migrations must be additive for this release and use the existing production migration procedure.
- A provider credential can be revoked independently without rotating unrelated application secrets.

## 12. Acceptance Criteria

The production-runtime increment is complete when all of the following are true:

- An Opak admin can register or sign in with email and password at the production URL.
- The Resend dashboard records the authentication email outcome, and the intended mailbox receives the message or a provider/mailbox rejection is conclusively diagnosed.
- An authenticated Opak operator can upload supported assets to private R2 storage.
- Listing creation enqueues exactly one idempotent processing job, or clearly retains a retryable `received` listing when enqueueing is unavailable.
- The Railway worker processes that job with the existing OpenAI provider and commits a reviewable bilingual result to Neon.
- Dashboard and review UI show persisted live state, evidence, compliance flags, a safe terminal-failure state, and a retry state for queue-publication failure.
- Approval remains impossible while blocking flags are open.
- An approved listing produces a validated SHOPLINE CSV.
- Direct SHOPLINE publication remains disabled or unexecuted until separate confirmation for the first real write.
- CI, focused integration tests, preview acceptance, production deployment checks, and deployment-specific logs all pass without exposing secrets.
