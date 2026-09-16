# T14/T15 bounded matched URL evidence slice — 2026-09-16

## Current gap and chosen adapter

Existing website-catalog scanning already implements public HTTPS validation, DNS/IP pinning, TLS hostname verification, redirect/origin controls, robots access policy, bounded bytes/deadline, and script-free structured document extraction. It did not bind an observation to a listing identity, distinguish URL evidence in listing adoption, or expose controlled source-fact adoption.

This slice reuses those existing adapters for an **explicit operator-selected public product URL**. It does not introduce a search provider, provider credential, paid inference adapter, or automatic research stage. The interface accepts a caller-independent PublicFetch port for deterministic tests; production defaults to existing createPublicFetch. No new provider documentation or pricing assumption is needed because no new external provider is introduced.

## Implemented

- Additive 0035 stores immutable listing_enrichment_suggestions with workspace text IDs, exact input revision and nullable base version, request-key digest, bounded typed payload, forced RLS and application SELECT/INSERT only. Listing, revision and base-version foreign keys retain tenant identity. Audit enumeration includes the table.
- POST listing/:id/enrichment checks authenticated operator role, current saved revision/base and workspace sourcePreferences.allowedDomains (exact hostname; empty means explicit public URLs permitted). It retrieves robots then a single product page outside DB transactions. Requests use existing pinned public-fetch protections, same-origin redirects, robots check on every product hop, at most a 22-second service deadline, existing byte limits and a bounded crawl delay. Canonical hints pointing to an unfetched page are refused as evidence.
- Deterministic product matching requires producer AND exact product/cuvée, vintage or explicit non-vintage, volume, pack count and market variant. Missing dimensions are unresolved; contradictory dimensions conflict. Name similarity or same brand cannot authorize adoption.
- Structured noncommercial facts only: producer/type/country/region/vintage/grapes/volume/ABV/pack. No merchant SKU/price/stock, ratings, awards or prose is suggested. Webpage instructions remain parsed data and never enter an agent instruction channel.
- Evidence is kind:website with actual source URL, SHA256 of retrieved document, retrieval time, literal extracted attribute value, location, source class and deterministic extraction version. It never invents a sourceAssetId. Public-page observations are not labelled independently verified manufacturer authority.
- GET latest and GET exact suggestion preserve inspectable results after reload. POST explicit selected adoption validates stored match, current content/source context digest, revision/base and field locks; client-supplied values are rejected. It creates an operator-owned working revision and stores website:<suggestion-id>:<field> provenance references. It never approves content or edits a saved review version automatically.
- The working editor includes a lazy evidence lookup panel with explicit URL and product identity, match/conflict explanation, current/proposed values, source links/excerpts and selected-field adoption. Viewer/dirty controls cannot mutate. Request keys survive a lost response; stale observations remain non-adoptable.

## Deterministic evidence

| Scope                                                                    | Result         |
| ------------------------------------------------------------------------ | -------------- |
| Core product/identity mismatch and prompt-text containment               | 8/8 passed     |
| Existing public-fetch, robots and parser suites plus evidence/working UI | 108/108 passed |
| Real local Postgres retrieval/adoption suite                             | 4/4 passed     |
| Tenant schema audit enumeration unit suite                               | 14/14 passed   |

Real DB tests use synthetic unique workspaces and the application RLS role. They verify completed-request replay without re-fetch, exact selected adoption, typed URL provenance, no copied merchant/rating/prose values, different vintage refusal, forged-value refusal, viewer and foreign-workspace refusal, private URL rejection before fetch, robots denial, exact-domain workspace policy, and manual field lock retention. Fetches are injected deterministic responses; **no live website, private image transmission, paid model/image call, production migration or SHOPLINE write occurred**.

Core and DB builds passed before concurrent batch edits. Latest shared full type checks encountered in-progress sibling batch schema/module edits; parent stable full build is authoritative. This is bounded source/UI/integration evidence, not a claim that A25-A28 or G3 are complete.

## Remaining scope

- No general search discovery adapter, automatic generate/enrich run integration, new evidence stage, auto_verified policy or unrestricted prose/critic/award claim validation.
- Product title matching is deliberately exact and source attributes must explicitly supply vintage/volume/pack/market. Many pages remain unresolved rather than guessed.
- Existing saved review confirmations are not automatically promoted to independently verified URL evidence. The separate URL evidence and working-field provenance remain inspectable; broader per-claim confirmation-ledger integration is still future work.
- Authorized merchant fixtures, golden matching accuracy, native-browser research journey and live source/provider acceptance were not run. Missing merchant authorization does not block these deterministic checks but does block merchant acceptance claims.

Final focused core and evidence/working UI reruns passed8/8 each after adding source identity display and clearing stale comparison when lookup criteria change. Latest full web typecheck reports only sibling enrichment-batch-service.ts565 and jobs-ledger.ts32 diagnostics, with no evidence-slice diagnostics. Styling hooks are panel working-copy and listing-evidence-lookup; parent owns their CSS.

## T15 follow-up — rejection and structured claim boundary (2026-09-16)

Implemented migration 0037 listing_enrichment_decisions: append-only, forced tenant RLS, scoped suggestion/input/base FKs, actor/selected fields/request digest, SELECT+INSERT only. POST /enrichment/:suggestionId/reject requires operator, listing lock, current revision/base/context and stored distinct field selection. Replays retain the same decision; changed payload returns 409. Rejected fields remain visible after GET/reload and cannot be adopted. A fresh explicit retrieval creates a fresh suggestion. Conflict/locked fields can be rejected without enabling adoption. Rejection records a decision rather than altering product values or incrementing the input revision.

