# ADR: bounded explicit-URL product retrieval

Date: 2026-09-16. Status: implemented for explicit URLs; general search and automatic pipeline enrichment are not enabled by this decision.

## Decision

Use the existing website module's public HTTP fetch and structured document parser behind an injectable `PublicFetch` interface. The operator supplies a public product URL after saving the product identity. This is a working retrieval capability using the existing runtime, with no invented search-provider configuration or new provider credential.

The runtime capability is documented by [Node's Fetch API](https://nodejs.org/api/globals.html#fetch). [Cloudflare also documents Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/), although this implementation's evidence lookup runs through the existing web service. Hosting requests and execution still consume the existing platform's metered resources; see [Vercel Functions usage and pricing](https://vercel.com/docs/functions/usage-and-pricing). No independent search subscription or per-query vendor pricing is assumed, and this decision does not claim retrieval is free.

## Boundaries

- Reuse public-network/DNS/redirect checks, response size and time limits, robots policy and workspace exact-domain restrictions.
- Send a public URL only. No private source image, internal merchant SKU, stock, price or credential is sent to public search.
- Parse retrieved text as untrusted data. It cannot authorize operations or override workflow instructions.
- Compare product, producer, vintage, volume, pack and market against saved operator identity before accepting observations. Conflicts and missing identity remain unresolved.
- Store actual URL, digest, retrieval time and bounded excerpt separately from image asset evidence. Responses and adoption decisions have immutable request/revision lineage.
- Require explicit field/claim acceptance; an HTTP success, same-brand page or search snippet is not proof of the product.

## Consequences

The available flow is a usable narrow retrieval adapter, with deterministic injected responses for tests. It cannot discover an unknown URL, choose among ambiguous candidates, prove arbitrary prose or establish merchant matching accuracy. Those capabilities need their own implementation and evaluation; the current UI and release evidence must retain this limit.
