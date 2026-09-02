# Package C — Public Entry and Auth Layout — Design

**Date:** 2026-09-02
**Status:** Approved (brainstorming), pending implementation plan
**Parent plan:** `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` — Package C (§16). Dependency graph: `A → B → {C, D}`. Package B is merged into `main` (PR #60); Package D is open as PR #61. This package depends only on Package B, so it can proceed independently of D.

## 1. What this builds

`/`, `/signin`, `/register`, `/register/set-password`, `/forgot-password`, `/reset-password` adopt the Site's two-panel visual layout and bilingual copy, with zero change to any existing authentication behavior — same Better Auth flows, same API routes, same server-side eligibility/enumeration-safety, same redirect-allowlisting. One small, genuinely new capability is added: a proactive invalid/expired-link state for the two token-based pages, grounded in a real mechanism Better Auth already provides but the runtime doesn't currently read (§4). The CSRF/secure-cookie question the master plan flagged as unresolved (G10) is closed by direct verification of the installed Better Auth 1.5.5 source, not by adding new configuration (§5).

Two things confirmed by direct inspection materially shaped this design:

- **`apps/web/components/auth-form.tsx` and all 5 auth page files are 100% English today, with zero zh-Hant text anywhere** — the master plan's own audit flagged this as `[Unverified in this audit]`; it is now confirmed a real gap, not an assumption. Every page also independently hard-codes "Opak Cellar" (a third instance of the ADR-6 hardcode pattern already fixed once in Package B's shell and once in Package D's dashboard).
- **The reference Site's "anonymous demo workspace" link and "remember this device" checkbox are decorative-only** (the Site's own disclaimer confirms the demo link creates no real session). Building either for real would be new, unreviewed security-relevant capability — an unauthenticated dashboard entry point and a session-lifetime toggle — with no basis in the master plan's actual requirements. Both are dropped entirely, not adopted.

## 2. Shared two-panel layout

A new shared layout component wraps all 5 auth pages, replacing today's single `signin-shell`/`signin-card` structure (currently duplicated near-identically across all 5 page files). Two panels, matching the Site's confirmed structure (browsed directly, both locales, desktop 1280px and mobile 375px):