Added optional typed website claim observations to existing immutable suggestion payloads. Structured critic/rating/ratingScale/ratingYear and awardName/awardEdition attributes only; each supported observation requires matched full product identity (producer, product, vintage, volume, pack, market), exact critic/value/scale/year or award name/edition, and bounded real URL/digest/time/excerpt. Missing legacy context, unsupported prose, invalid scale or unmatched identity remains unresolved; mismatches conflict. No conversion to asset IDs or invented references. The UI displays the structured observation and its source separately from adoptable scalar facts.

Validation: core external claim support 3/3; evidence UI 4/4; local app-role route integration 6/6; separate decision immutability/tenant integration 1/1; schema audit unit 14/14. Combined route/catalog integration 7 passed, 3 pre-existing environment-gated catalog cases skipped. Core and DB builds and web typecheck passed. All fixtures synthetic; no provider calls, production mutation, or deployment.

Remaining source gaps (not merchant-fixture blockers): explicit external claim acceptance into canonical content and persisted per-copy ClaimSupport linkage are not implemented; current legacy criticScores/awards asset schema remains intact. General prose (tasting/process/exclusivity) has no automatic proof and requires existing compliance/manual review; the new structured-support result must not be treated as proof of an entire description. Pipeline enrich operation/general search, ambiguous candidate choice, and full A27/A28 claim-ledger coverage remain incomplete. This slice does not claim G3 completion.

## T15 canonical claim acceptance and version lineage (2026-09-16)

This section supersedes the earlier missing-canonical-acceptance limitation.

- Explicit acceptance of a stored matched rating/award creates a working input revision containing the exact server-rendered claim sentence, with immutable listing_claim_supports lineage (0039): actor, source URL/digest/retrieval time/excerpt, exact claim dimensions, copy field/text, product identity snapshot, source snapshot and accepted revision. No synthetic asset IDs and no model calls. Missing legacy context stays unresolved. Merchant facts are unchanged.
- Same key/body replays; changed payload conflicts. Tenant/operator role, current input/base revision, stored claim index, rejected state, complete matching saved identity, source context and field lock checks precede adoption. Structured claims can be explicitly rejected and remain rejected on reload.
- Existing manual review save validates only the exact supported sentence and retains all other rating, health and guarantee checks. Accepted support IDs bind immutably to the resulting canonical review version through listing_version_claim_supports; image-only approval promotion transfers these validated bindings. Both join relationships and input revision have workspace composite FKs and supporting indexes. RLS/audit table inventory and readiness count27 updated.
- Subsequent changes to copied wording, identity, notes or selected sources invalidate support, including edit then revert. Review reopens unsupported claims, approval refuses stale or unbound support, and removing the claim permits normal review. Reacceptance requires valid current source/context. Adding another supported sentence can rebind previously unchanged external claims under a fresh explicit acceptance record.
- General prose has a separate explicit per-claim confirmation: exact existing span (max500), real stored matched-page excerpt and operator explanation (20–1000 characters). It creates the same immutable revision/copy/source lineage and is labelled human-confirmed, never automatically verified. It cannot suppress score/award/health/guarantee checks. Existing compliance and exact-version confirmation remain required.
- Connected UI shows sentence preview, destination copy field, accept/reject, manual prose source comparison/confirmation and current/invalidated lineage after reload. Lost-response acceptance retries keep the same key.

Verification: local app-role route integration9/9 (canonical promotion, resulting-version linkage, replay/CAS, foreign tenant/role, copy edit/revert and identity invalidation, approval stale refusal, claim rejection, explicit prose evidence, rating bypass refusal); core claim tests4/4; evidence UI5/5; review route10/10; approval binding16/16 including image-only version transfer; audit schema unit14/14. Core/DB builds passed; web typecheck also passed after the final image-transfer call. All tests synthetic, no paid model calls, no production mutation or commit.

Remaining boundaries: this explicit-URL flow does not implement pipeline enrich/search orchestration or operator selection among ambiguous product candidates. Legacy uploaded critic/award facts retain their existing schema and do not gain invented product/year/scale context. General prose is not mechanically proven; it requires the stored attributable per-claim human decision and normal review. No merchant golden/live acceptance or G3 release gate is claimed from deterministic tests alone.

## Final review P1 corrections (2026-09-16)

Reproduced and closed product-name/market-variant substitution. Lookup and every adoption path now require normalized exact equality with the saved English title and an explicit immutable note line such as Market variant: HK (localized label accepted; absent/conflicting declarations require clarification). These saved values, not the URL/request, establish identity. English title is therefore reserved for identity; claims use other copy fields. UI explains the necessary saved correction and never displays raw server errors. Existing support validity checks the original suggestion identity too, so previously accepted mismatched claims do not remain licensed.

Reproduced and closed accepted-claim rejection. Rejecting a structured claim creates a correction revision through the existing input workflow, invalidates prior approval, and adds an immutable rejection decision. Claim support reads check those decisions against the source claim, including reaffirmed records; rejected support cannot license canonical copy. Publishing rejects the change with409 and retains its revision. UI reloads the new revision after rejection.

Focused verification: local app-role enrichment integration13/13 (product A/B and HK/US refused before fetch, legacy mismatched candidates refused on adoption, approved→rejected support invalidation, publishing conflict), matched identity core9/9, evidence UI6/6, approval binding16/16. No new migration, paid call or production mutation. The strict title/note clarification is the deliberate current identity contract until a dedicated product-identity editor is introduced.
