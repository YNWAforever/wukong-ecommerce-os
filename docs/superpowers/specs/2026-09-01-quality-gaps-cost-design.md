# Package I (continued) — `/quality`: Content Gaps and AI Cost — Design

**Date:** 2026-09-01
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package I (§16). Third and final slice of Package I, following the `/jobs` ledger and the capability-registry/`/system-map`/admin-tab work. Human edit-distance is deliberately deferred to its own future spec, per this round's research — see §1.

## 1. What this builds, and what it deliberately does not

A read-only `/quality` page reporting two honestly-computable things: content gap signals (6 boolean checks per listing — untranslated name, untranslated SEO title, SEO title mirroring the product name, SEO description mirroring the SEO title, keywords mirroring the name, missing summary) and AI enrichment cost. It does **not** build "human edit distance" (how much a reviewer changed the AI's suggestion) — research this round found the master plan's assumed derivation doesn't work: `ai_runs.output` (the column meant to hold the AI's generated field values) is written as `{}` on every real call site, so there is nothing to diff against. A genuinely honest derivation is possible in principle (Package G's edit events point at before/after immutable listing versions, which could be diffed), but the diff algorithm, AI-baseline identification, and several edge cases (multi-pass enrichment, product-shot-only version bumps) are all unbuilt — a real, separate feature, not a small addition. Building it into this page now would mean either inventing a number not backed by real computed data (explicitly forbidden by the master plan) or quietly expanding this package's scope into a second, harder feature. Deferred.

## 2. Gap signals — reusing, not reimplementing, the existing 6 checks

`packages/shopline/src/bulk-form.ts`'s `bulkFormGaps` function already implements the exact 6 checks correctly (confirmed by reading it directly) — the problem isn't its logic, it's what it's fed. Today it's only ever called against `platform_products.rawRow`, a snapshot frozen at the moment of the last SHOPLINE import, never updated after enrichment or human review changes something — and `rawRow` is `null` for every create-origin listing, so those are silently excluded entirely.

This package adds a small adapter, `canonicalListingToGapsInput(content: CanonicalListing): BulkFormGapsInput`, mapping `CanonicalListing`'s real shape onto the same input shape `bulkFormGaps` already expects:

- `title.en` → `nameEn`, `title["zh-Hant"]` → `nameZh`
- `seo.title.en` → `seoTitleEn`, `seo.title["zh-Hant"]` → `seoTitleZh`
- `description.en` → `summaryEn`, `description["zh-Hant"]` → `summaryZh`
- `tags.join(", ")` → `seoKeywords` (mirrors the existing join convention already used elsewhere in this session's SEO-field work)

`bulkFormGaps` itself is called unmodified. This means the same 6 checks now run against each listing's **current active version content**, for **every** listing regardless of origin — both problems the research identified are fixed by feeding the existing, tested function better input, not by reimplementing its logic.

## 3. Cost

`packages/db/src/repositories/ai-runs.ts`'s `sumCostForListings` already aggregates `ai_runs.estimated_cost_usd` — real, provider-reported cost, already used in production for enrichment-batch budget enforcement. This package calls it over the full set of listings the gap-scan already fetched (no separate query needed beyond passing the same id list).

## 4. Read model and page

Mirrors the `/jobs` ledger's established shape exactly:

- `repositories.listings.listRecent(limit)` (already returns each listing's active version `content` — no new repository method needed) feeds a new pure function, `computeQualitySummary(listings, totalCostUsd)`, in `apps/web/lib/quality-summary.ts`, computing: total listings assessed, count with zero gaps ("clean"), count with at least one gap, and a per-gap-signal count (one entry per of the 6 signals, how many listings currently exhibit it).
- `GET /api/quality`: no role gate (matching `/jobs`/`/system-map`'s established open-to-any-authenticated-member pattern — the master plan's own text explicitly bundles `/quality` with those two as "read-only... views," not admin-gated). Fetches listings, computes gaps + cost, returns the summary.
- `/quality` page: 4 stat tiles (total assessed, clean, has-gaps, total AI cost) + a 6-row table (one row per gap signal, its count). Aggregate counts only — no per-listing drill-down list, matching the master plan's own "4 tiles + 6-row table" framing and keeping this round's scope small.

## 5. Testing

- `canonical-listing-gaps.test.ts`: the adapter correctly maps each `CanonicalListing` field onto `BulkFormGapsInput`, and — critically — that feeding it through `bulkFormGaps` produces the expected boolean for each of the 6 signals on realistic fixture content (proving the adapter + reused function combination behaves correctly end to end, not just that the mapping compiles).
- `quality-summary.test.ts`: pure-function tests for `computeQualitySummary` — correct aggregate counts across a mixed fixture set (some clean, some with various gaps), correct cost pass-through.
- `api/quality/route.test.ts`: viewer can read (200), correct response shape.
- Page-level test: skipped, matching the established precedent from `/jobs` and `/system-map` (neither has one; the underlying pure functions carry the real test coverage).

## 6. Explicitly out of scope this round

- Human edit distance — separate future spec, per §1.
- Per-listing drill-down (which specific listings have which gap) — aggregate counts only, per §4.
- Any write/mutation from this page — pure read, matching every other observability surface built this session.
- SQL-level aggregate queries (`COUNT(*) WHERE ...`) — matches the existing codebase convention of fetch-then-filter-in-JS at pilot scale (confirmed via research: no existing aggregate-count query pattern exists yet for this kind of data; `enrichment-batch-service.ts`'s gap-cohort selection uses the identical "fetch up to N, filter in JS" approach).

## 7. Self-review

- **Placeholder scan:** none — the exact field mapping (§2) and the 4 tiles/6 rows (§4) are fully specified, not left as "TBD."
- **Internal consistency:** §1's "why edit-distance is deferred" reasoning is stated once and the rest of the design builds only on what §1 concluded is honestly computable — no section quietly reintroduces edit-distance.
- **Scope check:** one small adapter function, one pure aggregation function, one read endpoint, one page — comparable in size to the `/jobs` ledger's own scope, smaller than the capability-registry work (no new UI component library, reuses `bulkFormGaps` and `sumCostForListings` unmodified).
- **Ambiguity check:** "does this reflect current content or last-import snapshot" is resolved explicitly (current, via the adapter); "are create-origin listings included" is resolved explicitly (yes, unlike the existing batch-gap-detector); "is this a live SQL aggregate or fetch-then-compute" is resolved explicitly (fetch-then-compute, matching existing convention).