- **Left — brand panel.** Dark navy background (Package B's existing `--navy`/shell tokens). Contents: logo mark + "Wukong / Catalog Operations OS" wordmark, a 繁中/EN locale toggle (reusing Package B's `resolveLocale`/locale-cookie infrastructure — this works pre-auth since it's a browser cookie with no workspace/session dependency), a short tagline and description, 3 stat tiles ("71 SHOPLINE 範本欄位 / SHOPLINE template fields", "8 可修改內容欄位 / editable content fields", "0 直接 SHOPLINE 寫入 / direct SHOPLINE writes"), and the 4-item "存取原則 / Access principles" list (invite-only accounts, backend-enforced roles, mandatory human approval, disabled direct-write in production). The 3 stat tiles and the access-principles list are fixed facts about the product's own contract shape (the real 71-column Bulk Update contract, the real 8 reviewable fields, the real fact that direct SHOPLINE writes stay disabled pending UAT) — not Opak-specific data, so surfacing them here doesn't conflict with ADR-6's no-hardcoded-tenant-copy rule. All `/pilot`-linked copy ("了解試點範圍", "返回試點介紹", "了解 Wukong") is omitted entirely — `/pilot` is blocked pending an out-of-scope ownership decision (ADR-5), and nothing here should link to a route that doesn't exist. On viewports under ~1024px, this panel collapses to a slim header bar (logo + locale toggle only), matching the Site's confirmed mobile behavior — the tagline/stats/principles content simply doesn't render below that breakpoint.
- **Right — card panel.** Off-white background, containing the actual `AuthForm` for that page's mode, restyled with Package B's tokens (`--radius-card`, existing color custom properties) in place of today's ad hoc `signin-card` styling.

No demo-access link, no remember-device checkbox (§1).

## 3. Per-page content

Each of the 5 pages keeps its exact current props/behavior passed into `AuthForm` — no change to `mode`, `callbackUrl`, or `token` handling, no change to any of the 5 API routes it calls. Only the wrapping markup (new shared layout instead of `signin-shell`/`signin-card`) and the copy change:

- `auth-form.tsx`'s `modeCopy()` function and all static English strings (labels, buttons, status messages, `aria-label`s) gain zh-Hant equivalents, selected via the same locale mechanism as §2's toggle.
- Every page's hard-coded `aria-label="Opak Cellar ..."` and `<p className="eyebrow">Wukong / Opak Cellar</p>` are replaced with locale-aware, non-hardcoded copy (the brand wordmark itself, "Wukong / Catalog Operations OS", is product branding rather than tenant-specific, so it does not need to become workspace-derived the way Package D's dashboard header did — but the literal "Opak Cellar" substring is removed).
- Root `/` (`apps/web/app/page.tsx`) is unchanged — confirmed already correct (a redirect only, no rendered content, per the master plan's own parity matrix).

## 4. Invalid/expired-token state

**Mechanism, confirmed by reading the installed `better-auth@1.5.5` source directly** (`dist/api/routes/password.mjs`, `apps/web/lib/auth-flow.ts`'s `requestEnrollment`): both the invite flow (`/register` → `/register/set-password`) and the forgot-password flow (`/forgot-password` → `/reset-password`) go through the identical Better Auth reset-password-token mechanism — `requestEnrollment` internally calls Better Auth's own `POST /api/auth/request-password-reset`, and both completion pages submit to the same `POST /api/auth/reset-password`. Critically, the email link in both flows points at Better Auth's own `GET /api/auth/reset-password/:token`, which **already validates the token server-side before the user ever reaches our page**: if the token is missing, unknown, or expired, it redirects to our `callbackURL` with `?error=INVALID_TOKEN` (no `token` param); if valid, it redirects with `?token=<value>`.

Today, `apps/web/app/register/set-password/page.tsx` and `apps/web/app/reset-password/page.tsx` both read `token`/`callbackUrl` from the query string but **completely ignore `error`** — so an expired-link visit currently renders the full password-entry form anyway, and the user only discovers the problem after filling it out and submitting (`AuthForm`'s generic `GENERIC_ERROR` message).

**Fix:** both pages read the query string at render time and, when there's no usable `token` (whether because `error=INVALID_TOKEN` is present or `token` is simply absent), render a distinct "this link has expired — request a new one" state (linking to `/forgot-password` or back to the invite-request flow, as appropriate per page) instead of passing an empty token into `AuthForm`. This requires no new server-side validation logic — Better Auth already performed the check; the runtime just wasn't reading its result.

## 5. CSRF/secure-cookie (G10) — resolved by verification, not new config

Read directly from the installed `better-auth@1.5.5` package (`dist/cookies/index.mjs`, `dist/context/helpers.mjs`), not assumed from documentation:

- Cookies are always `httpOnly: true`.
- `sameSite` defaults to `"lax"`.
- `secure` auto-resolves to `true` whenever the computed `baseURL` is `https://` (true in production and Vercel preview deployments, since `auth.ts`'s `requiredAuthEnv()` derives `baseUrl` from `BETTER_AUTH_URL` / `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`) and `false` for local `http://localhost` dev — correct in both cases without configuration.
- `trustedOrigins` (the CSRF-relevant origin-check the auth middleware enforces on mutating requests) defaults to exactly the app's own computed `baseURL` origin, recomputed per-deployment — not wildcarded, no cross-origin trust unless explicitly configured. Since Vercel sets a unique `VERCEL_URL` per deployment (including previews), this stays correctly scoped per-deployment automatically.

For this app's actual shape (single Vercel origin per deployment, no subdomains, no OAuth/dynamic-origin requirement), these defaults are already correct. **Resolution:** document these verified findings directly in this spec (satisfying the master plan's "must be confirmed, not assumed" bar for G10) plus a one-line comment in `apps/web/auth.ts` noting they were verified for this deployment shape — no `trustedOrigins`/cookie-attribute override is added, since none closes an actual gap.

## 6. Testing

- Existing `apps/web/auth.test.ts`, `apps/web/lib/auth-flow.test.ts`, `apps/web/app/api/auth/flow-routes.test.ts` must stay green untouched — no behavioral change to any reused mechanism.
- New: a rendering test per token-based page (`/register/set-password`, `/reset-password`) asserting the invalid-link state renders when `error=INVALID_TOKEN` is present, when `token` is absent entirely, and that the normal form still renders when a `token` is present.
- New: a locale-toggle test on the shared auth layout component (switching 繁中/EN updates the rendered copy, matching Package B's own locale-persistence test pattern).
- New: a mobile-breakpoint rendering check confirming the brand panel's marketing content (stats/principles) doesn't render below the collapse breakpoint, only the slim header remains.

## 7. Explicitly out of scope

- `/pilot` — blocked pending an ownership decision outside this plan (ADR-5); no route is built, no link points at it.
- Anonymous demo workspace access — decorative-only in the Site, would be a new unauthenticated capability with no basis in this plan's requirements.
- "Remember this device" checkbox — no real Better Auth mechanism to back it without expanding scope beyond visual-layer-only; omitted.
- Any change to Better Auth configuration itself (session lifetime, `trustedOrigins`, cookie attributes) — §5 resolves G10 by documentation, not code change.
- Any change to `/dashboard`, `/catalog`, `/queue`, or any other authenticated route.

## 8. Self-review

- **Placeholder scan:** none — every file, mechanism, and copy source named above is concrete and directly verified (installed package source, live Site browse, current runtime file reads), not a TBD.
- **Internal consistency:** §1's "drop demo-access and remember-device" decision is referenced consistently in §2 and §7; §4's invalid-token fix is described identically in both its problem statement and its resolution, with the same two pages named throughout.
- **Scope check:** one cohesive deliverable (shared layout + copy adoption across 5 related pages) plus two small, well-grounded additions (invalid-token state, G10 documentation) — comparable in shape to this session's other M-sized packages.
- **Ambiguity check:** every point that had more than one reasonable resolution (two-panel vs. single-panel layout, pilot-link handling, remember-device checkbox, G10 resolution, invalid-token state) was resolved explicitly with the user before this document was written, with reasoning recorded in §1–§5 rather than left implicit.
