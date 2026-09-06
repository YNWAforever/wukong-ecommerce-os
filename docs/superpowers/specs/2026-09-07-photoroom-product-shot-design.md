# Photoroom single-photo product-shot design

Date: 2026-09-07
Status: Written specification approved by the user; implementation authorized through the seven-task plan.
Baseline: origin/main fe64fb80ff5b1ff6d8efa4962828170b68adcfc2.

## Purpose and approved scope

An operator uploads one actual bottle photo and receives one reviewable catalog image on white. The system removes the background, centers the photographed subject, and preserves the original privately. It does not reconstruct bottles, redraw labels, generate extra angles, or invent unseen details. Background removal can damage glass or edges; operator review is required and pixel-perfect preservation is not promised.

The user selected a hosted background-removal service, Photoroom, one main photo, and automatic white background. This slice completes processing, recoverable review, and approved-image export URLs. It does not implement the separate new-product XLSX template, pricing/SKU/category rules, or SHOPLINE publication. The supplied merchant brief is requirements context, not execution authority.

## Existing code and changes in direction

Source was checked in the active checkout after graph discovery:

- `packages/ai/src/contracts.ts` defines `ProductShotProvider`, returning a cutout and usage.
- `apps/worker/src/listing-pipeline.ts` has an optional product-shot step which is not currently wired for production.
- `packages/assets/src/product-shot-flatten.ts` uses native Node `sharp` for compositing.
- `apps/web/components/product-shot-panel.tsx` and `apps/web/lib/listing-approval.ts` provide existing review and approval foundations.
- `packages/assets/src/listing-image-resolver.ts` uses expiring read URLs. These do not satisfy the stable public export contract.

Reuse these boundaries instead of replacing the listing pipeline. This specification supersedes the August 21 product-shot design only for the new single-photo workflow: white is automatic, image retries are independent of copy generation, and permanent export access requires explicit image approval. Existing unrelated listing and legacy brand-background behavior must remain intact. The earlier document's claim that public export URLs already satisfy the brief is not evidence of permanence.

## Operator experience

A single uploaded photo is selected automatically as the main source. If an existing draft has several photos, ask the operator to select one once. Never silently process an arbitrary photo or all attachments.

After intake, show processing progress beside the saved draft. Text generation may complete independently. Show the original and the exact final white-background candidate side by side; do not show an approximate CSS preview as the artifact being approved. Offer Approve image, Retry processing, and Replace photo. White is fixed for this workflow and there is no provider, resolution, prompt, or background field for operators.

The draft remains recoverable after navigation or processing failure. A missing provider configuration shows a setup-required state without repeatedly queueing work. Image approval can be included in the existing listing review submission, but is bound to the exact candidate digest and observed listing version. All existing factual review and export eligibility checks still apply.

## Components and runtime boundaries

1. A Photoroom adapter in `packages/ai` implements the existing provider boundary, narrowed at the call site to the selected source. It uses the documented background-removal endpoint, multipart image bytes, and server-side credentials. It receives no merchant workbook, listing copy, or unrelated assets. Fetch source bytes only through the workspace-scoped asset store, not a client-supplied URL. Inject the HTTP transport for tests.
2. The Cloudflare worker coordinates the durable image attempt, calls Photoroom, and saves the returned transparent PNG privately. It must not import native `sharp` into its bundle. Provider usage records call count and estimated cost; zero token counts must not be presented as token billing for this service.
3. A Node-runtime image renderer reuses `packages/assets` to decode, validate, crop transparent padding, resize, center, and flatten. A bounded authenticated web-side prepare operation creates the saved candidate before review. It is idempotent and can resume from the stored cutout without calling Photoroom. The prepare operation takes a persisted attempt identity, never arbitrary image bytes or remote URLs from the caller, and applies server session, role, workspace, and observed-version checks.
4. A product-shot repository owns source identity, attempt state, candidate identity, approval binding, and publication identity. Routes remain thin and use existing workspace transactions, RLS, leases, and audit conventions. Necessary additive schema changes are tested locally; applying them to production is outside this authorization.
5. A publication adapter exposes only immutable, explicitly approved final artifacts through a stable HTTPS image route. Original uploads and cutouts retain authenticated access.

The renderer produces a square JPEG up to 1600 by 1600 pixels, white RGB background, with the subject contained within an 80 percent inset box and no stretching. Avoid enlarging a low-resolution subject; flag it for review. Strip metadata. Target at most 2 MiB by bounded quality and dimension reductions; if the target cannot be met, fail preparation instead of exporting an oversized or invalid artifact. Decode limits, file-size limits, and alpha-bound checks are enforced before processing. Empty foreground, unsupported media, and corrupt images cannot become candidates. Use named limits of 10 MiB encoded input and 40 megapixels decoded input, further restricted by any lower existing upload limit. Cover each boundary in tests.

## Durable processing and cost controls

Track image state separately from listing workflow status: queued, processing, cutout-ready, candidate-ready, approved, failed, and outcome-unknown. Existing domain transitions still own listing status. Bind every attempt to workspace, listing, selected source asset and content digest, provider configuration version, and render version.

