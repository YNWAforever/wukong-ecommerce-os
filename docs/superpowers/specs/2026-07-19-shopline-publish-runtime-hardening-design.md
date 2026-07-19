# SHOPLINE Publish Runtime Hardening Design

**Date:** 2026-07-19
**Status:** Approved architecture; written specification awaiting user review
**Branch:** `codex/production-listing-workflow`

## Problem

The current delivery route persists a `publish_jobs` row but no deployed process consumes it. The local acceptance test then calls `publishApprovedProduct` directly, bypassing the production topology. A queued SHOPLINE delivery would therefore remain queued in production.

The release review also found three related gaps:

- viewers can upload assets, finalize assets, and create listings;
- the OpenAI provider validates generated copy and then discards it in favor of a deterministic projection;
- CSV and direct SHOPLINE payloads omit uploaded product images.

The MVP is not release-ready until these paths are functional, tenant-safe, and exercised through the deployed architecture.

## Goals

- Deliver approved SHOPLINE products through the ordinary web, Redis, Railway worker, database, and connector path.
- Keep the existing `publish_jobs` table as the durable, tenant-scoped delivery ledger.
- Keep queue payloads narrow, validated, idempotent, and free of credentials or listing content.
- Permit the private Railway worker to decrypt tenant SHOPLINE tokens without exposing raw tokens to Redis, logs, Vercel responses, or audit metadata.
- Keep real SHOPLINE writes disabled until a separate final user confirmation.
- Include only workspace-owned, listing-attached images in CSV and direct SHOPLINE projections.
- Preserve grounded model-authored bilingual copy while preventing changes to protected facts or asset identifiers.
- Enforce the documented role hierarchy on all listing-intake mutations.
- Make the real-stack browser test prove the production consumer rather than a direct test helper.

## Non-goals

- No first real SHOPLINE product write in this increment.
- No multi-connection selection UI; the workspace default connection remains the MVP behavior.
- No bulk publishing, scheduled publishing, product updates, or delete synchronization.
- No cross-tenant database poller or privileged worker database role.
- No raw SHOPLINE token stored in an environment variable.

## Architecture

### Queue and ledger

Add a dedicated BullMQ queue named `shopline-publish` to `@wukong/jobs`. Its strict payload contains only:

```ts
type ShoplinePublishJobInput = {
  workspaceId: string;
  draftId: string;
  versionId: string;
  connectionId: string;
};
```

The deterministic BullMQ job ID is the base64url encoding of `shopline:<workspaceId>:<draftId>:<versionId>:<connectionId>`. The database ledger uses the same version boundary through the existing connector idempotency key: `<workspaceId>:<versionId>:shopline:create`. The worker rejects a queued job if `versionId` is no longer the listing's active approved version, so a stale job can never publish newer content accidentally.

`publish_jobs.status` adds the application-level state `pending_enqueue`. `ensure` creates this state before Redis is contacted. `queued` means Redis has accepted the job; `running` means the consumer has claimed it. `markQueued` updates only `pending_enqueue`, so a fast worker can advance to `running` without a later web transaction regressing it to `queued`.

The web route uses a two-phase enqueue:

1. In a workspace-scoped database transaction, validate approval and compliance, calculate the stable version digest, and `ensure` a `pending_enqueue` ledger row.
2. Commit the transaction.
3. Add the narrow job to BullMQ with the deterministic job ID.
4. In a second workspace-scoped transaction, conditionally mark the ledger `queued` and write `listing.publish_queued` only after Redis accepts the job.
5. Return the database job ID to the browser.

If Redis rejects the enqueue, the ledger remains `pending_enqueue` and the route returns an operator-safe retry response. A repeated click reuses the same ledger and BullMQ IDs. It never uploads assets again and never creates a second delivery ledger row.

The stable ledger digest hashes the canonical approved version, including ordered asset IDs, but excludes generated signed URLs. Signed URL timestamps and signatures therefore cannot change idempotency or make the worker appear to publish different approved content.

This design avoids a cross-workspace database poller. The worker receives `workspaceId` from the validated queue payload and enters the existing `database.forWorkspace` boundary before reading any tenant record.

### Worker runtime

The Railway CLI starts both consumers in one private process:

