# Catalog Enrichment Batches Design

**Date:** 2026-08-16
**Status:** Approved for implementation planning; source implementation has not started.

## Context

The catalog import slice creates one listing draft per product on a merchant's
existing SHOPLINE catalog, and deliberately stops there. `bulk-form-import.ts`
says why:

> Deliberately does not enqueue the AI pipeline. The normal intake path enqueues
> one job per draft, which for a 500-product catalog would be 500 uncapped AI
> runs. Enrichment is a separate, budgeted batch.

This is that batch. It is what turns 500 imported drafts into reviewable
listings, and it is the first place Wukong spends real money proportional to
catalog size rather than to operator actions.

The pilot's numbers say what enrichment is worth: 499/500 products have a
Traditional Chinese name byte-identical to the English one, 489/500 have no
description, 478/500 have keywords that merely repeat the product name. Those
figures come from the `gaps` block the parser already computes per row, so the
cohort for a batch is a query, not a judgement call.

The domain term **catalog enrichment batch** is recorded in `CONTEXT.md`.

## The central finding: no new pipeline is needed

`apps/worker/src/listing-pipeline.ts:361` calls the AI provider like this:

```ts
extraction = await deps.ai.extract({
  assets: await deps.assetInputs(source.assets),
  note: draft.note,
});
```

An imported draft has **zero source assets**. If its `note` carries the
product's own text, the existing pipeline runs end to end with no modification:
`extract` derives facts with per-field evidence attributed to `NOTE_SOURCE_ID`,
`generate` produces a `CanonicalListing`, compliance scans it, a version is
appended, and the draft lands in `in_review` — the same state, the same review
UI, the same audit trail as a photo-intake listing.

That collapses this slice from "build a second pipeline" to three things:

1. render a bulk-form row as text the existing `extract` step can read;
2. choose a cohort and record a budget for it;
3. release work to the existing queue in waves, stopping when the budget is
   spent.

Everything else — leases, idempotency, step caching, AI-run cost capture,
compliance, review, audit — already exists and is reused unchanged.

### Why not a narrower "enrich only the 8 writable columns" step

The bulk form only lets Wukong write eight content columns, so a narrower AI
task returning exactly those fields looks appealing. Rejected, for two reasons:

- `listing_versions.content` is a `CanonicalListing`. A narrower artifact has
  nowhere to live without a schema change, and it would bypass compliance
  scanning and the review UI, which both operate on versions.
- The canonical schema requires `producer`, `country`, `volumeMl`, and
  `abvPercent`, none of which the bulk form states. A narrow step would dodge
  that problem; `extract` **solves** it, deriving them from the product name
  with evidence and marking what it could not find in `missingFields`. That is
  what the extract/generate split is for, and skipping it would trade an
  anti-hallucination guarantee for a shortcut.

## Goals

- Enrich imported drafts through the existing listing pipeline, unchanged.
- Never spend more than an operator-approved budget on a batch.
- Make the cohort a query over data the parser already computes, so an operator
  chooses a _category_ of gap rather than picking products by hand.
- Survive interruption: a batch that stops halfway can be resumed, and a
  re-delivered queue message must not double-charge.
- Keep every AI dollar attributable to a batch, a workspace, and a product.

## Non-goals

- No changes to `listing-pipeline.ts`, the AI provider contract, or the prompts.
- No automatic scheduling. A batch advances when an operator advances it; cron
  and durable orchestration are a later concern, and the pilot's enrichment is
  an attended operation.
- No new review UI. Enriched drafts appear in the existing queue.
- No writing back to SHOPLINE. That is the exporter slice.
- No per-product cost prediction. Budget is enforced on _observed_ spend.

## Chosen design

### Rendering a row as an extraction source

`packages/shopline/src/bulk-form-source.ts` turns a parsed row into a plain-text
document. It is pure, dependency-free, and lives beside the parser because it is
part of reading the form, not part of the worker.

The rendering carries only what the form _states_ — name, categories, pricing,
promotion labels, supplier, barcode — as labelled lines. It never editorialises,
because every line becomes potential evidence that `extract` may quote. The
existing `fixtures/opak/supplier-sheet.txt` is the precedent for a text source.

Two rules matter:

- **The enrichable columns are excluded from the rendering.** The Chinese name,
  the SEO fields, and the summary are the fields being _generated_; feeding a
  placeholder Chinese name (which for 499/500 pilot rows is just the English
  name) back in as a source would invite the model to reproduce it.
- **Cost data is excluded.** `Product Cost` is the merchant's wholesale price.
  It has no bearing on customer-facing copy and must not reach a prompt.

### Where the source text lives

The importer already writes a `note` on each draft, currently only provenance. It
will write the rendered document instead, with a provenance line kept first.

