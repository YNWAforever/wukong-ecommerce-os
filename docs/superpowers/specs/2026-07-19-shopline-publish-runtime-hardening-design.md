# Cloudflare Listing and SHOPLINE Runtime Hardening Design

**Date:** 2026-07-19
**Status:** Revised per user direction; written specification awaiting review
**Branch:** `codex/production-listing-workflow`

## Problem

The current web delivery route persists a `publish_jobs` row but no deployed process consumes it. The local acceptance test then calls `publishApprovedProduct` directly, bypassing the production topology. A queued SHOPLINE delivery would remain queued in production.

The release review also found three related gaps:

- viewers can upload assets, finalize assets, and create listings;
- the OpenAI provider validates generated copy and then discards it in favor of a deterministic projection;
- CSV and direct SHOPLINE payloads omit uploaded product images.

The earlier runtime design used Upstash Redis, BullMQ, and Railway. The user has replaced that direction with Cloudflare. The production runtime will therefore use Cloudflare Queues, a Cloudflare Worker, Hyperdrive-to-Neon, and the existing private R2 bucket. Redis and Railway are removed from the target architecture.

## Goals

- Deliver AI listing and SHOPLINE publish jobs through Vercel, an authenticated Cloudflare Worker ingress, Cloudflare Queues, a Cloudflare Worker consumer, Neon, and R2.
- Keep Neon ledgers and pipeline-step leases as the durable, tenant-scoped source of truth under at-least-once queue delivery.
- Keep queue messages narrow, strictly validated, idempotent, and free of credentials, listing content, signed URLs, or model output.
- Permit the Cloudflare Worker to decrypt tenant SHOPLINE tokens without exposing raw tokens to Queues, logs, browser responses, Vercel, or audit metadata.
- Keep real SHOPLINE writes disabled until a separate final user confirmation.
- Include only workspace-owned, listing-attached images in CSV and direct SHOPLINE projections.
- Preserve grounded model-authored bilingual copy while preventing changes to protected facts or asset identifiers.
- Enforce the documented role hierarchy on all listing-intake mutations.
- Make local and managed-preview acceptance traverse the ordinary Cloudflare runtime rather than a direct test helper.

## Non-goals

- No first real SHOPLINE product write in this increment.
- No multi-connection selection UI; the workspace default connection remains the MVP behavior.
- No bulk publishing, scheduled publishing, product updates, or delete synchronization.
- No Redis, BullMQ, Railway service, cross-tenant database poller, or privileged worker database role.
- No raw SHOPLINE token stored in an environment variable.
- No migration from Neon or Vercel.

## Approaches considered

### Chosen: one authenticated Worker ingress and consumer

One Cloudflare Worker exposes two signed enqueue endpoints and consumes both Cloudflare Queues. Vercel holds only a narrow ingress secret and URL, while the Worker uses queue producer bindings. This avoids placing a Cloudflare account API token in Vercel and lets Wrangler exercise the same ingress and consumer locally.

### Rejected: Vercel calls the Cloudflare Queue REST API directly

Cloudflare supports pushing messages through its account API, but Vercel would need a Queues Write API token and account/queue IDs. The token is broader than the application-specific ingress secret and local end-to-end simulation would require an API shim.

### Rejected: separate producer and consumer Workers

This gives stricter deployment separation but adds another deployable service, shared protocol versioning, and additional operational state without improving the MVP’s tenant boundary. The single Worker still keeps fetch and queue handlers as separate modules.

## Runtime architecture

### Cloudflare resources

Each environment has isolated resources:

- Worker: `wukong-runtime-preview` or `wukong-runtime-production`;
- AI queue: `wukong-listing-preview` or `wukong-listing-production`;
- SHOPLINE queue: `wukong-shopline-preview` or `wukong-shopline-production`;
- AI dead-letter queue: `wukong-listing-dlq-preview` or `wukong-listing-dlq-production`;
- SHOPLINE dead-letter queue: `wukong-shopline-dlq-preview` or `wukong-shopline-dlq-production`;
- Hyperdrive: `wukong-neon-preview` or `wukong-neon-production`;
- existing private R2 assets bucket, isolated by environment and workspace prefix.

