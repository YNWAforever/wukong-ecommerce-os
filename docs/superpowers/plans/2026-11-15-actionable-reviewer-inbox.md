# Actionable reviewer inbox — approved three-PR plan

Approved 2026-11-15. Base: main `3cbe90b7b14226a5caba5371556dc63ee3cd44d5` (website recovery PR #226, exact production and main CI verified).

## Outcome

Inbox → exact proposal → explicit review decision → recorded completion. Reuse existing Studio inbox, outputs, immutable versions, review controls and audit. Reads, navigation and reload never call a model or change canonical listings.

## PR 1 — exact-version artifact detail

- Add `/studio/outputs/[id]?revision=N&digest=SHA256` using the existing output card and role gates.
- Optional strict paired `revision`/`digest` on output GET. Preserve unqueried behavior. Pinned reads fetch only the requested version and current output metadata, verify stored payload/digest, and compute freshness for the selected content.
- Malformed pins: 400; absent/foreign artifact or version: 404; mismatched digest: 409. Never substitute latest content. Valid historical versions remain readable with a read-only notice; current metadata is labelled separately.
- Reuse current audited save/sign-off endpoints and expected revision/digest fences. Disable actions on historical, stale, unavailable or unverifiable content. Preserve viewer/operator/reviewer permissions and artifact visibility. Sign-off does not approve/apply/publish the listing.
- No schema or prompt change. Tests cover pin mismatch, missing versions, role/privacy, version changes, identity changes during reads and compatibility of old callers.

### PR 1 implementation record

The candidate adds paired pinned GET validation, a single-version scoped read with digest verification, a server-rendered canonical detail URL, optional pinned/seeded card mode, historical read-only controls and explicit viewer save gating. Old unqueried API and card callers remain compatible. Local baseline: 34 output/card checks. Candidate verification: 778 Studio checks across 75 suites, 28 CI contract checks, full web types, strict browser-spec types and seed syntax passed. The browser fixture now contains a separate immutable two-version artifact; acceptance checks owner history/reload/stale rejection and viewer current-version controls without model sends or canonical changes. Shipped as PR #227, head `345522a2d466a0957c1d84e3b6128e68608688fe`, merge `e878f569e6b5be9103f72914ffd51773087b51fc`. PR CI 43681641170 and main CI 43683258181 passed (including real browser/PostgreSQL/audit/build gates). Production `dpl_EzwbZN3Ni1pS1qk9qY37ztoxt6XF` was READY/production at the exact merge; alias and unauthenticated sign-in/Studio/settings/pinned-output probes passed. The retained English 390px historical screenshot shows cramped table columns; PR 3 will improve that layout.

## PR 2 — actionable bounded inbox

- Link pending artifacts directly to exact revision/digest detail, including recorded status, kind/title and update time.
- Filter before limiting: read at most 11 drafts and 11 saved artifacts, merge draft-first, display at most 10 and show honest truncation. Reuse filtered output pages for View all.
- Batch current-version digest/confirmation metadata; do not load every payload or fan out freshness checks across the inbox. Detail and mutations perform freshness checks.
- Keep recorded status distinct from verified confirmation; legacy/missing/unavailable metadata cannot claim completed review. Inbox remains read-only.
- Reuse existing tables; scope every read through the resolved server workspace and existing visibility rules.

### PR 2 implementation record

The candidate uses one SQL snapshot: separate status-filtered candidate windows (11 drafts + 11 saved), current-version digest joins and matching audit confirmation via EXISTS. It returns no version payload/scope, excludes completed history before LIMIT and preserves workspace predicates on every join. The builder displays 10, reports truncation, provides exact links only with valid pins and keeps missing/legacy confirmation explicit. Artifact-link prefetch is disabled so viewing the inbox cannot load detail payloads in the background. Filtered View all links reuse existing outputs pages. Local DB build, web/browser-spec types and 781 Studio checks passed; two additional disposable PostgreSQL cases and the authenticated inbox-to-exact-version browser check gate CI.

## PR 3 — reviewer acceptance and release evidence

- English/Traditional Chinese guidance, keyboard focus, 390px layouts, honest loading/error/empty states and read-only return-to-inbox refresh.
- Authenticated fake-provider browser: inbox → pinned artifact → explicit save/sign-off → updated inbox/reload. Test stale/new versions, changed listing/quality, legacy confirmation, missing/tampered pins, roles, foreign workspace and duplicate confirmation.
- Assert zero model calls on reads/reloads, no duplicate confirmation audit, no canonical listing changes. Install CJK fonts for legible CI screenshot evidence.
- Update roadmap status and release evidence.

## Release and operating boundaries

Each PR: relevant unit/type and disposable PostgreSQL/RLS checks, authenticated browser acceptance, format/forbidden-runtime gates, production build and audit verification (zero missing actions / zero accessible foreign records). Merge exact green heads; verify exact production metadata/alias/routes and post-merge main CI.

Frozen provider OpenCode Go / deepseek-v4.1-flash, USD10 cumulative workspace cap, USD2 run ceiling, 4096 output tokens. Fake-only development acceptance. No new paid calls, production workspace activation, external MCP or SHOPLINE write activation. No migrations, scheduling, assignments, notifications, multi-listing execution or new connector. Later product decision: bounded manual multi-listing review versus a first read-only business connector.