- the existing `listing-pipeline` AI worker;
- a new `shopline-publish` worker.

Startup is atomic: configuration is validated before either consumer is reported healthy. Shutdown closes both workers, both queue handles, Redis, the asset store dependencies, and the database connection.

The SHOPLINE worker:

1. validates the queue payload;
2. verifies `versionId` is still the active approved version;
3. loads the requested connection inside the workspace boundary;
4. creates the configured connector without logging credentials;
5. resolves listing-owned image URLs;
6. invokes `publishApprovedProduct` with the expected version;
7. lets the existing publisher update the ledger, listing state, remote product ID, and audit trail.

Transient `rate_limited` and `remote_unavailable` failures use BullMQ exponential retries. Terminal authorization, validation, connection, stale-version, approval, and compliance failures are persisted using safe codes and are not retried automatically. Completed queue records are removed; failed records are retained in a bounded diagnostic history. Retrying from the UI creates no duplicate because both the version-specific queue ID and connector idempotency key are deterministic.

### Adapter modes and real-write gate

`SHOPLINE_ADAPTER` has three explicit values:

- `disabled`: safe default; API publishing is unavailable and CSV remains usable;
- `mock`: managed-preview and automated acceptance mode; no external SHOPLINE call;
- `real`: constructs `ShoplineConnector` from the decrypted workspace token.

Real mode additionally requires `SHOPLINE_PUBLISH_ENABLED=true`. Startup fails closed if real mode is selected without the enable flag, encryption key, or valid connector configuration. Enabling real mode and the flag is an external production action requiring separate final user confirmation.

The Railway variable allowlist adds:

- `SHOPLINE_ADAPTER`;
- `SHOPLINE_PUBLISH_ENABLED`;
- `SHOPLINE_TOKEN_ENCRYPTION_KEY`.

The raw tenant token remains only as encrypted database content. Railway receives no Resend, Better Auth, database-admin, or raw SHOPLINE credential variable.

Vercel and Railway use the same active encryption-key version while both need to write or read connector credentials. Rotation is staged: deploy readers that accept the old and new key versions, re-encrypt stored tokens, verify, and then remove the old key. The MVP implements the `v1` envelope and documents this rotation sequence without rotating production secrets automatically.

### Token encryption

Create a small Node-only token vault using AES-256-GCM. `SHOPLINE_TOKEN_ENCRYPTION_KEY` is a base64-encoded 32-byte key. Ciphertext uses a versioned envelope:

```text
v1.<base64url-iv>.<base64url-auth-tag>.<base64url-ciphertext>
```

Encryption uses a fresh 96-bit IV for every write. Decryption rejects an unknown version, malformed envelope, incorrect key length, or authentication failure with a generic safe error. Neither function includes the token, ciphertext, key, or low-level crypto error in its message.

A controlled connection-seed command accepts the raw token only through sensitive standard input, encrypts it before insertion, and prints only workspace ID, connection ID, and shop domain. Mock connections do not require decryption and use no real token.

### Images

Both CSV and direct API delivery resolve `activeVersion.content.imageAssetIds` against the workspace-scoped source-asset repository. Resolution must:

- preserve the active version's image order;
- reject missing IDs, duplicates, non-image assets, or assets attached to another listing;
- derive storage keys only from database records;
- create time-bounded signed read URLs through the configured private S3/R2 asset store;
- never accept a URL or storage key from request JSON.

The worker passes these URLs to `projectToShopline`. The CSV route uses the same resolver. Direct delivery URLs need only remain valid long enough for SHOPLINE to ingest them; the configured lifetime is documented and bounded. CSV users are warned that signed image links expire and should import the CSV promptly.

### Grounded AI copy

`OpenAIListingProvider.generate` continues building the deterministic safe projection and includes it in the structured generation request. After parsing, it returns the model-authored canonical listing only if:

- every protected factual field exactly equals the extracted, evidence-backed fact;
- `imageAssetIds` exactly equal the supplied ordered IDs;
- the output passes `canonicalListingSchema`;
- the normal compliance review runs before approval and blocks unsupported claims.

The model may author titles, bilingual descriptions, SEO copy, and tags. It may not change SKU, producer, type, origin, vintage, volume, ABV, price, inventory facts, critic evidence, awards, or image IDs. Tests prove valid authored copy survives and any protected mutation is rejected.

