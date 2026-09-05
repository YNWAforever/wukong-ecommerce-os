# Website Catalog Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paste a public storefront URL, preview up to 20 products, and save selected website records into the catalog without a SHOPLINE token.

**Architecture:** Cloudflare Queue work advances durable, workspace-scoped scan steps. Each step calls an authenticated Node endpoint for one bounded public document fetch, using DNS-pinned HTTPS; deterministic parsing yields immutable preview records. Selected records have a separate website identity and a discriminated catalog projection, never fabricated platform bindings.

**Tech Stack:** Node 24, pnpm 11.7, Next.js/React/plain CSS, existing Cloudflare Worker/Queues, Drizzle/Postgres/RLS, Zod, Vitest, Playwright.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-09-06-website-catalog-import-design.md`; user approved written spec on 2026-09-06.
- Worktree: `C:/Users/laich/Documents/WukongEommerce/worktrees/attempt-evidence-packet`; branch `codex/website-catalog-import`. Main base `adeeae01d1f34d727baee4716f36560ea6e93a29`; design commit `f5b43d3`. Preserve prior branches/worktrees and unrelated files.
- No SHOPLINE account, API token or token-encryption configuration is required for this path. Excel import remains available independently.
- Retain at most 20 canonical unique product URLs; five discovery documents; minimum one-second request interval; at most three redirects per request; 2 MiB decompressed HTML; 1 MiB sitemap/robots documents; ten-second total deadline per document including redirects/DNS/body.
- No full-store scan, recurring synchronization, browser bypass, paid extraction/AI, real workbook upload, merchant seed, production migration/environment change/deployment or SHOPLINE write.
- Local schema additions and synthetic migration/integration tests are authorized. Production rollout is separate.
- Only operator/admin/owner may scan/save. Session supplies workspace ID. Server actions and RLS enforce isolation; every persistent domain mutation has a transactional audit event.
- Website records never acquire connectionId, remoteProductId, sourceImportId, approval or export-ready state by inference.
- Existing runtime is retained; do not add another hosted service or provision a new queue. Extend the existing listing queue with a strict website-message variant while preserving its legacy listing payload.
- No automatic publication at completion. Record actual checks and unresolved live compatibility; retain the worktree for review.

## Source verification and runtime decision

Graph discovery found handleQueue, handleIngress, signQueueRequest and CatalogPage. Active source confirmed:

- `apps/worker/src/queue-consumer.ts` routes by known listing/shopline queue names.
- `packages/jobs/src/cloudflare-queue.ts` signs timestamp, path and body, with a five-minute verification window.
- `apps/web/lib/cloudflare-queue-runtime.ts` wraps signed ingress dispatch.
- `packages/db/src/repositories/source-imports.ts` requires a connection and workbook metadata.
- `apps/web/lib/catalog-contract.ts` currently assumes platform identity; it must become a discriminated union.
- `apps/web/components/listing-intake-tabs.tsx` defaults to Bulk Update; the import page copy also assumes a workbook.
- SQL migrations are in `packages/db/drizzle`, not `packages/db/migrations`.

Workers node:http does not support custom lookup. Do not use a DNS precheck followed by ordinary Worker fetch for untrusted destinations. Keep scheduling in Worker; Node fetches one document per internal request. The internal endpoint accepts scan/step/lease IDs, not a caller-supplied target URL; it loads the current persisted task itself. Reuse the existing internal HMAC primitive with a distinct path and active lease validation. Add one nonsecret Worker setting `WEBSITE_FETCH_BASE_URL` pointing at the trusted web application origin; production configuration is not part of execution.

Sources checked for this decision:

- https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/
- https://nodejs.org/api/https.html

Node transport must prove address pinning, hostname TLS verification and absence of ambient proxies in isolated tests. If it cannot, stop live compatibility work and report the concrete runtime limitation; never weaken the URL boundary to make the test pass.

## Task 0: Baseline and transport proof

**Files:** create `apps/web/lib/website/public-fetch.ts`, `public-fetch.test.ts`, `public-fetch.integration.test.ts`; create `docs/superpowers/plans/2026-09-06-website-catalog-import-results.md`.

**Interfaces:** export `PublicDocument`, `PublicFetchError`, `createPublicFetch(deps)` and `PublicFetch`. The transport accepts only a validated request and returns a single document; it does not discover links or write data.

```ts
export type DocumentKind = "robots" | "discovery" | "product";
export type PublicDocument = {
  url: string;
  status: number;
  contentType: string;
  text: string;
  capturedAt: string;
  retryAfterSeconds: number | null;
};
export type PublicFetch = (input: {
  url: string;
  kind: DocumentKind;
  lockedOrigin: string | null;
  signal: AbortSignal;
}) => Promise<PublicDocument>;
export class PublicFetchError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
```

- [ ] Check `git status`, current branch, main SHA and applicable AGENTS files. Reuse this isolated worktree, as established by using-git-worktrees. Record the baseline full test/typecheck/build commands before changes. Capture the current import page's missing URL option with synthetic auth.
- [ ] Write RED tests before transport implementation: reject HTTP, credentials, custom port, internal host, private/reserved IPv4 and IPv6, mapped IPv4, ambiguous numeric hosts, mixed public/private DNS results, redirect downgrade, foreign-origin product redirect and a fourth redirect. A private destination must cause zero connection attempts.

```ts
it("never connects to an address returned by a later DNS answer", async () => {
  const answers = ["93.184.216.34", "127.0.0.1"];
  const dialed: string[] = [];
  const fetchDocument = createPublicFetch({
    resolve: async () => [{ address: answers.shift()!, family: 4 }],
    request: async (target) => {
      dialed.push(target.address);
      return { status: 200, contentType: "text/html", body: ["<p>ok</p>"] };
    },
    now: () => new Date("2026-09-06T00:00:00Z"),
  });
  await fetchDocument({
    url: "https://store.example/",
    kind: "discovery",
    lockedOrigin: null,
    signal: new AbortController().signal,
  });
  expect(dialed).toEqual(["93.184.216.34"]);
});
```

- [ ] Run `corepack.cmd pnpm@11.7.0 --filter @wukong/web exec vitest run lib/website/public-fetch.test.ts`; expect missing module/behavior failure, record it.
- [ ] Implement URL normalization, public address validation and DNS-pinned Node HTTPS. The injected request target contains original hostname, validated address/family, path and signal. Dial the validated address with original hostname as TLS servername and Host; retain certificate verification and checkServerIdentity against the original hostname. Use a fresh direct agent with no ambient proxy, cookies, auth or reused socket; never re-resolve on connect.
- [ ] Implement redirect validation, streaming decompressed-byte limits, ten-second abort covering all phases, allowed content types and a bounded error code taxonomy. Request identity encoding; reject unsupported compression or decode with an independent post-decompression byte cap. Cancel/destroy bodies and sockets on abort/oversize. A changed apex/www origin is allowed only on initial canonicalization, after destination validation; all further fetches use the locked origin. Fragment stripping must not remove product variant query parameters.
- [ ] Add isolated TLS transport tests proving SNI/Host preservation, rejection of wrong certificate, rebinding resistance, body/deadline cancellation and proxy-environment independence. Inject resolver/dialer only through the test factory; do not add a production environment flag allowing private destinations.
- [ ] Run targeted tests and web typecheck. Commit exact transport/test/results paths. Record a passing local transport proof before Task 3 binds it into the app.

## Task 1: Immutable product observations and deterministic parsing

**Files:** create `packages/core/src/website-catalog.ts`, `website-catalog.test.ts`; create `apps/web/lib/website/extract-document.ts`, `extract-document.test.ts`, `robots-policy.ts`, `robots-policy.test.ts`; modify `packages/core/src/index.ts`. Synthetic fixture HTML remains inline or under `apps/web/lib/website/fixtures/`.

**Interfaces:** `WebsiteProduct`, `WebsiteScanState`, `extractDocument(input)`, `parseRobots(input)`. Extraction is pure; no network or database. All schemas are strict Zod objects, with limits enforced before persistence.

```ts
export type WebsiteScanState =
  "queued" | "running" | "ready" | "partial" | "failed";