The Worker pins Wrangler in the lockfile, uses compatibility date `2026-07-19`, and enables `nodejs_compat`. Consumer CPU time is explicitly configured below Cloudflare’s five-minute maximum. Each queue uses a maximum batch size of one, a short batch timeout, controlled concurrency, three retries, a retry delay, and its matching DLQ. A single-message batch prevents one tenant’s failure from replaying another tenant’s successful message.

Cloudflare Queues allows a 15-minute consumer wall time. The application sets a shorter end-to-end deadline and explicit OpenAI and SHOPLINE request timeouts so the handler can record a safe outcome before the platform limit.

### Authenticated ingress

The Worker exposes only:

- `POST /v1/enqueue/listing`;
- `POST /v1/enqueue/shopline`;
- `GET /health` with non-secret build and mode metadata.

Vercel signs enqueue requests with `QUEUE_INGRESS_SECRET`. The request includes `x-wukong-timestamp` and `x-wukong-signature`, where the signature is HMAC-SHA-256 over the timestamp, path, and exact body bytes. The Worker rejects a missing or malformed signature, a timestamp outside five minutes, an unsupported content type, an oversized body, or a schema-invalid payload before calling a Queue binding.

The shared ingress secret is stored as a sensitive Vercel variable and a Cloudflare Worker secret. It never appears in configuration files, logs, responses, or queue messages. A replay inside the five-minute window is harmless because database claims and idempotency keys remain authoritative.

After the binding accepts a message, the Worker returns `202`. It never returns a Cloudflare account identifier, queue identifier, credential, or message body.

### Queue protocols

The AI queue keeps the existing logical payload:

```ts
type ListingJobInput = {
  workspaceId: string;
  draftId: string;
  activeVersionSequence: number;
};
```

The SHOPLINE queue uses:

```ts
type ShoplinePublishJobInput = {
  workspaceId: string;
  draftId: string;
  versionId: string;
  connectionId: string;
};
```

Cloudflare Queues is at-least-once and does not provide the BullMQ custom job-ID deduplication used previously. Duplicate messages are expected. The AI pipeline’s existing run and step leases remain the duplicate guard. SHOPLINE publishing adds an atomic database lease described below. Queue acknowledgements never replace database idempotency.

### Neon through Hyperdrive

The Worker connects to Neon through a `HYPERDRIVE` binding and the existing supported Postgres.js `3.4.7` driver. It creates a short-lived database client per consumer invocation with at most five connections and closes it in `finally`; Hyperdrive owns the underlying connection pool.

Hyperdrive query caching is disabled for this workload. The repositories depend on transactions, current state, and `SET LOCAL` workspace context for RLS; tenant-scoped reads and state transitions must never be served from an intermediary query cache.

Every message is validated before opening the database. The Worker uses the payload’s `workspaceId` only to enter `database.forWorkspace`, which sets the RLS context inside a transaction. Request bodies never supply an actor ID, credential, storage key, URL, or listing content.

Local Wrangler development supplies `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` at runtime. No local or production database URL is committed to `wrangler.jsonc`.

## AI listing consumer

The existing pipeline domain logic remains, but its BullMQ wrapper is removed. The Cloudflare queue handler invokes the pipeline processor directly.

For each message:

1. validate the strict payload;
2. enter the workspace RLS boundary;
3. use existing pipeline-run and step leases to claim work;
4. resolve owned source assets through private R2/S3 URLs;
5. call the configured AI provider with an explicit timeout;
6. persist evidence, AI-run metadata, canonical content, compliance flags, and state transitions;
7. acknowledge success or a safely persisted terminal outcome;
8. request a delayed retry for transient provider, network, or database availability failures.

If all platform retries are exhausted, Cloudflare moves the message to the AI DLQ. The listing remains recoverable from its database pipeline state; DLQ replay does not create a new listing or repeat completed steps.

## SHOPLINE queue and ledger

### Two-phase enqueue

`publish_jobs.status` adds the application-level state `pending_enqueue`. The web route uses this sequence:

