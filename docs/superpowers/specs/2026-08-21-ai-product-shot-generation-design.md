# AI Product Shot Generation Design

**Date:** 2026-08-21
**Status:** Approved for implementation planning; source implementation has not started.

## Context

This is the first of several sub-projects under a proposed revised intake
flow:

```
[Input] wine name + label photo (raw) + price (optional)
  → Step 1: vision extraction → structured facts
  → Step 2: AI product shot generation  ← this spec
  → Step 3: upload shot to storage → public HTTPS URL
  → Step 4: LLM data completion (bilingual naming/SEO/summary)
  → Step 5: business rule engine (price tier / SKU / category)
  → Step 6: review & edit UI, including final shot preview
  → Step 7: SHOPLINE-importable file (Images field = Step 3's URL)
```

Steps 1, 4, 3, and most of 7 already exist: `ListingAIProvider.extract()`
(`packages/ai/src/contracts.ts:31-36`) already turns a photo + note into
structured `ListingFacts` matching the target shape (producer, vintage,
region, ABV, volume); `generate()` already produces bilingual
name/SEO/summary; and the existing "create" CSV delivery path
(`apps/web/lib/delivery-service.ts:169-177`) already resolves
`imageAssetIds` to public URLs and includes them in the exported file.

What does not exist anywhere in the codebase: any image-generation or
background-removal capability (Step 2), a business rule engine for pricing
tiers, SKU generation, or category mapping (Step 5), and any image display
in the review UI (Step 6). This spec covers Step 2 only. Steps 5 and 6's
image portion, and confirming the simplified intake shape for Step 1, are
separate specs to follow.

The domain term **product shot** will be recorded in `CONTEXT.md`: the
AI-generated, background-isolated version of a listing's uploaded label
photo, distinct from the raw upload itself.

## Goals

- Given a listing's uploaded label photo(s), produce one AI-generated cutout
  with the background removed to transparency, while preserving the
  bottle/label pixels essentially unchanged (this is a regulated product;
  altering label text or details is not acceptable).
- Let a reviewer choose the final background — plain white, or the
  workspace's configured brand color — with no additional AI cost per
  choice. Only the cutout itself costs an AI call; compositing onto a
  background is free, deterministic image work.
- Run automatically as part of the existing AI processing pipeline
  (alongside `extract`/`generate`), so the shot is already available by the
  time a reviewer opens the listing.
- Persist the reviewer's chosen, flattened image as a real stored asset at
  approval time, and feed it into `imageAssetIds` so existing delivery paths
  pick it up with no changes.
- Track generation cost through the existing `ai_runs` ledger, the same way
  enrichment batches are tracked today.

## Non-goals

- No full generative restyling (new lighting, new composition, invented
  backgrounds beyond a flat color). The brief explicitly considered this and
  rejected it for this phase: the risk of a generative model altering label
  text or details is unacceptable for a regulated product. Full restyling,
  if ever wanted, is a separate future feature.
- No uploaded/custom background images. Brand background is a single
  workspace-level color, not an asset library.
- No per-listing background stored until approval. A reviewer toggling
  white vs. brand while reviewing does not write anything — only the
  choice made at approval time is persisted as a real asset.
- No changes to Step 5 (business rules) or Step 6's non-image review UI.
  Those are out of scope for this spec.
- No on-demand/lazy generation path. If cost from always-on generation
  turns out to be a problem in practice, that is a follow-up, not part of
  this design.

## Chosen design

### Pipeline placement

The product shot step runs inside the existing listing processing pipeline
(`apps/worker/src/listing-pipeline.ts`), after `extract()` and alongside
`generate()`. Like those two, it is a `ListingAIProvider`-shaped capability
with a fake implementation for tests, following the existing pattern in
`packages/ai`.

Input: the listing's uploaded label photo asset(s) (the same
`ExtractionAsset[]` already passed to `extract()`). Output: one new stored
asset — a transparent-background PNG cutout — plus the same `AIUsage`
shape (`inputTokens`/`outputTokens`/`estimatedCostUsd`/`latencyMs`/`model`)
already used for extraction and generation, recorded through the existing
`ai_runs` ledger.

