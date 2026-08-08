# Shopline Delivery Module Design

**Date:** 2026-08-08  
**Status:** Approved for implementation planning; source implementation has not started.

## Context

The listing review workflow currently decides Shopline delivery in more than
one place. The web path in `apps/web/lib/delivery-service.ts` prepares an
approved listing, checks blocking flags and connection metadata, resolves image
URLs, projects and validates a Shopline payload, and coordinates publish-job
creation. The worker path in `apps/worker/src/publish-product.ts` repeats most
of those policy checks after queueing before it calls the remote connector.

The duplication is correctness-sensitive: approval, the active version,
blocking flags, payload validity, idempotency, and publish-job state all affect
whether a listing may be delivered. The worker must not trust a stale web
decision because the listing can change while a job is waiting.

The domain term **Shopline delivery** is recorded in `CONTEXT.md`.

## Goals

- Create one deep Shopline delivery module that owns delivery eligibility and
  the canonical delivery decision for both `shopline_api` and CSV.
- Evaluate one workspace-scoped view of the listing, active version, review
  flags, connection metadata, and current publish job.
- Produce an immutable delivery plan bound to the exact active-version ID and
  content digest.
- Re-evaluate the same policy in the worker after queueing.
- Reuse the existing Shopline projection and validation rules for both methods.
- Keep persistence, queue ingress, CSV export, audit writes, asset storage, and
  remote Shopline calls behind adapters.
- Preserve the existing route response behavior and the existing two-phase
  publish-job safety protocol.

## Non-goals

- No database schema or migration changes.
- No automatic switch from Shopline API to CSV.
- No live Shopline calls during policy evaluation.
- No redesign of the listing review UI.
- No replacement of the existing Shopline connector retry behavior in this
  slice.

## Chosen design

### Deep module responsibility

The deep module sits with the shared Shopline domain code, alongside the
existing projection and validation implementation. It receives authoritative
facts through a workspace-scoped read seam and returns a typed delivery
outcome. It owns:

- target and method eligibility;
- approved-status and active-version checks;
- unresolved blocking-flag checks;
- published and existing-job decisions;
- verified connection metadata checks for API delivery;
- image resolution through an asset adapter;
- canonical `ShoplineProductPayload` projection and validation;
- the idempotency key and content digest derived from the exact version;
- an explicit CSV fallback outcome when API connection metadata is unavailable.

The module does not write the database, enqueue work, export a file, write an
audit record, or call Shopline. Those actions remain adapter responsibilities.
The module is therefore deep in policy and shallow at its external seams.

### Authoritative snapshot

The read seam supplies one workspace-scoped snapshot containing:

- the listing and its active version;
- review flags and their resolution state;
- verified connection metadata for the requested method;
- the current publish-job record for the derived idempotency key.

The snapshot prevents the web and worker callers from assembling different
subsets of facts. The worker uses the same read seam after it claims a job and
compares the snapshot to the queued plan's exact version and digest.

### Plan identity and outcomes

The plan identity is:

```text
workspaceId + activeVersionId + "shopline:create"
```

The plan also carries the content digest. A worker re-evaluation that sees a
different active-version ID or digest returns a typed policy failure rather
than silently publishing newer content.

Expected business results are typed outcomes rather than exceptions. The
outcome vocabulary preserves the existing behavior and adds the shared
meaning needed by both callers:

- approval required;
- blocking flags;
- disconnected API connection with an explicit CSV fallback;
- already published;
- invalid Shopline payload;
- queued or already running;
- retry required;
- ready delivery plan.

Exceptions remain for infrastructure failures such as an unavailable database,
asset store, queue ingress, or remote connector. The web route maps typed
outcomes through its existing response adapter. The worker maps them to the
existing publish-job failure and retry behavior.

### Method handling

Both CSV and API use the same eligibility, image resolution, projection, and
validation rules. CSV is an execution adapter that serializes the validated
Shopline payload. API is an execution adapter that sends the validated payload
through the existing connector.

When API connection metadata is unavailable, the policy returns a CSV fallback
option. The caller must explicitly choose CSV; the module never changes the
requested method silently.

### Side-effect adapters

The implementation keeps these seams distinct:

1. **Read adapter:** loads the authoritative workspace-scoped snapshot.
2. **Asset adapter:** resolves image asset IDs to URLs.
3. **Publish-job adapter:** ensures the idempotent pending job before queue
   ingress, confirms it as queued afterward, and lets the worker claim it.