1. In a workspace transaction, validate approval, compliance, connection, and active version.
2. Calculate a stable digest of the canonical approved version, including ordered asset IDs but excluding generated signed URLs.
3. `ensure` one `pending_enqueue` ledger row using `<workspaceId>:<versionId>:shopline:create`.
4. Commit the transaction.
5. Send the narrow, signed request to the Cloudflare ingress.
6. After the Worker returns `202`, conditionally mark the ledger `queued` and write `listing.publish_queued` in a second workspace transaction.
7. Return the database job ID to the browser.

If ingress or Queue binding delivery fails, the ledger remains `pending_enqueue`, the UI renders retry required, and no queued audit is written. A repeated click reuses the same row. If the consumer runs before the second web transaction, its atomic claim advances the row to `running`; `markQueued` updates only `pending_enqueue` and cannot regress it.

### Atomic publish lease

Cloudflare may deliver duplicates concurrently. `publish_jobs` therefore adds:

- `lease_token`;
- `lease_expires_at`;
- `attempt_count`.

The repository atomically claims `pending_enqueue`, `queued`, retryable `failed`, or an expired `running` row and returns a fresh lease token. A non-expired `running` row, a `published` row, or a stale version is not claimed. Every state update requires the current lease token, preventing a stale consumer from overwriting a newer attempt.

The connector idempotency key remains version-scoped. Even if Cloudflare redelivers after an ambiguous network response, the Worker checks the ledger and remote status before attempting another create.

### Consumer behavior

The SHOPLINE consumer:

1. validates the queue payload;
2. enters the workspace RLS boundary;
3. verifies `versionId` is still the active approved version;
4. claims the publish lease;
5. loads the requested connection inside the same workspace;
6. creates the configured connector without logging credentials;
7. resolves listing-owned image URLs;
8. invokes `publishApprovedProduct` with the expected version and lease;
9. persists the ledger, listing state, remote product ID, digest, and audit result;
10. acknowledges success or a safely persisted terminal outcome.

Transient `rate_limited`, `remote_unavailable`, timeout, and database availability failures call `message.retry()` with a bounded delay. Terminal authorization, validation, connection, stale-version, approval, and compliance failures are persisted using safe codes and acknowledged. Exhausted transient failures enter the SHOPLINE DLQ and remain visible as retryable database state.

## Adapter modes and real-write gate

`SHOPLINE_ADAPTER` has three explicit values:

- `disabled`: safe default; API publishing is unavailable and CSV remains usable;
- `mock`: managed-preview and automated acceptance mode; no external SHOPLINE call;
- `real`: constructs `ShoplineConnector` from the decrypted workspace token.

Real mode additionally requires `SHOPLINE_PUBLISH_ENABLED=true`. Worker initialization fails closed if real mode is selected without the enable flag, encryption key, or valid connector configuration. Enabling real mode and the flag is an external production action requiring separate final user confirmation.

The raw tenant token remains only as encrypted Neon content. Vercel receives no OpenAI key, token-encryption key, raw SHOPLINE token, Hyperdrive credential, or Cloudflare account API token.

## Token encryption

Use the Web Crypto API so the same audited implementation works in Node 24 tooling and Cloudflare Workers. `SHOPLINE_TOKEN_ENCRYPTION_KEY` is a base64-encoded 32-byte AES-256-GCM key. Ciphertext uses:

```text
v1.<base64url-iv>.<base64url-ciphertext-with-auth-tag>
```

Encryption uses a fresh 96-bit IV for every write. Decryption rejects an unknown version, malformed envelope, incorrect key length, or authentication failure with one generic safe error. Neither function includes the token, ciphertext, key, or low-level crypto error in its message.

A controlled connection-seed command accepts the raw token only through sensitive standard input, encrypts it before insertion, and prints only workspace ID, connection ID, and shop domain. The seed environment and Cloudflare Worker use the same active key version. Key rotation deploys dual-version readers first, re-encrypts stored tokens, verifies, and only then removes the old key.

Mock connections do not decrypt or use a real token.

## Private R2 assets and images

Vercel retains the existing R2 S3-compatible presign flow for browser uploads. The Cloudflare Worker uses the existing private R2 endpoint and narrowly scoped object credentials to create short-lived source reads for OpenAI and SHOPLINE ingestion. Queue payloads contain only database IDs, never keys or URLs.

Both CSV and direct API delivery resolve `activeVersion.content.imageAssetIds` against the workspace-scoped source-asset repository. Resolution must:

