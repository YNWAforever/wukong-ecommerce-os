# Task 5c report — Worker acquisition and committed DB adapters

## Outcome and scope
DONE for the controller-approved narrowed Task5c scope, starting at a3e2337 on codex/tavily-wine-enrichment-design. Task5 overall remains PENDING Task5d real Node POST route wiring and route/localDB integration, then independent integration review. The controller explicitly moved apps/web/app/api/internal/wine-evidence-document/route.ts and its new tests to5d; no fake route is exported here.

No paid provider calls, production mutation, migrations, credentials/env-file reads, feature activation or queue dispatch changes. Tests use only synthetic injected HTTP and the dedicated localhost wukong_wine_sdd database with runtime wukong_app. Existing pinned Wrangler/runtime versions remain unchanged. Read the requested TDD/implementer/Workers skills and the retrieved worker-reference.md notes; graph indexing remained untouched per approval block.

## Implemented
- Worker-only createWineEvidenceAcquisition wires actual TavilyProvider, signed document client and createWineEvidenceStore. No Node DNS/TLS/public-fetch imports in Worker acquisition/client.
- Exact HMAC body/path/timestamp; callback is derived only from configured HTTPS origin WEBSITE_FETCH_BASE_URL. Credentials, path/query/hash in the configured base are rejected. HTTP redirects are rejected; response is limited to128KiB and30seconds with streamed byte counting. Strict result schema plus exact workspace/run/source/revision/kind binding; malformed/foreign/oversized/non200 responses fail closed.
- Query generation reads only strict ProductIdentity producer/productName/known vintage/volume and fixed public wording. URLs/control punctuation in identity search terms fail closed; aliases/category/observations/notes/commercial fields never enter search queries. Full normalized identity remains in the cache key so identity distinctions are preserved.
- HTTPS/domain policy filtering and URL fragment de-duplication happen before persisted snippet creation and Node lookup. Node5a product lookup performs its own robots and pinned public fetch; denied/unavailable callbacks remain snippets and cannot authorize Extract.
- Search snippets are committed before callback lookup. Successful documents get new deterministic immutable IDs distinct from snippets. Stable IDs derive from accepted run/request coordinates; replay uses original saved snapshots and terminal provider timestamp, never a new capture time.
- Sources retain snippet/document scope, title, URL/domain, capture time, digest, truncation marker and location/span metadata. Acquired source.identity stays null: a search query is not proof of the page identity. Later exact verification owns identity attachment. Shared normalized content hashes prevent cloned/syndicated text from counting as independent.
- Extract receives1..5 distinct persisted current-run Tavily snippet IDs. Each must independently yield a ready extractEligible product callback. The batch uses only those approved final URLs; returned URLs must exactly belong to that set, including terminal replay. A single extract_1 slot spans the entire run; denied/refused sources cannot become a fallback call.
- Separate committed DB admission guards load accepted run and current listing/revision, strict immutable wineAcquisition policy, accepted wineMode and DB clock. Listing then run then credit reservation lock ordering; deadline rechecked after potentially waiting on the credit lock. Worker additionally checks time immediately before provider I/O.
- Each physical slot is begun before I/O. Matching succeeded output replays; mismatched digests, started/unknown calls and terminal calls without output never recall. An uncertain/missing-output earlier slot blocks later slots. Normalized output/credits/diagnostic finalize through one existing update. Unknown/discrepancy finalization also retains the whole reservation as unknown in the SAME outer transaction. Measured discrepancy survives even above the reserved amount. Usage can finish after cancellation/deadline because it belongs to an already committed physical call.
- Cache uses SHA256 of canonical full identity/workspace/policy/rules/allowed-domain coordinates, plus exact repository policy/rules columns. Both repository and Worker enforce seven-day original source age, including exact expiry/future rejection. Prior-run hits preserve all source fields/capture times, do not republish, and re-evaluate current reviewed authorities. Persisted acquisition evidence remains unverified; returned trust is derived read-only from the current registry. Same-run invocations follow terminal replay, avoiding a partial earlier stage cache suppressing a later requested slot.
- Fresh-run forceRefresh bypasses old cache and obtains fresh IDs/snapshot. Same-run forceRefresh is NOT permission for another paid call. Cache publication uses deterministic source-set snapshot IDs and does not republish overlapping cached sources to renew age.