Re-delivery of a message must remain a no-op per the project's queue
idempotency rule: if a cutout asset already exists for this
listing/version/sequence, the step short-circuits rather than regenerating
and re-billing.

### Generating the cutout while protecting the label

The call to OpenAI's image edit API is mask-based, not a bare
"remove the background" prompt: the mask marks only the background region
editable; the bottle/label region is protected, so those pixels come from
the original image, not the model's regeneration. Background output uses
transparent mode so a single generation serves both the white-background and
brand-background cases downstream.

Building an accurate protective mask is the open technical risk in this
design. The likely first approach is a rough bounding region from the
vision model already used for extraction, but this is unproven. The
implementation plan's first task must be a spike: run the actual approach
against a handful of real Opak Cellar bottle photos and check label-text
fidelity (e.g. OCR the label before and after, confirm no drift) before any
further work is built on top of it. If fidelity doesn't hold up, stop and
bring the finding back for a design change — do not ship an unverified
mitigation.

### Storage and asset model

The cutout is stored through the existing `packages/assets` R2/S3 store,
same as any other listing image, tagged with a role distinguishing it from
the raw upload (e.g. `kind: "product_shot_cutout"` on the asset record —
exact schema detail for the implementation plan). It is an intermediate
asset: not yet delivery-ready, since it still needs a background composited
in before SHOPLINE can use it.

### Review UI

The listing review page gains an image panel showing the cutout composited
live over the current background choice (white by default), with a toggle
for white vs. the workspace's brand color. Toggling recomposites
client-side — cheap, instant, no server round trip, no new AI call.

The toggle state is not persisted until the reviewer approves the listing.
On approval, the currently-selected background is flattened into the cutout
server-side, producing one final PNG, stored as a new asset, and added to
the listing version's `imageAssetIds`. This keeps existing delivery code
(`delivery-service.ts`, bulk-form export) completely unchanged — they
already resolve `imageAssetIds` to URLs.

### Workspace brand background

`workspaceProfileSchema` (or an equivalent workspace-settings location —
exact placement is an implementation detail) gains one field: a brand
background color (hex). This is the only configurable input to Step 2;
there is no per-listing or uploaded-background option in this phase.

### Cost and idempotency

Generation cost is recorded via the same `AIUsage`/`ai_runs` mechanism as
`extract`/`generate`, so it shows up in existing spend visibility without a
new tracking mechanism. Because the step runs automatically for every
processed listing (not just approved ones — see Non-goals), cost is
incurred whether or not a listing is ultimately approved; this was an
explicit, informed tradeoff (see Consequences) in favor of a
reviewer-never-waits pipeline.

## Consequences

- Every processed listing incurs one image-generation cost, including
  listings that are later rejected or abandoned before review. This is the
  direct tradeoff for "reviewer never waits" — accepted, not a gap.
- The label-preservation mitigation (mask-based edit) is unproven until the
  Task 1 spike runs against real photos. This spec's viability rests on
  that spike succeeding; a failed spike is a stop condition, not something
  to patch around.
- Two new asset "kinds" exist per listing going forward (raw upload, cutout)
  plus a third at approval time (flattened final) — asset-model changes
  needed, detailed in the implementation plan.
- Brand background is a single global-per-workspace setting; there is no
  path in this design for a workspace wanting several brand background
  options. Acceptable for the Opak Cellar pilot; revisit if a second
  workspace needs more.

## Follow-ups

- Step 5: business rule engine (price tiering, SKU generation, category
  mapping) — separate spec.
- Confirming Step 1's extraction quality against the simplified
  wine-name + photo + optional-price intake shape — separate spec.
- Step 7: whether output must genuinely be XLSX vs. reusing the existing
  CSV-with-images delivery path — separate spec, likely small once this and
  Step 5 land.
- If pipeline-wide generation cost proves too high for rejected/abandoned
  listings in practice, revisit the "automatic during processing" trigger
  decision from this spec.

## Open questions

- Exact asset-record schema for distinguishing raw upload / cutout /
  flattened-final (field name, whether a new table or a column on the
  existing assets table) — implementation plan detail, not blocking design
  approval.
- Exact workspace-settings storage location for the brand background color
  — implementation plan detail.