export type WebsiteProduct = {
  key: string;
  sourceUrl: string;
  capturedAt: string;
  title: string;
  description: string | null;
  imageUrls: string[];
  price: { amount: string; currency: string } | null;
  availability: "in_stock" | "out_of_stock" | "preorder" | "unknown";
  attributes: Record<string, string>;
  fieldSources: Record<string, "json_ld" | "html">;
  warnings: string[];
};
// key is the canonical source URL; money stays a validated decimal string.
export type ExtractedDocument = {
  product: WebsiteProduct | null;
  productLinks: string[];
  sitemapLinks: string[];
  warnings: string[];
};
```

- [ ] Write failing pure tests for Product JSON-LD objects, arrays and @graph; narrowly scoped SHOPLINE HTML fallback; unknown price/currency; offers conflicts; multiple variants; duplicates; invalid URLs; missing title; embedded instructions/scripts; HTML entities and Chinese text.

```ts
it("does not fabricate inventory or identifiers from availability", () => {
  const result = extractDocument({
    url: "https://store.example/products/sample",
    capturedAt: "2026-09-06T00:00:00Z",
    html: '<script type="application/ld+json">{"@type":"Product","name":"Sample","offers":{"availability":"https://schema.org/InStock"}}</script>',
  });
  expect(result.product?.availability).toBe("in_stock");
  expect(result.product?.price).toBeNull();
  expect(result.product).not.toHaveProperty("remoteProductId");
  expect(result.product).not.toHaveProperty("inventoryQuantity");
});
```

- [ ] Run core and web extraction suites to record RED, then implement the strict types and parsers. Use an HTML parser rather than regex for nested markup. If no direct suitable parser exists, add `parse5` and `robots-parser` to web with `corepack.cmd pnpm@11.7.0 --filter @wukong/web add --save-exact parse5 robots-parser`; retain exact manifest/lock changes and verify Node 24 compatibility. Do not depend on a transitive import or use an XML parser with external entities enabled.
- [ ] Bound title to 500 characters, description to 20,000, attributes to 30 pairs of at most 100/1,000 characters, image references to ten public HTTPS URLs, warning list to 30, and normalized scan envelope to 1 MiB. Oversized fields produce explicit warnings; reject an oversized final envelope rather than silently truncating serialized evidence.
- [ ] Implement robots user-agent `WukongCatalogPreview/1.0`, longest-path allow/disallow semantics, sitemap hints and crawl-delay where supplied. A 404 permits crawling; 401/403 disallows; network/5xx/malformed policy fails that origin. Honor the stricter of one second and crawl-delay; rate-limit responses stop with a clear partial/failure state. Parse sitemap links without external entity expansion, under the discovery budget.
- [ ] Successful canonical redirects require robots approval at the resulting origin before its product pages. Resolve relative links against the actual document URL; permit same-origin links only. Keep canonical links advisory unless they pass the same URL and origin checks.
- [ ] Run `corepack.cmd pnpm@11.7.0 --filter @wukong/core test` and `corepack.cmd pnpm@11.7.0 --filter @wukong/web exec vitest run lib/website/extract-document.test.ts lib/website/robots-policy.test.ts`; expect pass. Commit parser/domain/test and any exact dependency paths.

## Task 2: Durable scan and selected website records

**Files:** create `packages/db/drizzle/0019_website_catalog.sql` after checking the highest migration number is 0018; if main advanced, choose the next unused number before editing. Create `packages/db/src/repositories/website-catalog.ts`, `website-catalog.integration.test.ts`; modify `packages/db/src/schema.ts`, `client.ts`, `index.ts`, `cli/audit-verify.ts`, `cli/audit-verify.integration.test.ts`.

**Interfaces:** add `repositories.websiteCatalog` exposing `createScan`, `getScan`, `claimStep`, `completeStep`, `recordDispatch`, `saveSelection`, `listProducts`. All operate within the existing workspace transaction. No transaction stays open during external fetch.

```ts
export type WebsiteStep = {
  scanId: string;
  revision: number;
  leaseToken: string;
  url: string;
  kind: "robots" | "discovery" | "product";
  lockedOrigin: string | null;
  notBefore: string;
};
export type WebsiteSaveResult = {
  savedIds: string[];
  alreadySavedIds: string[];
};
// createScan({url, requestedBy, requestKey}) -> scan
// claimStep({scanId, revision, now}) -> WebsiteStep | null
// completeStep({scanId, revision, leaseToken, observation, now}) -> scan
// saveSelection({scanId, keys, actorId}) -> WebsiteSaveResult
```

- [ ] Write RED integration tests against an explicit isolated synthetic database supplied through the same CI URL convention as neighboring suites. Do not require a hardcoded database name. Test foreign workspace IDs, viewer route denial, two concurrent claims, expired lease fencing, duplicate completion and concurrent duplicate save.
- [ ] Create `website_scans` (state, canonical origin, discovery/product budgets, request key, immutable final preview, cursor/revision/lease, retry/dispatch metadata), `website_scan_steps` (unique scan/revision result and request state) and `website_products` (saved immutable observation and source scan/key). Use UUID keys, workspace foreign keys, composite foreign keys for scan/product relationships, unique workspace/request-key and workspace/canonical-source-url constraints, FORCE RLS and least-privilege grants following existing migrations.

```sql
-- Apply this invariant in the new website_products table definition.
UNIQUE (workspace_id, canonical_source_url),
FOREIGN KEY (workspace_id, source_scan_id)
  REFERENCES website_scans (workspace_id, id)