## Exported Task8 API
Worker apps/worker/src/wine-evidence-acquisition.ts:
- EvidenceRequest = WineAcquisitionCoordinates & {identity:ProductIdentity;now:string;forceRefresh:boolean}. input.now is retained for the planned interface; authorization/cache freshness use DB clock, not caller time.
- EvidenceAcquisition = {sources:EvidenceSource[];status:'complete'|'partial'|'unavailable';warnings:string[]}.
- WineAcquisitionStage = {stage:'basic';slots:('basic_1'|'basic_2')[]} | {stage:'deep'} | {stage:'extract';sourceIds:string[]}.
- acquireWineEvidence(input,stage,ports):Promise<EvidenceAcquisition> for injectable tests/composition.
- createWineEvidenceAcquisition({database,tavilyApiKey,websiteFetchBaseUrl,queueSecret,fetch?,now?}) returns the callable (input,stage)=>Promise<EvidenceAcquisition>. Task8 constructs this inside its invocation from server-owned bindings; actual binding selection/Queue stage dispatch belongs toTask8.
- wineIdentityQueries(identity):[string,string] gives distinct basic queries; deep uses advanced depth with the first identity query. No caller-supplied raw query.
- wineEvidenceCacheKey(input):string returns canonical key material; acquisition hashes it to the bounded DB identityKey.
- createWineDocumentClient({baseUrl,secret,fetch?,now?}) in wine-document-client.ts returns (WineDocumentRequest)=>Promise<WineDocumentResult>.

@wukong/db exports:
- WineAcquisitionCoordinates = {workspaceId,runId,inputRevision,policyDigest,rulesVersion,allowedDomains}. policyDigest must equal accepted execution.wineAcquisition.policyVersion; domains and rules must exactly match the frozen snapshot. Mutable policy is never substituted.
- WinePhysicalCall = Omit<SearchCall,'runId'>; WineCallCompletion = existing finishSearchCall input without runId.
- WineCallAdmission = claimed | completed(record:SearchCallRecord) | blocked | unknown.
- createWineEvidenceStore(database) returns committed methods context(input), admit(input,call), finish(input,completion), authorities(input), readEvidence(input), saveEvidence(input,sources), cache(input,key), saveCache(input,key,snapshotId,sourceIds). Each resolves only after database.forWorkspace commits. No HTTP/provider I/O belongs inside their callbacks.
- repos.wineAcquisition additionally exposes authorizeAcquisition, admitAcquisitionCall, finishAcquisitionCall, implemented by the focused wine-acquisition-calls.ts guard.
- wineDeepSearchDecisionSchema is exported for the server-owned stage wrapper below.

## Accepted mode and deep decision contract (controller confirmed)
Accepted parent execution must contain wineMode:'full'|'research'|'copy'|'section'. The search guard allows only full/research; missing/copy/section fail closed. Existing strict execution.wineAcquisition snapshot from5b is unchanged. Task7 must persist wineMode during acceptance.

Advanced admission reads the SAME run's immutable succeeded verification stage. Required output wrapper:
```ts
{
  schemaVersion: 1,
  deepSearchDecision: {
    schemaVersion: 1,
    required: true,
    reasons: Array<'identity_gap' | 'core_fact_gap' | 'conflict'> //1..3
  },
  // Other versioned verification results remain Task6/8-owned.
}
```
Task8 must derive this decision from deterministic important identity/core-fact/trusted-conflict issues, not raw model needsDeepSearch or optional prose/section absence. No caller reason override is accepted by admission. Optional-only/empty/unknown reasons fail schema validation. Other verification output fields are intentionally not prescribed by5c.

Task8 basic stage may call both distinct basic slots together; deep is separate. Extract sourceIds are the persisted snippet IDs obtainable from store.readEvidence(input), not newly acquired document IDs. Each stage returns its evidence set; Task8 persists/assembles the stage pool and applies identity/claim verification. complete describes successful acquisition of that requested stage, not overall listing readiness. Cache records preserve the original run/source provenance; Task8 must retain returned capture times if copying reused sources into its run evidence pool.