### Authorization

The asset-presign, asset-finalize, and listing-create routes require `operator` or higher through the existing `requireWorkspaceRole` policy. Unauthenticated requests remain `401`; authenticated viewers receive `403`; operators, reviewers, admins, and owners retain access according to the existing role ordering.

Authorization is checked before creating an upload URL, reading request asset IDs, inserting an asset, creating a listing, or enqueueing paid AI work.

## Error handling and observability

- Public responses expose only stable safe codes and retry guidance.
- Queue logs contain job ID, workspace ID, draft ID, attempt, duration, and safe outcome; they never contain listing copy, signed URLs, tokens, ciphertext, or model output.
- Audit records distinguish `listing.publish_requested`, `listing.publish_queued`, `listing.published`, and `listing.publish_failed` so a Redis outage is not reported as queued.
- `publish_jobs` remains the authoritative delivery state shown by the listing detail API; `pending_enqueue` renders as retry required, never as queued.
- Startup validates mode-specific variables and fails before accepting work when configuration is unsafe.

## Testing

### Unit and route tests

- Queue schema, deterministic IDs, retry options, and secret-free payloads.
- Version-staleness rejection and conditional `pending_enqueue -> queued` transition tests.
- Token-vault round trip, unique IVs, malformed envelopes, wrong keys, and safe errors.
- Adapter-mode validation and real-write fail-closed behavior.
- Viewer `403` tests for presign, finalize, and listing creation.
- AI authored-copy preservation and protected-fact rejection.
- Image ownership, order, kind, missing-ID, and signed-URL projection tests.
- Queue enqueue failure returns retry guidance and does not write a false queued audit.

### Integration tests

- Postgres ledger idempotency across repeated enqueue attempts.
- Redis failure leaves `pending_enqueue`; Redis success advances it without regressing a concurrently running job.
- Redis deduplication for the dedicated SHOPLINE queue.
- Worker processing through `database.forWorkspace` with no foreign-record access.
- Terminal and transient failure classification.

### Real-stack Playwright acceptance

The production-built Next server and ordinary Railway worker runtime run against Postgres, Redis, MinIO, and Mailpit. External AI and SHOPLINE adapters remain fake/mock.

The test must:

1. register and sign in the invited Opak admin;
2. upload real image/PDF assets through presigned storage;
3. create and process the listing through the AI queue;
4. review/edit, resolve compliance, and approve;
5. download and validate a CSV containing an image URL;
6. request SHOPLINE delivery through the web route;
7. wait for the ordinary `shopline-publish` worker to store the mock remote product ID;
8. verify the published state and complete audit sequence in the UI/database;
9. verify zero accessible foreign records.

The fixture must not import or directly call `publishApprovedProduct`. A boundary test enforces that prohibition and confirms the worker CLI starts both consumers.

## Deployment and rollback

Managed preview uses `SHOPLINE_ADAPTER=mock` and never makes a real product write. Production remains `disabled` until the separate final approval, even after the consumer is deployed.

Rollback order:

1. disable SHOPLINE publishing;
2. stop or roll back the Railway worker;
3. roll back the Vercel deployment;
4. retain Redis jobs, database ledgers, listings, and private assets for diagnosis;
5. never delete the R2 bucket or production ledger during incident response.

The release gate remains blocked until the clean checkout passes formatting, lint, typecheck, unit tests, integration tests, production build, real-stack Playwright, exact-draft audit verification, tenant-isolation verification, and a fresh independent review with no Critical or Important findings.

## Success criteria

- A browser delivery request reaches the ordinary SHOPLINE worker without a test helper.
- The mock preview stores and displays one deterministic remote product ID.
- Repeated delivery requests do not create duplicate products or ledger rows.
- Viewer mutations return `403` before side effects.
- Model-authored bilingual/SEO copy survives when factual fields remain grounded.
- CSV and direct payloads contain only signed URLs for owned listing images.
- Real SHOPLINE mode cannot start or write without the encryption key and explicit enable flag.
- No credential, ciphertext, signed URL, or raw model content appears in logs, queue payloads, audits, or browser responses.