- preserve the active version’s image order;
- reject duplicates, missing IDs, non-image assets, or assets attached to another listing;
- derive storage keys only from database records;
- create time-bounded signed read URLs;
- never accept a URL or storage key from request JSON.

The SHOPLINE consumer passes those URLs to `projectToShopline`. The CSV route uses the same resolver. The stable ledger digest excludes signed URL query parameters. CSV users are warned that image links expire and should import promptly.

## Grounded AI copy

`OpenAIListingProvider.generate` continues building the deterministic safe projection and includes it in the structured request. It returns the model-authored canonical listing only if:

- every protected factual field exactly equals the extracted, evidence-backed fact;
- `imageAssetIds` exactly equal the supplied ordered IDs;
- the output passes `canonicalListingSchema`;
- the normal compliance review runs before approval and blocks unsupported claims.

The model may author titles, bilingual descriptions, SEO copy, and tags. It may not change SKU, producer, type, origin, vintage, volume, ABV, price, inventory facts, critic evidence, awards, or image IDs. Tests prove valid authored copy survives and protected mutations are rejected.

## Authorization

Asset presign, asset finalize, and listing creation require `operator` or higher through `requireWorkspaceRole`. Unauthenticated requests remain `401`; authenticated viewers receive `403` before an upload URL is created, asset IDs are read, an asset or listing is inserted, or paid AI work is enqueued.

## Error handling and observability

- Public responses expose only stable safe codes and retry guidance.
- Worker logs contain queue name, Cloudflare message ID, workspace ID, draft ID, attempt, duration, and safe outcome.
- Logs never contain listing copy, model output, signed URLs, credentials, ciphertext, request signatures, or database URLs.
- Audit records distinguish `listing.publish_requested`, `listing.publish_queued`, `listing.published`, and `listing.publish_failed`.
- `publish_jobs` is authoritative; `pending_enqueue` renders as retry required, never queued.
- DLQ depth, queue backlog, oldest message age, Worker errors, and Hyperdrive errors are deployment health signals.
- `/health` reveals only build SHA, adapter mode, and configuration presence booleans.

## Configuration boundaries

### Vercel preview/production

- `QUEUE_INGRESS_URL`;
- `QUEUE_INGRESS_SECRET`;
- existing runtime `DATABASE_URL`, auth/mail settings, and R2 browser-presign variables;
- no `REDIS_URL`, OpenAI key, token-encryption key, raw SHOPLINE token, or Cloudflare API token.

### Cloudflare Worker secrets and bindings

- Queue producer and consumer bindings for both queues and both DLQs;
- `HYPERDRIVE` binding with caching disabled;
- `QUEUE_INGRESS_SECRET` secret;
- `OPENAI_API_KEY` secret;
- `SHOPLINE_TOKEN_ENCRYPTION_KEY` secret;
- private R2 S3 access key and secret;
- non-secret R2 endpoint, bucket, region, adapter mode, model, and publish-enable flag.

`DATABASE_ADMIN_URL`, Better Auth, Resend, and raw SHOPLINE credentials are forbidden in the Worker.

## Repository changes

- Keep `@wukong/jobs` as the shared strict protocol package but remove BullMQ and ioredis dependencies.
- Replace the web Redis publisher with a signed Cloudflare ingress client.
- Convert `apps/worker` from a Railway CLI/BullMQ process to a Cloudflare `fetch` and `queue` Worker while retaining its domain pipeline and publisher modules.
- Add `wrangler.jsonc`, Worker type generation, local Wrangler configuration, queue/DLQ bindings, Hyperdrive binding, observability, and CPU limit.
- Remove `railway.json` and Railway-specific tests/runbook instructions.
- Remove all required `REDIS_URL` variables and Upstash resource instructions.
- Update CI to validate Wrangler configuration and run the Worker build/type generation.

## Testing

### Unit and route tests