## TDD and verification evidence
RED1 client: pnpm.cmd --filter @wukong/worker exec vitest run src/wine-document-client.test.ts failed missing module. GREEN11/11 after bounded signed implementation.
RED2 DB guard: pnpm.cmd exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/wine-acquisition-calls.integration.test.ts failed5/5: createWineEvidenceStore not a function. GREEN5/5. One initial fixture attempted to mutate immutable execution; corrected by creating the expired snapshot at acceptance, not relaxing the guard.
RED3 acquisition: pnpm.cmd --filter @wukong/worker exec vitest run src/wine-evidence-acquisition.test.ts failed missing module. GREEN10/10. A shared-array test harness exposed duplicate local accumulation; acquisition now snapshots the returned array before adding new sources.
RED4 missing terminal output: DB call suite1failed/6passed, basic_2 incorrectly claimed after succeeded basic_1 with null output. GREEN after blocking output-null prior calls.
RED5 malformed callback: Worker suite1failed/15passed, an oversized directly injected result became document evidence. GREEN after strict result-schema validation inside acquisition too.
RED6 runtime factory: integration1failed/1passed, factory missing. GREEN with actual provider/client/store construction.
RED7 reservation-lock deadline: DB suite1failed/7passed, slot claimed after waiting beyond deadline on reservation lock. GREEN after acquiring that lock before the final DB clock check, plus Worker pre-I/O time check.

Final checks:
- pnpm.cmd --filter @wukong/worker exec vitest run src/wine-evidence-acquisition.test.ts src/wine-document-client.test.ts:2files29/29 PASS.
- pnpm.cmd exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/wine-acquisition.integration.test.ts packages/db/src/repositories/wine-acquisition-calls.integration.test.ts apps/worker/src/wine-evidence-acquisition.integration.test.ts:3files34/34 PASS. This includes5b24 + newguard8 + actualWorkerfactory2.
- Final added mode/credit ceiling/optional-decision coverage: focused wine-acquisition-calls.integration.test.ts10/10 PASS. Final affected integration count is36 across the same3files; the full3file command was not repeated after only these2 additional tests.
- pnpm.cmd --filter @wukong/web exec vitest run lib/website/public-fetch.test.ts lib/website/robots-policy.test.ts lib/website/extract-document.test.ts lib/website/wine-document-service.test.ts lib/website/wine-document-handler.test.ts lib/website/public-fetch.integration.test.ts:6files133/133 PASS. Local TLS safety fixture only, no external fetch.
- pnpm.cmd --filter @wukong/db build:PASS.
- pnpm.cmd --filter @wukong/db typecheck:PASS.
- pnpm.cmd --filter @wukong/worker typecheck:PASS.
- pnpm.cmd --filter @wukong/worker build:PASS, wrangler4.112.0 dry-run. Existing pipeline paid operations and SHOPLINE publication stay disabled; no deployment.
- git diff --check:PASS, only normal Windows LF/CRLF notices.

## Requirement coverage / remaining gates
- Exact expiry/full-key/tenant/policy/vintage/future/force-refresh: Worker named tests plus existing5b24 integration tests. Source freshness never renewed.
- Cloned content, URL de-dup, domain filtering, unverified official source, snippet truncation, private URL query refusal: new Worker unit tests.
- Robots denial and no Extract fallback, source-ID injection, successful one-Extract replay, wrong result URL provenance, unknown usage and measured discrepancy stop: new Worker unit tests.
- Committed admission before actual synthetic HTTP, committed snippet before callback, immutable evidence/cache replay: actual Worker factory/localDB integration.
- Started/unknown/missing output/digest mismatch/cancellation/revision/deadline after both listing and credit locks/deep justification/mode/ceilings: new DB guard integration.
- Missing/expired signatures, mutated bodies, foreign/stale source coordinates, missing Product JSON-LD fallback, robots/access refusal and private-address redirect safety: unchanged5a service/handler/public-fetch suites reverified133/133. New actual POST route tests still belong to5d.
- Production Tavily credentials/allowance, production migration rehearsal/activation, Task8Queue runtime, Task13env manifests/browser harness, real merchant acceptance: untouched release/integration gates.

## Files and self-review
New Worker wine-document-client.ts/.test.ts, wine-evidence-acquisition.ts/.test.ts/.integration.test.ts. New DB repositories/wine-acquisition-calls.ts/.integration.test.ts; only two-line composition/export addition to existing wine-acquisition.ts/index.ts. This report.
Self-review fixed missing-output admission, directly malformed callback, replay array aliasing, and deadline after reservation-lock wait. All physical failures conservatively retain unknown cost holds; no automatic provider retry/reclaim exists. No known failing checks. Cache publication still respects the existing200KB aggregate repository bound; exceptionally large aggregate evidence is rejected by that existing bound rather than relaxing storage constraints. Acquisition/ledger code remains a focused boundary; full queue recovery is intentionally deferred. Task5 overall is not yet complete.
