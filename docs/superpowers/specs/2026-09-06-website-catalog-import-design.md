# Website catalog import — approved design

Date: 2026-09-06
Status: User approved the proposed URL-first, 20-product preview. This written specification is ready for review before implementation planning.
Base: GitHub main adeeae01d1f34d727baee4716f36560ea6e93a29 (PR #76 merged), verified against ls-remote.

## User outcome

A workspace operator pastes https://www.opakcellar.com/, scans public product pages, reviews up to 20 products and saves selected products into Wukong. No SHOPLINE account, API token or token-encryption configuration is required for this path. Excel import remains available independently.

## Scope and alternatives

Use a bounded public website scan followed by explicit selection and save. This directly meets the user's URL-only request. A single-product URL importer would be simpler but would require repetitive manual input. Excel plus website enrichment can provide stronger original product identifiers but still requires a workbook, so it remains a later complementary flow rather than a prerequisite.

The first slice supports Opak Cellar's public SHOPLINE storefront HTML and structured product data. Other public HTTPS storefront URLs may be submitted, but unsupported markup produces an explicit unsupported result; universal website compatibility is not promised. Full-store crawling, recurring synchronization, browser automation to bypass site restrictions and paid extraction/AI services are excluded.

## User journey

1. On /listings/import, a prominent Import from website / 從網站匯入 option offers a website URL field and Preview products / 預覽商品 button. The page introduction must explain both website and workbook import, rather than implying every source requires SHOPLINE connection.
2. Operator/admin/owner users can start a scan. Viewer/reviewer users without import capability see guidance. Both the API and UI enforce these permissions.
3. Show queued/running progress, the submitted public origin, and a clear 20-product preview limit. This is a sample, not a full catalog count.
4. Show discovered products with source link, title, description, image URL, displayed price/currency, public availability, and visible attributes such as brand, volume or vintage. Every field is optional except a usable product URL and title; unavailable values are shown as unknown. Do not infer inventory quantity from availability or invent SKUs, variants or merchant IDs.
5. Let the user select valid rows, inspect extraction warnings, and save selected products. No product is selected for automatic persistence before review. Report saved/already-saved counts and provide a catalog link.
6. Saved products appear in the catalog with a Website source badge and captured-at time. They remain reviewable website records and cannot be silently treated as SHOPLINE export-ready products.

Both en and zh-Hant and 375px/1440px layouts must work. Changing URL invalidates the old selection. Network retry keeps the URL and successful preview available; stale responses cannot replace a newer scan. A refresh can reload the authenticated scan by ID.

## Discovery and extraction

Use server-side bounded fetch and deterministic extraction, not AI. Read robots rules for the crawler user agent before following product pages. A missing robots file (404) permits normal crawling; an unavailable or unparseable policy produces an actionable scan failure. Honor disallow rules and rate-limit responses. Never submit credentials, forms or purchases.

Discover product links from the supplied page, then a bounded same-origin sitemap when needed. Retain at most 20 canonical unique product URLs, crawl sequentially with a minimum one-second interval, and limit discovery to five documents. Accept at most three redirects per request, 2 MiB decompressed HTML per page, 1 MiB per sitemap/robots document and a ten-second timeout per fetch. Stop with partial-result warnings when limits or remote errors prevent completion. Do not claim that discovering fewer than 20 means the whole store was scanned.

Prefer valid Product JSON-LD and structured offer fields; use narrowly scoped storefront HTML fallbacks. Treat page content as untrusted data: never execute scripts or follow instructions embedded in descriptions. Render sanitized plain descriptions and validated public image URLs. Store image references only in this slice, not mirrored image bytes. Preserve field source and capture time. Conflicting structured/visible fields produce a warning rather than fabricated certainty.

## Network boundary

All requests are server-side and unauthenticated. Accept public HTTPS URLs only; reject userinfo, nonstandard ports, loopback, private/link-local/reserved IPs and internal hostnames. Validate DNS resolution and every redirect destination, with a transport that prevents resolution-to-connection rebinding; a preflight DNS check alone is insufficient. Product discovery remains on the normalized approved origin. Handle the normal apex/www canonical redirect only after the same public-destination validation, then lock subsequent discovery to the resulting origin. Do not fetch arbitrary image URLs during extraction.

Use an injected fetch/discovery port so automated tests use synthetic services only. The production transport must fail closed if its deployment runtime cannot enforce the address boundary. Do not introduce a paid proxy/provider to work around that limitation.

## Persistence and runtime

Keep route handlers thin and dependency-injected. Use the existing authenticated workspace scope, Postgres RLS, audit writer, and Cloudflare Worker/Queue job architecture for a durable bounded scan. Do not run a 20-page crawl inside one Vercel request. Poll scan state through an authenticated no-store read endpoint. Queue messages contain internal IDs; load the validated scan URL and scope server-side. Leases and idempotency must prevent duplicate completion or product creation on delivery retries.

Persist a separate website scan/source model and immutable normalized preview evidence. Persist selected website catalog records keyed by workspace and canonical source URL; retries of the same save return existing IDs. Never overwrite an existing reviewed product or a workbook-derived record by title, slug or guessed SKU. A later scan offers an explicit new observation rather than silently replacing saved content.

The active source-import repository requires connectionId, workbookSha256, headerContractSha256 and merchantAttestedExportAt. Do not fake these values or create a dummy SHOPLINE connection for website records. Integrate website records into catalog browsing with explicit source type and stable IDs while preserving existing workbook-specific review/export actions. Server-side eligibility must reject website-only records from Bulk Update and API delivery, including direct requests that bypass the UI. Linking to a verified workbook product requires a separately designed explicit reconciliation flow.

Local schema additions and migration tests are permitted for this feature; production migrations, environment changes, deployment, merchant seeding and SHOPLINE writes are not authorized. Preserve Node 24, pnpm 11.7, Next/React/plain CSS and existing runtime. Do not alter unrelated packages.

## Verification and acceptance

- Reproduce token-dependent setup and lack of URL preview before changing behavior.
- Synthetic extraction fixtures cover structured data, HTML fallback, variants/duplicate URLs, missing fields, malformed JSON-LD, escaped markup and contradictory offers.
- Network tests cover every URL/address/redirect restriction, rebinding protection, robots decisions, rate limits, size/time/crawl limits and cancellation/failure states.
- Route/repository tests cover unauthenticated and insufficient-role requests, cross-workspace access, durable retry, no-store, selection validation, immutable preview evidence, transactional audit and idempotent saves.
- Export regression tests prove website-only records cannot gain verified source bindings or pass existing Bulk Update/API delivery eligibility.
- Browser acceptance uses isolated synthetic HTTP transport/services: paste URL, preview, select/save, reload catalog, retry, partial results, both locales and narrow/desktop layouts. Run appropriate full unit/typecheck/lint/build/runtime gates plus isolated migration/integration checks if schema changes.
- A bounded read-only live Opak extraction check may inspect public pages for compatibility, but must not seed production or save merchant catalog data. Do not upload the supplied real workbook. Report live compatibility separately from synthetic tests.

## Current evidence and limits

Public homepage reading exposed product links, names, displayed prices and sold-out labels on https://www.opakcellar.com/. The browsing tool could not retrieve the sampled product page or robots.txt, so detailed product extraction and crawl-policy compatibility are not yet established. Validate these before claiming live support. The knowledge graph was used for discovery but is stale; active source confirmed the existing tab layout and connection-bound source-import contract.

No implementation or live scan has been completed under this specification. Public website data does not establish store ownership, exact inventory, complete catalog coverage, internal product identity or permission to write to SHOPLINE.