- HMAC ingress signing, skew rejection, strict schemas, body limits, and secret-free responses.
- Cloudflare queue protocol payloads contain IDs only.
- Viewer `403` tests for presign, finalize, and listing creation.
- AI authored-copy preservation and protected-fact rejection.
- Publish lease claim, expiry, stale-token rejection, and duplicate delivery behavior.
- Image ownership, order, kind, missing-ID, and signed-URL projection.
- Ingress failure leaves `pending_enqueue` and writes no false queued audit.
- Adapter-mode validation and real-write fail-closed behavior.
- Token-vault round trip, unique IVs, malformed envelopes, wrong keys, and safe errors.

### Integration tests

- Wrangler/Miniflare invokes the same Worker queue handler used in deployment.
- Duplicate AI messages complete each pipeline step once.
- Duplicate SHOPLINE messages produce one ledger result and one mock remote product ID.
- Hyperdrive local connection uses the existing Postgres RLS repositories.
- Redis and BullMQ are absent from runtime configuration and dependencies.
- Terminal messages are acknowledged; transient messages retry and exhaust into the correct DLQ.

### Real-stack Playwright acceptance

Run the production-built Next server and `wrangler dev` against Postgres, MinIO, and Mailpit. Wrangler provides local Queue simulation and the local Hyperdrive connection string. External AI and SHOPLINE adapters remain fake/mock.

The test must:

1. register and sign in the invited Opak admin;
2. upload real image/PDF assets through presigned storage;
3. create a listing through Vercel-compatible web code;
4. send the signed request to the ordinary Worker ingress;
5. let the local Cloudflare Queue invoke the AI consumer;
6. review/edit, resolve compliance, and approve;
7. download and validate a CSV containing an image URL;
8. request SHOPLINE delivery through the web route and Worker ingress;
9. let the SHOPLINE queue consumer store the mock remote product ID;
10. verify the published UI state, complete audit sequence, and zero accessible foreign records.

The fixture must not directly invoke either pipeline processor or `publishApprovedProduct`. A boundary test enforces this and confirms the Worker exports both `fetch` and `queue` handlers.

## Managed-preview verification

Preview provisions isolated Cloudflare Queues, DLQs, Worker, Hyperdrive, and R2 resources. `SHOPLINE_ADAPTER=mock`; no real SHOPLINE write occurs.

Verification records:

- Worker deployment ID and source commit;
- queue and DLQ names, backlog, and oldest-message metrics;
- Hyperdrive configuration name without its connection string;
- Vercel preview deployment ID;
- one synthetic Opak listing ID and mock remote product ID;
- exact audit and RLS verifier results;
- confirmation that no Redis, Upstash, or Railway runtime remains.

## Deployment and rollback

Production deploys the Worker in `disabled` SHOPLINE mode until separate final approval. Database migrations run once from the controlled release environment, never from Worker startup.

Rollback order:

1. set SHOPLINE publishing to disabled;
2. pause both Cloudflare Queues;
3. roll back the Cloudflare Worker;
4. roll back Vercel if the ingress contract also changed;
5. retain queue/DLQ messages, Neon ledgers, listings, audits, and private assets;
6. never delete the R2 bucket, DLQs, or production ledger during incident response.

## Release gate

The release remains blocked until a clean checkout passes:

- frozen installation and runtime formatting;
- Wrangler configuration validation and Worker type generation;
- lint, typecheck, unit tests, and Postgres integration tests;
- production Next and Worker builds;
- real Wrangler/Cloudflare Queue local acceptance;
- exact-draft audit verification;
- tenant-isolation verification;
- a fresh independent review with no Critical or Important findings.

## Success criteria

- Redis, BullMQ, Upstash, Railway configuration, and Railway runtime are absent.
- Browser listing creation traverses signed Worker ingress and Cloudflare Queue before AI processing.
- Browser delivery traverses signed Worker ingress and Cloudflare Queue before SHOPLINE publishing.
- Duplicate Cloudflare messages cannot duplicate AI steps, ledger rows, or products.
- The mock preview stores and displays one deterministic remote product ID.
- Viewer mutations return `403` before side effects.
- Model-authored bilingual/SEO copy survives while factual fields remain grounded.
- CSV and direct payloads contain only signed URLs for owned listing images.
- Real SHOPLINE mode cannot initialize or write without the encryption key and explicit enable flag.
- No credential, ciphertext, request signature, signed URL, raw model content, or database URL appears in logs, messages, audits, or browser responses.