4. **Queue adapter:** submits the immutable plan identity and expected version.
5. **CSV adapter:** serializes the validated payload and records the existing
   CSV delivery audit fact.
6. **Shopline adapter:** performs remote status/create calls and retains the
   existing retry and error normalization behavior.
7. **Audit adapter:** persists audit facts carried by policy outcomes at the
   relevant transition points.

The web route remains responsible for session and reviewer checks, request
parsing, queue ingress, response mapping, and the two-phase confirmation. The
worker remains responsible for lease handling, connector execution, and
completion/failure persistence. Neither caller owns eligibility policy after
the migration.

## Flow

```text
review client
  -> POST /api/listings/:id/deliver
  -> web adapter loads workspace snapshot
  -> Shopline delivery module evaluates and returns a typed plan/outcome
  -> publish-job adapter ensures idempotency for API delivery
  -> queue adapter enqueues the exact version and digest
  -> publish-job adapter confirms queued and persists audit facts
  -> worker claims the job
  -> worker loads a fresh workspace snapshot
  -> Shopline delivery module re-evaluates the same policy
  -> Shopline adapter executes the validated payload, or the worker records
     the typed policy failure
  -> worker persists published/failed state and audit facts
```

## Testing design

The test surface is additive and layered:

### Policy matrix tests

Test the shared module through its public test surface for:

- non-Shopline targets and unapproved statuses;
- open and insufficiently resolved blocking flags;
- published listings and existing published jobs;
- unavailable API connection with an explicit CSV fallback;
- asset-resolution failures;
- invalid projection/validation results;
- queued, running, pending, and retry-required job states;
- exact version and digest drift between web preparation and worker
  re-evaluation;
- both `shopline_api` and CSV methods using the same canonical payload rules.

### Adapter contract tests

Test that adapters preserve their side-effect guarantees:

- job ensure happens before queue ingress;
- queued confirmation happens only after successful ingress;
- queue failure returns retry-required without falsely marking a job queued;
- audit facts are persisted at the existing transition points;
- CSV serializes the already validated canonical payload;
- the connector receives the exact idempotency key and payload digest.

### Existing integration tests

Retain and update the existing web route, delivery-service, publish-job, and
worker publication tests. They should verify the seams and response mappings,
not re-implement the policy matrix in every caller.

## Incremental rollout

1. Add the shared policy vocabulary and policy matrix tests beside the existing
   Shopline projection and validation code.
2. Extract the web policy from `prepareShoplineDelivery` and `deliverListing`.
   Keep the route, job adapter, queue adapter, CSV adapter, and response
   mapping behavior unchanged.
3. Add adapter contract tests and verify the web path at parity with the
   current delivery-service tests.
4. Change the worker to load a fresh snapshot and call the same policy before
   connector execution. Preserve lease, connector retry, completion, and
   failure behavior.
5. Remove duplicated eligibility, flag, projection, and version/digest
   branches from the web and worker orchestrators.
6. Run focused tests, typechecks, and the existing broader validation suite;
   inspect the final diff for unrelated changes.

## Alternatives rejected

- **Web-only policy:** rejected because the worker would trust stale approval,
  flags, or version data across the queue seam.
- **Full orchestration inside the policy module:** rejected because it would
  couple domain policy to database, queue, audit, storage, and remote side
  effects and make the module shallow at its real seam.
- **Separate CSV policy:** rejected because it would duplicate the same
  approval, flag, version, image, projection, and validation rules.
- **Latest-version worker behavior:** rejected because a queued request must
  not publish content that was not the requested version.
- **Remote connection probing during policy evaluation:** rejected because it
  adds latency and turns a deterministic decision into a remote side effect.

## Acceptance criteria

- The web and worker use the same Shopline delivery policy for eligibility and
  payload preparation.
- Both delivery methods share one projection and validation path.
- A worker cannot publish when the active version ID or content digest differs
  from the queued plan.
- API disconnection produces an explicit CSV option and never an automatic
  method switch.
- Job ensure/queue-confirm ordering and audit event timing remain unchanged.
- Existing HTTP responses and connector retry behavior remain compatible.
- Policy, adapter, route, and worker tests cover the agreed decision matrix.
- No database migration, production seed, deployment, or live Shopline call is
  part of this change.
