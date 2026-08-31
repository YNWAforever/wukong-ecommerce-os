# Package I (continued) — Capability Registry, `/system-map`, `/admin` System-Truth Tab — Design

**Date:** 2026-09-01
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package I (§16), §9 ADR-11. Second slice of Package I, following the `/jobs` ledger (first slice, complete on `claude/jobs-ledger`). `/quality` remains deferred to its own future spec — its own dependency note requires verifying that honest edit-distance data actually exists before design work starts on it.

## 1. What this builds

Per ADR-11: `/admin`'s proposed 4th tab and a new `/system-map` page both need a single, shared source of truth for capability maturity (Live/Pilot/Planned/Blocked), rather than two independently-maintained claims that can drift apart — or worse, an untrustworthy self-report the way the Site's own `/system-map` was found to be (§5 of the master plan explicitly distrusts it). This package builds that one shared registry and its two read-only consumers.

## 2. The registry — a static, hand-maintained module, not a live check

`apps/web/lib/capability-registry.ts` exports a plain typed constant array, styled after `packages/shopline/src/bulk-form.ts`'s `BULK_FORM_COLUMNS` (the closest existing precedent in this codebase for a hand-written, doc-commented, canonical constant list consumed by multiple call sites):

```ts
export type CapabilityState = "live" | "pilot" | "planned" | "blocked";

export type CapabilityEntry = {
  id: string;
  label: string;
  description: string;
  state: CapabilityState;
};

export const CAPABILITY_REGISTRY: readonly CapabilityEntry[] = [ ... ];
```

**Why not a live env-var check:** the most safety-critical entry this registry must carry — real SHOPLINE publishing — is gated by `SHOPLINE_PUBLISH_ENABLED`, which is read *only* in `apps/worker` (a separate Cloudflare Workers deployment). It is never an environment variable in `apps/web`'s Vercel deployment. Making the registry "live" would require introducing a second copy of that flag into Vercel's env purely so `apps/web` could read it — creating exactly the two-sources-of-truth drift risk ADR-11 exists to prevent, and doing so for the one entry where drift matters most. The registry is instead a plain, hand-maintained array, updated in the same PR that changes a capability's real state — which is what the master plan's own text proposes ("a small config table or a typed constant list reviewed alongside code changes"), not a deviation from it.

**Initial entries**, grounded in this session's own research into real gated behavior (not invented):

| id | label | state | grounding |
|---|---|---|---|
| `shopline-real-publish` | SHOPLINE 正式發佈 / Real SHOPLINE publishing | `blocked` | `SHOPLINE_ADAPTER=disabled`, `SHOPLINE_PUBLISH_ENABLED=false` in production (`apps/worker/src/shopline-runtime.ts:59-65`); enabling requires separate written authorization per the production runbook. |
| `ai-listing-generation` | AI 商品資訊生成 / AI-assisted listing generation | `live` | `AI_PROVIDER=openai` in production, real `OpenAIListingProvider`. |
| `bulk-form-import-freshness-gate` | 批次匯入與新鮮度檢查 / Bulk-form import + freshness gate | `live` | Package E, merged to `main` via PR #53. |
| `attended-enrichment-batches` | AI 批次強化 / Attended AI-enrichment batches | `pilot` | Write path (create/advance) already on `main`; list/detail read UI (Package F) built this session, not yet merged. |
| `multi-product-export` | 多商品匯出 / Multi-product export | `pilot` | Package H, built this session, not yet merged. |
| `jobs-ledger` | 作業總覽 / Jobs ledger | `pilot` | This session's own prior slice of Package I, not yet merged. |

Each entry's `description` (omitted from the table above for brevity, written out in full in the actual module) states in one sentence what the state means for an operator reading it — not just the label.

## 3. `/admin`'s 4th tab

Mechanical, consistent extension of the existing 3-tab component:
- `apps/web/components/admin-tabs.tsx`: extend `AdminTab` to `"members" | "connection" | "settings" | "capabilities"`, add one entry to the tab list, one more conditional line in the existing tabpanel chain.
- New `apps/web/components/admin-capability-panel.tsx`: reads `CAPABILITY_REGISTRY` directly (a static import, not a fetch — there's no API route needed since this is build-time-static data, not per-workspace runtime state) and renders one row per entry with a state-colored badge (reusing this session's own `.status-pending`/`.status-running`/`.status-succeeded`/`.status-failed`/`.status-cancelled` classes from the `/jobs` work — needs a mapping from the 4 capability states to those 5 existing visual tones, not new CSS).
- Admin-gated, matching the other 3 tabs and the page's existing `requireWorkspaceRole("admin", ...)` redirect.

## 4. `/system-map`

New page, `apps/web/app/(app)/system-map/page.tsx`, rendering the same registry (likely via the same panel component reused directly, or a very thin wrapper around it — implementation detail for the plan to decide, not a new rendering concept). **Not** admin-gated: per the master plan's own IA (listed as a nav peer alongside `/admin`, not nested under it) and stated purpose ("internal truth-telling," "not on the pilot's critical path," "self-documenting map of what's real vs. planned") — matches `/jobs`/`/catalog`'s open-to-any-authenticated-member pattern, not `/admin`'s admin-only redirect. Nav link added to `apps/web/app/(app)/layout.tsx`, alongside the existing unconditional links (not inside the `isAdmin` conditional).

## 5. Testing

- `capability-registry.test.ts`: the registry array itself is well-formed (unique `id`s, non-empty `label`/`description`, `state` is one of the 4 valid values).
- A **consistency test** — the master plan's own explicit acceptance criterion ("capability-registry consistency test, both surfaces show the same state") — proving `AdminCapabilityPanel` and the `/system-map` page's rendering both derive from the identical `CAPABILITY_REGISTRY` import, not two independently-maintained copies.
- Render tests for `AdminCapabilityPanel` (one row per entry, correct state badge) and the `/system-map` page/component (same, plus confirming no role gate blocks a non-admin viewer).

## 6. Explicitly out of scope this round

- `/quality` — separate future spec, starting with verifying edit-distance data actually exists.
- Any write/mutation from either surface — pure read, matching every other observability surface built this session.
- Dynamic/live capability-state computation — deliberately static, per §2's reasoning.

## 7. Self-review

- **Placeholder scan:** none — the 6 initial registry entries and their states are fully specified above, not left as "TBD."
- **Internal consistency:** §2's "why not live" reasoning is stated once and both consumers (§3, §4) build on it without re-litigating; the consistency test (§5) is the mechanism that actually enforces "no drift" going forward, matching ADR-11's stated concern.
- **Scope check:** one new small module, one component extension (admin tab), one new page + nav link — smaller than every prior package this session except perhaps the `/jobs` ledger's own individual tasks.
- **Ambiguity check:** "does `/system-map` need its own role gate" is resolved explicitly (no); "is the registry live-computed or static" is resolved explicitly (static, with reasoning); "what are the actual initial entries" is resolved explicitly (6, each grounded in a specific file:line or a specific PR from this session), not left for the implementer to invent.