The provenance line deliberately omits the form spec version. The version string
contains a four-digit year (`opak-2026-05`), and extraction reads the first
year-shaped token in the note as the product vintage — including it made every
imported product a 2026 vintage. The version is already recorded on
`platform_products` and in the import audit event, so the note does not carry it.
This is the general hazard of the design restated: everything in the note is
evidence, so anything in the note that merely _looks_ like a fact will be read as
one.

A note written at first import would go stale once a re-import refreshed the
row, and enrichment would then run against data the merchant has already
changed. The refresh happens **in the importer, not the orchestrator**: the
import path already detects a changed digest and already writes an audit event
for it, so it is the one place that knows both that the row changed and what it
changed to. Refreshing the note is part of that same mutation.

Putting the refresh in the orchestrator was considered and rejected — it would
have to re-read `platform_products` by listing ID and re-render for every draft
in every wave, repeating work the importer already did once, and it would make
advancing a batch mutate draft content as a side effect.

### Batch records

Two tables, following the established tenant pattern — `workspace_id`, a
`(workspace_id, id)` unique index, composite FKs, RLS policy, `wukong_app`
grants.

`enrichment_batches`
: workspace, a human label, `budget_usd`, `wave_size`, `status`
(`open` → `running` → `completed` | `budget_exhausted` | `cancelled`), and
`created_by`. Budget is stored in USD to match `ai_runs.estimated_cost_usd`.

`enrichment_batch_items`
: batch, listing draft, `status` (`pending` → `queued` → `succeeded` |
`failed` | `skipped`), and the queue idempotency key that was used. One row per
draft, unique on `(workspace_id, batch_id, listing_id)`, so a draft cannot be
enqueued twice within a batch.

Both link to `listing_drafts` with `ON DELETE RESTRICT`, matching
`platform_products`: a batch is a spending record, and deleting a draft must not
quietly erase evidence of what was spent on it.

### Budget accounting is observed, not predicted

Spend is not estimated ahead of time. `ai_runs` already records
`estimated_cost_usd` per run with a `listing_id`, so the amount a batch has
spent is a sum over the runs belonging to its items. A new repository method
returns that sum; the batch table holds no running total to drift out of sync
with the runs.

Advancing a batch:

1. Sum observed spend across the batch's items.
2. If spend ≥ budget, mark the batch `budget_exhausted` and enqueue nothing.
3. Otherwise take the next `wave_size` `pending` items, mark them `queued`, and
   enqueue one existing `listingJobSchema` message each.
4. When no `pending` items remain and none are `queued`, the batch is
   `completed`.

The budget is therefore a **stop condition between waves, not a hard ceiling
within one**. A wave already in flight can overshoot by at most the cost of that
wave. That is a deliberate trade: enforcing a strict ceiling would require the
pipeline to consult a budget mid-run, coupling the generic listing pipeline to
this feature. `wave_size` bounds the overshoot, and the runbook tells operators
to size it accordingly.

### Idempotency

The existing pipeline is already idempotent per
`listing:<workspace>:<draft>:<sequence>`; a re-delivered message resolves to the
cached step output and charges nothing further. The batch layer adds only the
item-level guard: an item moves `pending → queued` in the same transaction that
enqueues it, and the unique constraint prevents a second item for the same
draft. Re-advancing a batch therefore never re-enqueues work already in flight.

### Failure handling

A pipeline failure marks the draft failed through the existing path. The batch
item is marked `failed` by the same advance operation that observes it, so a
failed product does not block the rest of the batch and does not silently retry.
Re-running failures is a new batch over the failed cohort — explicit, and
separately budgeted.

## Consequences

- The first real spend proportional to catalog size is bounded by a number an
  operator typed, and every dollar is attributable to a batch, a product, and a
  run.
- Imported drafts become ordinary reviewable listings, so the bulk review work
  (roadmap 1c) and the exporter (1d) both have something real to operate on.
- The listing pipeline stays generic. Nothing about batching, budgets, or the
  bulk form leaks into it.

## Follow-ups

1. Bulk review UX for the resulting queue (roadmap 1c) — batch-approve low-risk
   field classes, per-item review for claims-bearing copy.
2. Exporter delivery of approved enrichment back to SHOPLINE (roadmap 1d).
3. Automatic advance on wave completion, replacing operator-triggered advance.
4. Prompt tuning for catalog-derived sources; the current prompts were written
   for photo and supplier-sheet intake.

## Open questions

1. What budget does the pilot actually approve for the first 500-product run?
   The design enforces whatever number is given; it does not choose one.
2. Should a product whose `extract` reports many `missingFields` be enriched at
   all, or held back? Currently everything in the cohort is attempted, and the
   review step is where thin results get caught.
3. `wave_size` bounds budget overshoot but also throughput. The right default is
   an operational question the first real batch should answer.
