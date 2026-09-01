# Package B — Shared Tokens, Shell, i18n — Design

**Date:** 2026-09-01
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package B (§16). Dependency graph: `A → B → {C, D}` — this is the first package after the already-complete baseline (Package A) and the only one the dependency graph currently unblocks; Packages C and D can run in parallel once this lands.

## 1. What this builds

The authenticated shell (`apps/web/app/(app)/layout.tsx`) adopts the reference Site's confirmed navigation structure, design tokens, and locale-persistence mechanism, with zero behavior change to any existing route's actual functionality — this package touches chrome, not domain logic.

Research for this design combined the master plan's own audit findings with direct verification against the live reference Site (`https://wukong-catalog-ops.laichiwillyjp.chatgpt.site`, source `https://github.com/YNWAforever/wukonggpt`) and the current runtime's actual `globals.css`/`layout.tsx`, since several of the master plan's paraphrased findings turned out to need correction once checked directly — most notably, the Site uses a full left-sidebar shell (not a topbar), and its locale toggle does a genuine single-locale switch (not a relabel), neither of which the master plan's prose made fully explicit.

## 2. Design tokens

`apps/web/app/globals.css`'s `:root` block already has tokens matching 5 of the Site's 6 confirmed colors by exact value, under different names:

| Site's name (master plan) | Site's value          | Runtime's existing name    | Runtime's existing value | Match?               |
| ------------------------- | --------------------- | -------------------------- | ------------------------ | -------------------- |
| `--canvas`                | `#f6f4ef`             | `--stone`                  | `#f6f4ef`                | ✅ identical         |
| `--text`                  | `#182432`             | `--ink`                    | `#182432`                | ✅ identical         |
| `--border`                | `#dfe2e1`             | `--line`                   | `#dfe2e1`                | ✅ identical         |
| `--navy`                  | `#17324d`             | `--navy`                   | `#17324d`                | ✅ identical         |
| CTA / hover               | `#b36a24` / `#8d4e17` | `--amber` / `--amber-dark` | `#b36a24` / `#8d4e17`    | ✅ identical         |
| `--muted`                 | `#5f6e7b`             | `--muted`                  | `#7b8790`                | ❌ genuinely differs |

**Decision:** keep the runtime's existing token names — renaming five already-correct tokens across every usage site in the codebase would be a large, purely cosmetic diff with zero behavioral or visual effect. Only two real changes are needed:

1. Fix `--muted`'s value to `#5f6e7b`. Cross-confirmed twice: the master plan's own live-crawl research, and directly reading the Site's rendered inactive-nav-item text color (`rgb(95, 110, 123)` = `#5f6e7b`) via its computed styles.
2. Add `--radius-card: 16px` (the confirmed card-corner radius) as a new, separate token — the runtime's existing `--radius: 12px` serves a different, already-in-use purpose and stays unchanged.

One more token is needed that neither the master plan's prose nor the runtime currently has: the active-nav-item highlight. Directly inspected on the Site (`getComputedStyle` on the current-page nav link): background `rgb(237, 243, 247)` = `#edf3f7`, text color `rgb(23, 50, 77)` = `--navy` (already exists). New token: `--nav-active-bg: #edf3f7`. This resolves what the master plan's prose called the "active-accent" member of a "CTA/hover/active-accent trio" — direct inspection confirms it is the active-nav highlight, not a third button-interaction color; no third button color exists beyond CTA/hover.

## 3. Shell structure — full sidebar adoption

Directly verified against the live Site at both viewports (accessibility-tree read, not just visual inspection):

**Desktop (≥`lg`):** a left sidebar (`aria-label="主要導覽"`) with exactly 7 items, in this order: Overview (`/dashboard`), Catalog (`/catalog`), Work Queue (`/queue`), Bulk Update (`/listings/new`), Enrichment Batches (`/batches`), Jobs (`/jobs`), AI Quality (`/quality`). Below a divider, a separately-positioned Admin link (`/admin`, admin-gated). Critically, **`/system-map` is not in the sidebar at all** — it lives as a topbar utility link (alongside the locale toggle, search, and help), always visible regardless of role. The runtime's current flat topbar `<nav>` folds `/system-map` in with everything else; this package separates it into the topbar, matching the Site.

**Mobile (<`lg`):** the sidebar collapses (present in the DOM, hidden until opened — confirmed via accessibility-tree read at 375px showing identical nav content, just visually hidden). A fixed bottom-nav bar shows the first 4 items only (Overview/Catalog/Queue/Bulk Update — confirmed via the Site's own `流動版主要導覽` mobile-nav landmark). A hamburger button (`開啟導覽`) opens a drawer revealing the full 7-item nav plus Admin. Build the drawer with focus-trap and focus-restoration from the start (per the master plan's own explicit instruction, §14) — not as a later retrofit.

Role-aware visibility reuses the existing `roleOrder`/`requireWorkspaceRole` mechanism already gating `/admin` in the current `layout.tsx` — no new visibility system.

**Nav-completeness sequencing:** `/queue` does not exist yet — it's Package D's deliverable, not Package B's. Following this session's own established pattern (every prior package added its own nav link only once its route was real — jobs, system-map, quality, capabilities all landed this way), Package B's sidebar and bottom-nav **omit** the Work Queue item entirely. Package D adds it when `/queue` ships. No interim dead link, no placeholder route.