A lease and uniqueness constraint prevent concurrent queue deliveries from starting the same provider call. Store a successful cutout before downstream rendering. Redelivery after that checkpoint reuses it. Rendering and publication retries never repeat background removal. The cache is workspace-scoped; do not share merchant images across workspaces.

A remote provider call and a local database commit cannot be atomic. If a timeout or crash leaves provider completion uncertain, record outcome-unknown and require an explicit retry that warns another charge is possible. Do not promise exactly-once billing or blindly retry ambiguous requests. Definitive failures remain actionable with a sanitized message. Retry processing reuses stored successful output; requesting a fresh provider attempt is a separate explicit action. Replacing the photo creates a new source identity and invalidates image approval for the current draft.

Development and CI use a local fake provider. Live processing is disabled by default and must be deliberately enabled with configured credentials and an operational request budget. Enforce a configured workspace call allowance before dispatch; missing allowance fails closed. Count dispatched attempts conservatively, including uncertain outcomes. Browser responses and logs never contain keys, signed URLs, or image contents.

## Approval and stable URLs

Approval verifies the exact candidate digest, selected source, active version, and authorized workspace. Stale approval submissions fail with a refresh action. An image change invalidates the associated current review/export decision through the existing version/content binding. Image approval alone never approves factual content or bypasses blocked/unconfirmed listing checks.

Persist an immutable publication record that maps an unguessable ASCII token to the approved final object's identity and digest. Serve `/product-images/<token>.jpg` over the configured public HTTPS web origin with image content headers. The endpoint performs a narrowly scoped publication lookup and streams the object; it must not expose general tenant queries, raw storage keys, unapproved candidates, or originals. Tokens are public distribution identifiers, not authentication for private assets. Do not redirect to an expiring presigned URL as the durable URL contract.

Image delivery for this new workflow resolves the approved publication URL, never a raw source fallback. Publication creation is idempotent. An export attempted before publication is ready returns an actionable blocked result. Versions get different URLs and historical published images remain available for previously downloaded exports. Explicit revocation returns not-found and may break external references; this is not an automatic consequence of replacing a draft photo. Avoid immutable long-lived caching that would prevent effective revocation.

The publication record pins the stored final object against routine orphan cleanup. Stable means non-expiring while the service and retained publication are available, not an infinite availability guarantee. Existing Bulk Update source-binding behavior and the 15-column CSV format are unchanged; this slice does not certify merchant acceptance or add an Images column to the update workbook.

## Configuration and external setup

Proposed server-only configuration:

- `PRODUCT_SHOT_PROVIDER`: disabled by default; fake in isolated tests; photoroom when deliberately enabled.
- `PHOTOROOM_API_KEY`: obtained by the administrator from the Photoroom API dashboard; supplied to the worker secret store, never the browser.
- `PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY`: explicit positive allowance required for live dispatch.
- `PRODUCT_IMAGE_PUBLIC_ORIGIN`: configured HTTPS application origin serving the publication route.

Use existing private S3/R2 storage configuration; do not make the source bucket public. No additional merchant input is required. The implementation plan must reconcile these proposed names with existing deployment validation before adding them.

Photoroom documentation checked during design lists the Basic background-removal API at USD 0.02 per call. This is an estimate, not a spending authorization or account-specific quote. Subscription terms, taxes, and retry charges must be checked when activating an account. Provider selection does not authorize buying a plan, sending real photos, or deploying production changes.

References:

- https://www.photoroom.com/api/pricing
- https://docs.photoroom.com/remove-background-api-basic-plan/quickstart-guide
- https://docs.photoroom.com/remove-background-api-basic-plan/sandbox-mode

## Verification and acceptance

- Adapter tests use synthetic image bytes and a mocked HTTP transport: exact selected input only, authentication placement, invalid responses, oversized payloads, rate limit, and ambiguous timeout handling.
- Renderer tests inspect actual synthetic pixels and output metadata: white background, centered containment, preserved aspect ratio, no unintended enlargement, bounded output, and corrupt/empty inputs. No real workbook or bottle photograph is a fixture.
- Isolated Postgres/storage tests prove lease concurrency, repeated queue delivery, cutout checkpoint recovery, budget enforcement, stale approval rejection, cross-workspace denial, and audit coverage.
- Public URL tests prove stable access after the private signing TTL, deny original/cutout/unapproved access, preserve old publication versions, and honor explicit revocation. Export tests reject missing/currently unapproved image bindings and retain existing listing eligibility rules.
- Browser tests cover upload, progress, saved draft recovery, exact final preview, retry without copy regeneration, photo replacement, approval, and export readiness in both supported locales.
- Verify the Cloudflare bundle excludes native rendering dependencies. Run targeted suites and the repository's required typecheck, build, integration, and audit checks before reporting implementation complete.
- A later explicitly authorized single-photo live trial checks real bottle/glass quality and provider billing separately. Passing synthetic tests is not evidence of live service quality or SHOPLINE import acceptance.

## Delivery boundary and brainstorming checklist

Context exploration, scope clarification, alternatives, and conversational design approval are complete. A visual companion was unnecessary for these text decisions. This document is the design-writing deliverable; it is not an implementation plan. Self-review checks completeness, internal consistency, scope, and ambiguity. The next checkpoint is user review of this written specification, followed by the writing-plans skill after approval.