```

- [ ] Make terminal previews immutable. Save only keys present in a ready/partial scan owned by the session workspace. Reject empty/duplicate/unknown keys. Persist the server observation, never client product fields. `ON CONFLICT` returns existing IDs without updating reviewed/saved content; retries cannot append duplicate audit actions for the same product.
- [ ] Audit `website.scan_created`, `website.scan_step_completed`, `website.scan_finished`, `website.products_saved` in their respective transactions. Add all new tenant tables to the existing audit verifier leak probe; create scan-specific audit assertions instead of forcing website products through the listing publication lifecycle.
- [ ] Use 60-second leases and a revision/lease-token comparison on completion. A stale worker cannot overwrite a reclaimed step. Persist each result before advancing the cursor. Cap attempts per step at three; exhausted steps terminate with partial if products exist, failed otherwise.
- [ ] Run new isolated integration tests plus audit/RLS regressions and db typecheck. Record migration command/database identity without secrets. Commit exact SQL/schema/repository/audit paths.

## Task 3: Queue orchestration, internal page fetch and public API

**Files:** create `packages/jobs/src/website-queue.ts`, `website-queue.test.ts`; modify `packages/jobs/src/index.ts`, `cloudflare-queue.ts`; create `apps/worker/src/website-consumer.ts`, `website-consumer.test.ts`; modify `queue-consumer.ts`, `queue-consumer.test.ts`, `ingress.ts`, `ingress.test.ts`, `worker-env.ts`, `sweeper.ts`, `sweeper.test.ts`; create `apps/web/lib/website/scan-service.ts`, `scan-service.test.ts`; create `apps/web/app/api/internal/website-document/route.ts` and test; create `apps/web/app/api/website-scans/route.ts`, `[id]/route.ts`, `[id]/save/route.ts` and colocated tests. Modify `apps/web/lib/cloudflare-queue-runtime.ts` and test, `scripts/render-cloudflare-config.mjs`, relevant runtime config tests and `.env.example` (names only).

**Interfaces:** public POST creates scan with an idempotency key and returns 202; GET returns no-store state/progress/preview; save POST accepts only product keys. Worker messages carry internal IDs and revision. Signed internal fetch loads the claimed step; its request body contains no URL.

```ts
export const WEBSITE_INGRESS_PATH = "/ingress/website-scans";
export const WEBSITE_DOCUMENT_PATH = "/api/internal/website-document";
export const websiteJobSchema = z
  .object({
    kind: z.literal("website_scan"),
    workspaceId: z.string().min(1),
    scanId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
export const websiteDocumentRequestSchema = websiteJobSchema
  .extend({
    leaseToken: z.string().uuid(),
  })
  .strict();
// POST /api/website-scans: {url, requestKey}; server derives workspace/requester.
// POST /api/website-scans/:id/save: {keys: string[]}.
```

- [ ] Write failing route tests proving scan/save work without a connection or encryption key and reject unauthenticated/insufficient-role/cross-workspace access, invalid body, oversize body and unsupported URL. Require operator using existing role helper; do not assume reviewer meets operator in the role hierarchy without checking.
- [ ] Write consumer tests for legacy listing payload compatibility, website dispatch, duplicate delivery, notBefore delay, lease expiry, three-attempt exhaustion, lost-next-enqueue recovery and no AI/SHOPLINE invocation. Reuse listing queue with a strict discriminator only for the new variant; malformed website payload must never fall through into AI listing processing.
- [ ] Internal Node route sets `runtime = 'nodejs'`. Enforce POST, JSON, maximum 4 KiB body, exact HMAC path/timestamp/body and active workspace/scan/revision/lease match before calling transport. Return only bounded parsed observation/discovery results, not raw HTML or secret diagnostics. Persist/cache a completed step result so replay of an identical signed callback cannot repeatedly scrape a page. Do not extend the internal HMAC privilege to any public route.
- [ ] Worker callback uses only a configured trusted `WEBSITE_FETCH_BASE_URL`, with no redirects and no propagation of its HMAC headers to scraped sites. Missing configuration yields an actionable scan-unavailable error. Add the setting as optional so existing runtime checks do not break when website scanning is unused. Never derive callback origin from the submitted storefront URL or HTTP Host header.
- [ ] Start with robots, then homepage/product input and bounded sitemap discovery. After every persisted result, calculate the next step and notBefore, enqueue its revision, then acknowledge. Budget includes failed attempts in total network accounting; product candidates remain capped at 20 and discovery documents at five. Store progress as scanned/selected-candidate counts, never total-store coverage.
- [ ] Reconcile pending dispatches and expired leases through the existing sweeper, with a bounded ten-scan batch and oldest-first order. An enqueue failure leaves a durable dispatch-pending record; retry with the same requestKey returns that scan rather than creating another. Stop after a 15-minute scan deadline with retained partial observations.
- [ ] Public GET returns only normalized products, warnings, state, progress and source URL/time; no lease, internals, stack, key, token or raw page. Every public response, including errors, is no-store. Partial saves are allowed only after terminal partial state. Keep GET read-only.
- [ ] Run jobs, worker and new web route suites; typecheck and dry-run Worker build. Extend the local managed harness callback origin using synthetic configuration only. Commit exact queue/runtime/route/test paths.

## Task 4: Catalog projection and export exclusion

**Files:** modify `packages/db/src/repositories/workspace-reads.ts`, `workspace-reads.integration.test.ts`, `apps/web/lib/catalog-contract.ts`, `apps/web/app/api/catalog/route.ts`, `route.test.ts`, `apps/web/components/catalog-control-center.tsx`, `catalog-control-center.test.tsx`, `catalog-view-models.ts`, `catalog-view-models.test.ts`; create `apps/web/components/website-product-detail.tsx`, test; create `apps/web/app/api/website-products/[id]/route.ts`, test; extend `apps/web/lib/bulk-update-eligibility.test.ts` and actual bulk-export/delivery route tests discovered via graph at execution.

**Interfaces:** discriminated catalog union; platform items keep their existing fields, website items have no remote ID or listing association. The API provides one consistently filtered and sorted paginated result, not two separately paginated arrays concatenated in JS.

```ts
export type WebsiteCatalogItem = {
  sourceType: "website";
  id: string;
  title: string;
  sourceUrl: string;
  capturedAt: string;
  createdAt: string;
  updatedAt: string;
  canExport: false;
};
// CatalogItem = PlatformCatalogItem & {sourceType:'platform'} | WebsiteCatalogItem.
// Dispatch row/detail/export rendering only after narrowing sourceType.
```

- [ ] RED integration test: interleave 30 platform rows and 21 website rows; page size 25; verify total/counts, no duplicates/missing rows, deterministic order and title/source-URL search across page boundaries.
- [ ] Add one workspace-scoped SQL UNION projection with consistent sort by createdAt descending, sourceType and ID as tie breakers. Website items appear in All and a new Website source filter; keep existing listing-review/attention/published/unlinked filters and summary cohorts platform-specific. Add a separate website count and include website rows in overall total; update UI labels so existing unlinked metric is not mistaken for all website entries.
- [ ] Add read-only website detail view with full normalized observation, source link, capture time, field sources and warnings. Do not instantiate listing edit/approval/publish controls for website IDs. External links use safe validated URLs, rel=noreferrer/noopener and no raw HTML rendering.
- [ ] Test direct attempted website ID use in single/bulk export and API delivery. Expect controlled not-found/ineligible response, no artifact generation, no queue message and no dummy platform row. Preserve all existing eligible platform cases. Do not weaken shared eligibility or add auto-linking by SKU/title.
- [ ] Ensure selected platform IDs survive catalog refresh safely; website rows have no export selection checkbox. Test mixed-source pagination, filtered errors and recovery with the existing latest-request hook.
- [ ] Run focused db/web catalog and export/delivery regression suites; typecheck the discriminated union across consumers. Commit explicit catalog/detail/test paths.

## Task 5: URL-first import UI and synthetic end-to-end acceptance

**Files:** create `apps/web/components/website-import-panel.tsx`, `website-import-panel.test.tsx`; modify `listing-intake-tabs.tsx`, `listing-intake-tabs.test.tsx`, `apps/web/app/(app)/listings/import/page.tsx`, `apps/web/app/globals.css`; create `tests/e2e/website-import.spec.ts`; modify `tests/e2e/real-stack-fixture.ts` and managed local server binding only where needed to inject synthetic fetch; update `CONTEXT.md`, `docs/runbooks/shopline-pilot-onboarding.md`, results file.

- [ ] Write RED rendered test: no token/key/connection, type URL, start, poll, inspect 20-product-limit label, select a product and save. Add viewer/reviewer guidance, expired session, queued/running/partial/failed states, invalid URL, retry and stale response tests. Product description must display as text even when the fixture includes scripts.

```ts
await user.type(screen.getByLabelText("Website URL"), "https://store.example/");
await user.click(screen.getByRole("button", { name: "Preview products" }));
expect(await screen.findByText("Sample bottle")).toBeVisible();
expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
await user.click(screen.getByRole("checkbox", { name: /Sample bottle/ }));
await user.click(
  screen.getByRole("button", { name: "Save selected products" }),
);
expect(await screen.findByText(/1 product saved/)).toBeVisible();
```

- [ ] Make Website the default import choice, with an explicit Workbook choice preserving the existing inline store-connection card and input behavior. Update page title/intro to Catalog import / 商品目錄匯入. New copy must use the existing locale context. Keep the current supporting-evidence/new-product safeguards.
- [ ] Implement polling with AbortController/latest-response guards and pause when unmounted. Retain scan ID in the page URL for reload, but never put credentials in URLs. Changing storefront invalidates old selection; a retry preserves the last completed preview without conflating two scans. Disable duplicate submits, keep save idempotency and announce progress/errors accessibly.
- [ ] Build synthetic browser fixture through dependency injection, not production URL/private-IP exceptions. Exercise the real signed Worker-to-Node callback, durable database scan, selection/save, catalog read and audit with a synthetic site transport. Leave real SHOPLINE disabled, AI fake and database explicitly isolated.
- [ ] Verify en/zh-Hant at 375px/1440px, keyboard navigation, no overflow, progress and partial warnings, retained retry state and actual saved observation/digest. Keep all existing Bulk Update and inline-connection browser cases passing.
- [ ] Run full `corepack.cmd pnpm@11.7.0 test`, `typecheck`, `lint`, `build`, `format:runtime:check`, `runtime:forbidden:check`; isolated `test:integration`; then `exec playwright test --project=chromium --workers=1 --retries=0`. Run relevant audit verifier against synthetic data and assert zero cross-workspace exposure. Do not source browser-specific auth environment into unit runs.
- [ ] Optionally make a bounded public read-only Opak compatibility probe after transport tests: robots, homepage, one product, respecting policy. Record which fields were actually extracted and any failure. Never equate mocked success with live support. No real workbook or production persistence.
- [ ] Visually inspect saved mobile/desktop screenshots. Record exact command results, baseline versus regression failures, source-binding limits and any deployment prerequisite. Shut down task-owned synthetic services, preserve their data and unrelated worktrees.
- [ ] Run independent review under the selected execution workflow. Fix confirmed findings and repeat only affected checks. Commit explicit source/test/doc paths and stop for the finishing workflow; no automatic push, merge, migration or deployment.

## Plan self-review

- All spec requirements map to Tasks 0–5: transport/crawl policy 0–1; persistence, RLS, audit and retries 2–3; catalog and export exclusion 4; complete bilingual user journey and acceptance 5.
- This is one feature with independently reviewable internal steps, not approval for full-site synchronization or product publishing.
- The Node callback is one bounded fetch, not a replacement long-running server. Worker retains durable orchestration; no new external provider or queue provisioning is required.
- New website data does not alter source-imports/platform-products/listing approval identities. Saved content is immutable; re-scan updates require a later explicit design.
- Tests and implementation are pending. Prior homepage evidence and existing test counts are not evidence that this new feature works.