## 4. Locale persistence — shell only (ADR-4)

A cookie-backed locale preference (`zh-HK` default; only two valid values accepted, rejecting anything else to avoid any injection surface per ADR-4's own security note), read server-side on every request so `html lang` and the first paint are correct with no flash of the wrong locale. A real `繁中`/`EN` toggle group in the topbar, matching the Site's own control.

**Scope decision, made explicit because it materially changes the size of this package:** clicking the Site's toggle was directly tested and replaces _all_ visible text on the page — a genuine single-locale switch, not a relabel. The runtime's existing convention, built consistently across every package this session, shows both languages simultaneously everywhere (`商品中心 <span>Catalog</span>`). Retrofitting that convention into real single-locale rendering across every existing page (dashboard, catalog, listings, batches, jobs, quality, admin — components spanning nearly this entire session's output) is a much larger, cross-cutting effort that Package B's own file list (`globals.css`, `layout.tsx`, a locale utility, workspace-label reads) does not include.

Package B implements the real mechanism and applies it to **the shell only** — nav labels, footer, topbar chrome genuinely switch language on toggle. Every other page's content keeps today's dual-language convention unchanged. This is not a compromise on correctness: the mechanism (cookie, provider, `html lang`) is fully real and reusable; a future package can extend single-locale rendering to page content using the same provider without rework here.

## 5. Workspace-derived labels (ADR-6)

`layout.tsx` currently hard-codes "Opak Cellar" twice (`brand-context` span, footer) and "Opak operator" once (`operator-name` span) — confirmed by direct reading of the current file. Per ADR-6, read these from `workspaces.profile` (existing jsonb column, no migration) instead. `workspaces.profile` gains whatever shape is needed to carry a display name and default operator-role label; exact field names are an implementation-plan decision, not a design-level one, since no existing profile-shape precedent constrains it.

## 6. Formatting utilities

Confirmed via repo-wide grep: exactly one ad-hoc `Intl.DateTimeFormat("zh-HK", ...)` call exists (`dashboard-listings-client.tsx`), no shared utility module, and zero currency formatting anywhere in the codebase. New `apps/web/lib/formatting.ts` exporting `formatHkd(amountHkd: number): string` and `formatHkTimestamp(date: Date): string`, both using `Intl.NumberFormat`/`Intl.DateTimeFormat` pinned to `zh-HK`/`Asia/Hong_Kong` (not browser-detected — this is a single-market pilot with one timezone/currency, per the master plan's own framing).

## 7. Testing

- `locale-cookie.test.ts`: valid values persist and round-trip; an invalid/malformed cookie value falls back to the `zh-HK` default rather than throwing or passing through unsanitized.
- A shell render test asserting: correct nav item count/hrefs/labels for an admin vs. non-admin session, `/queue` genuinely absent, `/system-map` genuinely absent from the sidebar (present in the topbar instead).
- A focus-trap test for the mobile drawer: opening it moves focus inside, `Escape`/close returns focus to the trigger, `Tab` cannot escape the drawer while open.
- `formatting.test.ts`: `formatHkd`/`formatHkTimestamp` against known inputs, including edge cases (zero, large numbers, a `Date` crossing a DST-irrelevant HK timezone boundary — HK doesn't observe DST, so this mainly needs a sanity check the timezone is pinned correctly, not literal DST-transition coverage).
- Visual-regression capture of the shell: 2 viewports × 2 locales = 4 captures, admin and non-admin nav variants where they visibly differ.

## 8. Explicitly out of scope

- Full per-page locale retrofit (§4) — a separate, much larger future effort.
- `/queue`'s actual page content and data wiring — Package D.
- Skip-link audit — already present in the current `layout.tsx` (`<a className="skip-link" href="#main-content">`, confirmed by direct read); Package J's own accessibility pass can verify it still works correctly post-restructure, but this package doesn't need to build one from scratch.
- Formal contrast-ratio measurement and touch-target sizing — Package J, per the master plan's own assignment (§14).
- Any change to `/signin`/`/register*`/auth-page layout — Package C.

## 9. Self-review

- **Placeholder scan:** none — every token value, nav item, href, and file target named above is a confirmed real value (either from direct codebase reads or direct Site inspection), not a TBD.
- **Internal consistency:** §4's shell-only locale scope is stated once and every other section respects it — §3's shell nav labels and §5's workspace labels are both described as switching with locale; no section quietly assumes page-content localization.
- **Scope check:** five cohesive deliverables (tokens, shell restructure, locale mechanism, workspace labels, formatting utilities) all touching the same small file set (`globals.css`, `layout.tsx`, two new lib files) — comparable in size to this session's other M-sized packages (`/jobs` ledger, capability registry), not requiring further decomposition.
- **Ambiguity check:** "rename tokens or keep names" resolved explicitly (keep, with reasoning); "how far does locale switching reach" resolved explicitly (shell only, with reasoning and an explicit non-goal); "does Package B include the `/queue` nav link" resolved explicitly (no, deferred to Package D, matching established precedent).
