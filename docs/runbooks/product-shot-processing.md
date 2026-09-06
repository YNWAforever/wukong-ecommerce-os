# Product-shot processing

## Release status

The Photoroom workflow is being implemented under `docs/superpowers/plans/2026-09-07-photoroom-product-shot.md`. This runbook describes the implemented operational contract. Consult the phase result document for completed verification before activation; the presence of this file is not evidence of a production rollout.

## Operator workflow

Upload one actual bottle photo with the listing. One eligible photo is selected automatically; where a draft contains several photos, select one main photo. The background is white and requires no configuration. The original remains private.

Review the saved finished JPEG beside the original. Check the label, bottle edges, cap and transparent glass. Background removal can remove real foreground detail; automated checks cannot certify visual accuracy. A low-resolution notice indicates the image has not been enlarged to disguise missing detail.

Approve the exact candidate before exporting it. Listing factual confirmations and blocking flags still apply. Replacing the main photo invalidates its current image approval. Previously published image versions remain available for already downloaded exports. Saving factual confirmations after approval writes a new confirmation revision and reopens the listing for review, even when values are unchanged; reapprove before another export. This reuses the saved image and does not trigger another provider call.

## Administrator configuration

| Setting                                        | Source                                               | Purpose                                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PRODUCT_SHOT_PROVIDER`                        | Application deployment configuration                 | `disabled` by default; `fake` for isolated verification; `photoroom` only for authorized live activation    |
| `PHOTOROOM_API_KEY`                            | Photoroom API dashboard                              | Worker-only API credential; never put it in browser settings, commits or logs                               |
| `PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY` | Administrator's explicit allowance                   | Positive integer dispatch limit required for live calls; uncertain dispatched attempts count conservatively |
| `PRODUCT_IMAGE_PUBLIC_ORIGIN`                  | HTTPS origin of the deployed application image route | Stable approved-image URLs; does not make private source storage public                                     |
| Existing S3/R2 configuration                   | Existing application storage setup                   | Private original, cutout and final object storage                                                           |

Select an API plan in the provider's own dashboard only after spending authorization. A consumer image-editor subscription is not assumed to provide API credentials or quota. Check the current official API pricing and account limits before activation. Design research recorded USD0.02 per Basic background-removal call, which is an estimate, not a billing guarantee.

- API quickstart: https://docs.photoroom.com/remove-background-api-basic-plan/quickstart-guide
- API pricing: https://www.photoroom.com/api/pricing
- API keys: https://help.photoroom.com/en/articles/15419535-find-your-photoroom-api-keys-web-app

Keep SHOPLINE writes and SHOPLINE publishing disabled during image acceptance. Provider setup does not authorize SHOPLINE publishing, uploading a merchant workbook, production migration, or deployment.

## Processing and retry behavior

| State           | Meaning                                     | Operator action                                                              |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Queued          | Saved request awaiting worker               | Wait; leaving the page preserves the draft                                   |
| Processing      | A provider attempt owns the lease           | Wait; duplicate queue delivery does not dispatch another call                |
| Cutout ready    | Provider result safely stored               | Prepare the review candidate; this step does not call the provider           |
| Candidate ready | Exact JPEG saved for review                 | Compare original and finished image, then approve or replace                 |
| Approved        | Exact image accepted                        | Complete listing review and export eligibility checks                        |
| Failed          | A definite failure has been recorded        | Follow the sanitized error and retry the failed stage                        |
| Outcome unknown | Provider completion could not be determined | Explicitly choose whether to start a new attempt; another charge is possible |

A successful stored cutout is reused for rendering retries. A successful stored candidate is reused for review/publication retries. An explicit new provider attempt differs from resuming stored work. Do not repeatedly click a new-attempt action to resolve an uncertain result.

If the provider is not configured or the allowance is exhausted, correct the administrator configuration instead of rerunning listing text generation. Provider/API details and customer images must not appear in logs.

## Public image contract

Only approved final artifacts may be served through `/product-images/<token>.jpg`. Originals, cutouts and unapproved candidates keep authenticated access. The public route streams the image; it does not hand a merchant an expiring private presigned URL.

Each immutable publication pins the final object against orphan cleanup. Keep the configured public origin and publication records available while merchants rely on exported URLs. Explicit revocation can break external references and is separate from replacing a draft photo. Do not delete historical image objects as part of routine draft cleanup.

This feature does not change the existing CSV columns or make the 71-column Bulk Update workbook a new-product template. A stable image URL is not proof of SHOPLINE import acceptance.

## Verification and activation boundary

Development and CI must use synthetic images, local storage/database services, and the fake provider. The real-stack fixture must prevent an inherited production key or provider selection from enabling live calls. Verify both the web path and the Cloudflare queue boundary, not just mocked component rendering.

Before any separately authorized activation, the implementation results must show focused adapter/renderer tests, isolated lease/RLS/audit checks, stale approval/publication tests, no-retry browser acceptance, type/build/runtime checks, and a worker bundle that excludes native sharp. Report intentional test skips separately.

An authorized one-photo provider trial establishes actual bottle/glass quality and observed billing separately from synthetic correctness. Production migration, deployment, credentials, provider spending, real photo transfer and SHOPLINE acceptance each retain their existing authorization boundary; none were performed merely by writing this runbook.

## Queue budget recovery

A dispatch denied by the daily allowance remains queued and waits until the next UTC budget window. This wait does not call Photoroom. Repeated daily denial can eventually reach the existing queue's dead-letter handling; after the allowance is available, an explicit image request can enqueue the same undispatched attempt again.

An uncertain dispatched attempt behaves differently: queue redelivery does not call the provider again. The operator must explicitly choose a fresh attempt if another possible charge is acceptable. A stored cutout can proceed to local preparation without another provider call.

The publication gate applies to image-carrying create CSV and SHOPLINE image delivery. The 71-column Bulk Update has no image column and keeps its existing factual review and source-binding requirements; this feature does not add an image URL column or reinterpret that workbook.

## Local acceptance modes

The browser harness uses `WUKONG_PRODUCT_SHOT_E2E=1` to opt into synthetic image
processing. It strips inherited Photoroom credentials, pins the fake provider,
and confines scenario controls to the local E2E build identity. The fixture owns
its loopback HTTPS proxy and shuts it down with its app/Worker processes.

Run the product-shot browser suite in this guarded fake mode. Run the existing
workbench, catalog-usability and Bulk Update suites with image processing
disabled, preserving their original approval contract. Use one worker and zero
retries; record both runs. A single provider mode cannot represent both contracts.
Fixture objects and workspaces are scoped per run so retained audit/image records
from earlier synthetic runs remain intact.

For the local HTTPS image check, prepare a locally issued certificate valid for
`localhost` and its matching private key at
`node_modules/.photoroom-services/certs/public.crt` and `private.key`.
The fixture trusts the existing local CA at
`.wrangler/caddy-data/caddy/pki/authorities/local/root.crt`; the leaf certificate
must chain to that CA. These are generated local test materials, not deployment
credentials, and remain untracked. Keep ports 49217 (app), 49218 (image HTTPS
proxy) and 8787 (Worker) free before starting the fixture. Use the isolated
Postgres, object storage and mail settings from the local-development runbook;
never point the fixture at merchant or production services.
