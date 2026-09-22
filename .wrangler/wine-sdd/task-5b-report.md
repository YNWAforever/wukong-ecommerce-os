# Task 5b report: durable acquisition storage

## Outcome

DONE. Started from fa1167e on codex/tavily-wine-enrichment-design in worktrees/astra6-recovery. No provider/network implementation, actual POST route, paid calls, production mutation, credentials or env-file reads. Task5 overall remains incomplete until5c runtime/acquisition wiring and acceptance checks.

New additive migration0042 is intentional:0041 was already applied to the dedicated rehearsal database, so a separate migration upgrades it through ordinary migrate without modifying applied0041. No historical evidence or accepted execution rows rewritten. Replay0042 twice preserves row counts and runtime readiness. Include0041+0042 in the later migration rehearsal/release gate.

## Exact accepted execution snapshot for5c/7/8

@wukong/jobs exports wineAcquisitionPolicySchema and WineAcquisitionPolicy. The accepted server-owned listing_pipeline_runs.execution extends the existing object:

```ts
{
  schemaVersion: 1,
  flowVersion: "wine-enrichment-v1",
  wineAcquisition: {
    schemaVersion: 1,
    deadlineAt: string, // ISO UTC; > persisted created_at, <= created_at +15 minutes
    policyVersion: string, // nonempty, max200
    rulesVersion: string, // nonempty, max200
    allowedDomains: string[] // 1..100 exact lowercase DNS domains; no URL/port/wildcard
  },
  // existing execution fields/reservations remain owned by acceptance
}
```

The wineAcquisition object is strict; no unknown keys. Parent execution remains extensible for existing candidate/reservation fields. acceptedAt is exclusively persisted run.created_at. Document repository requires parent schemaVersion1, exact flow marker, queued/running state, current_run_id, listing/run/request inputRevision equality, source in exact workspace/run/source coordinate, HTTPS exact allowed hostname without credentials/port, and database time before deadline. It locks listing then run, reads clock_timestamp AFTER locks, and repeats deadline in insert/update predicates. Mutable workspace policy is never substituted for accepted coordinates. No authority registry decisions are cached as fresh authorization; callers must re-evaluate those.

## Exports / service transaction boundary

@wukong/db:

- WineDocumentContext: workspaceId, runId, source:EvidenceSource, inputRevision, currentInputRevision, currentRunId:string|null, flowVersion, executionState, acceptedAt, deadlineAt, allowedDomains.
- WineDocumentClaim: {state:'stale'} | {state:'unknown'} | {state:'completed',result:WineDocumentResult} | {state:'claimed',context:WineDocumentContext}.
- repos.wineAcquisition.claimDocument(input:WineDocumentRequest):Promise<WineDocumentClaim>.
- repos.wineAcquisition.finishDocument(input:WineDocumentRequest,result:WineDocumentResult):Promise<boolean>.
- createWineDocumentStore(db:Pick<Database,'forWorkspace'>) returns structural WineDocumentStore with claim(input,now) and finish(input,result,now). Both await the OUTER forWorkspace transaction before returning; injected now is ignored in favor of DB time. This is the callback adapter for5c: use this factory, and never perform network I/O inside a workspace transaction.

claimDocument key is workspace/run/source/kind, with immutable inputRevision. Existing started claim is unknown forever; completed replay undergoes the same current-operation/deadline/source checks. Invalid terminal payload replays unknown, never reclaims. Finish revalidates coordinates, accepted policy and result binding; future capture timestamps cannot commit. Result can have an allowed final redirect URL; service remains responsible for pinned fetch/robots checks. Terminal result cannot be overwritten. SQL guard freezes coordinates/createdAt and permits only started->completed; terminal JSON binds workspace/run/source/kind/revision. Result schema M1 now forbids any retained text/spans for denied/unavailable or robots outcomes.

## Search replay contract

@wukong/jobs exports wineSearchOutputSchema/WineSearchOutput:

```ts
{schemaVersion:1, results:Array<{url:string,title:string,content:string,truncated:boolean}>, requestId:string|null}
```

At most5 results; HTTPS credential-free URL max2048, title max500, content max16000. Truncated content must end in newline+[TRUNCATED]. No rawContent/raw provider body/query field. Safe requestId is max200 and restricted to alphanumeric/underscore/dot/colon/hyphen.5c maps provider response into these normalized fields and truncates before persistence.

wineSearchDiagnosticSchema/WineSearchDiagnostic:

```ts
{schemaVersion:1,code:'rejected'|'rate_limited'|'invalid_output'|'outcome_unknown'|'cost_discrepancy',requestId:string|null,measuredCredits:number|null,reservedCredits:1|2,httpStatus:number|null}
```

Numeric bounds and strict keys reject free-form provider messages. Discrepancy keeps measuredCredits even when it exceeds reservedCredits; actual call credits remain null/status unknown, preserving the unknown reservation hold. Diagnostic reservedCredits must match the slot maximum.

repos.wineEnrichment.finishSearchCall extends the existing input with optional output:WineSearchOutput and diagnostic:WineSearchDiagnostic. Status/credits/output/diagnostic update in ONE SQL statement from matching started state only. Output allowed only on succeeded; diagnostic allowed only on failed/unknown; cost_discrepancy requires unknown. Existing measured credit checks are unchanged.

repos.wineEnrichment.readSearchCall(runId,slot):Promise<SearchCallRecord|null>; SearchCallRecord exported from@wukong/db includes existing runId/slot/maximumCredits/requestDigest plus status,credits,output,diagnostic,updatedAt. Missing=>null; started+null output means UNKNOWN physical outcome, never issue again. Existing terminal rows with null output remain terminal without replayable content; beginSearchCall stays false. Optional output preserves those historical/no-output records; caller must not infer permission to re-call from a missing response.

## Immutable cache

- WineCacheKey = {identityKey:string(max500),policyVersion:string(max200),rulesVersion:string(max200)}, all nonempty.5c computes full stable identity key; repository matches all three exactly plus workspace.
- repos.wineAcquisition.saveCacheSnapshot({snapshotId:uuid,runId:uuid,...WineCacheKey,sourceIds:uuid[]}):Promise<WineCacheSnapshot>.
- readCacheSnapshot(key:WineCacheKey):Promise<WineCacheSnapshot|null>.
- WineCacheSnapshot = {...WineCacheKey,snapshotId,runId,capturedAt,payload:{schemaVersion:1,sources:EvidenceSource[]}}.

Writes load existing immutable evidence by exact workspace/run/source IDs; callers cannot pass replacement source JSON. Only1..20 distinct bounded, nonempty successful web snippet/document sources accepted; metadata must pass EvidenceSource validation, URL/domain binding, no credentials, max16000 excerpt/max500 title/max2048 URL and aggregate JSON bound. Snapshot sources retain provenance and original source capturedAt. Snapshot capturedAt is DB clock at first insert. Replay same snapshot/key/run/content returns original capturedAt unchanged; conflicting replay throws. Workspace lock serializes cache writes; a new snapshot cannot reuse a source ID already cached anywhere in that workspace. Force refresh must create fresh evidence IDs and a fresh snapshot ID. Cache hit use should preserve the original snapshot, not write a renewed one.

Lookup uses database clock and strict capturedAt > currentTime - interval7days plus capturedAt <= currentTime; equality expires. Same key/latest unexpired snapshot returned deterministically. Tenant/key isolation and immutable guards protect history. Caller still applies current revocations, registry policy and identity acceptance before use. No automatic cache pruning or provider authorization is introduced.

## SQL / readiness / audit

wine_document_requests and wine_evidence_cache have composite tenant FKs, forced RLS, exact workspace policy, runtime grants without DELETE, immutable/terminal triggers and primary keys. Cache has exact full-key/time lookup and workspace/run FK indexes. Search output/diagnostic are nullable bounded version1 objects with status coupling; old rows preserved. SQL version checks use IS NOT DISTINCT FROM numeric JSON1, retaining SQL NULL defenses.

inspectWineEnrichmentCompatibility version is wine-enrichment-0042-v1. Prior0041 exact policy/role/grant/trigger/constraint safeguards remain. Added exact canonical definitions for all new table constraints and output check, exact new indexes, six columns, and two tables. Audit inventory and Drizzle schema include both new tables; search Drizzle declarations include output/diagnostic. Added DB->jobs workspace dependency; no DB->Web import or cycle.

## TDD evidence

All integration runs use only explicit TEST_DATABASE_URL / TEST_DATABASE_ADMIN_URL for127.0.0.1:54329/wukong_wine_sdd from task-3-environment.md. Runtime is non-owner wukong_app. Owner only applies local migrations and synthetic fixture/drift setup, restoring every drift in finally. No env files sourced.

RED1: pnpm.cmd --filter @wukong/jobs test =>3 failures (denied, unavailable and robots text/spans incorrectly accepted).
GREEN1: same =>20/20 after shared schema refinement; final added strict policy/output/diagnostic tests =>28/28 across5files.

RED2: pnpm.cmd exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/wine-acquisition.integration.test.ts =>6/6 failures, missing wineAcquisition/readSearchCall APIs.
GREEN2: same =>6/6 after transactional repositories, schema and0042.

RED3: acquisition suite =>missing Drizzle export; after exports, separate RED showed ready:true after UPDATE grant revoke.
GREEN3:9/9 after exact readiness; includes policy and check(true) constraint drift, SQL NULL/foreign source/RLS probes, literal migration replay twice.

RED4: acquisition suite =>new snapshot incorrectly accepted previously cached source IDs (1 failed/11 passed).
GREEN4:12/12 after workspace-serialized fresh-source guard. Additional deadline test holds listing lock beyond deadline, proving PostgreSQL clock rather than caller/transaction-start time.

RED5: acquisition suite =>ready:true after dropping cache lookup index (1 failed/14 passed).
GREEN5/final integration:6files/63tests PASS with exact index readiness. Command:
`pnpm.cmd exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/wine-acquisition.integration.test.ts packages/db/src/repositories/wine-enrichment.integration.test.ts packages/db/src/repositories/search-budget-reservations.integration.test.ts packages/db/src/repositories/listing-operations.integration.test.ts packages/db/src/repositories/ai-runs.integration.test.ts packages/db/src/cli/audit-verify.integration.test.ts`
Acquisition suite15tests includes independent connection visibility after createWineDocumentStore claim returns, terminal-operation rejection, raw output/status atomicity, duplicate/parallel claims, stale/current revision/run, malformed policy/expired deadline/foreign source, terminal immutability, discrepancy unknown hold, exact cache expiry/tenant/key and source refresh.

Other verification:

- pnpm.cmd --filter @wukong/db test:17files/106tests PASS.
- pnpm.cmd --filter @wukong/db typecheck and build:PASS.
- pnpm.cmd --filter @wukong/jobs test:5files/28tests PASS.
- pnpm.cmd --filter @wukong/jobs typecheck and build:PASS.
- Existing callback service+handler regression: final result appended below.
- git diff --check:PASS (only ordinary Windows LF/CRLF conversion notices).
- Offline pnpm install --ignore-scripts --frozen-lockfile:PASS; workspace dependency linked without provider calls.

## Self-review and limitations

No known failing checks. Added deadline predicates at actual insert/update after self-review, and exported SearchCallRecord for integration. Cache publication serializes per workspace and checks prior source IDs in snapshot JSON; bounded acquisition volume makes this appropriate now, but very large historical cache inventories could benefit from a dedicated source-membership index/table later. No migration cleanup or redesign added. SQL enforces tenant/immutability/status/version/size/binding boundaries; complete semantic payload validation remains shared runtime schemas. Unknown holds never cleared.

5c must use committed factory for callback, map normalized/truncated provider output, interpret started or legacy output-less terminal rows conservatively, persist fresh source IDs for successful documents/force refresh, apply current source registry/revocations, and wire actual Worker/Node POST.7/8 acceptance must set immutable coordinates above using database-compatible acceptance/deadline time; this slice intentionally does not change acceptance orchestration.

Final callback regression: pnpm.cmd --filter @wukong/web exec vitest run lib/website/wine-document-service.test.ts lib/website/wine-document-handler.test.ts =>2files/27tests PASS. Final DB unit/typecheck/build rerun also PASS after all changes.

## Independent review fix: anchor cache freshness to source capture (2026-09-16)

Important review finding corrected. This section supersedes the earlier statement that cache capturedAt is DB time at publication: it is now the OLDEST retained EvidenceSource.capturedAt. Seven-day expiry is measured from that source capture, regardless of publication time or new source IDs. Source payloads/provenance are still immutable.

Implementation:

- Repository computes the minimum source capture; first publication rejects any future source or any source at/beyond7days using the current PostgreSQL clock. Mixed-age snapshots expire with the oldest source. Copying an8dayold source to fresh IDs does not renew it.
- Exact same valid snapshot replay returns the original historical capturedAt, including after expiry; readCacheSnapshot remains the freshness gate and cannot return expired snapshots. Conflicting or legacy publication-time snapshots fail closed; no timestamp rewriting/backfill.
  -0042 now drops the publication-time captured_at default. SQL BEFORE INSERT guard independently checks the oldest-source timestamp binding, rejects expired/future members using clock_timestamp, and requires each retained payload to exactly equal a persisted evidence record in the same workspace/run. The immutable UPDATE/DELETE guard remains.
- Read lookup verifies captured_at equals the oldest source timestamp and no source is future-dated, so earlier local publication-time snapshots cannot become fresh through lookup. Existing historical rows are left untouched.
- Readiness checks the exact enabled BEFORE INSERT trigger/function binding and captured_at timestamptz/NOT NULL/no-default definition. Drizzle drops the default. Shared jobs schemas are unchanged.
- The acquisition test beforeAll explicitly replays unpublished0042 after normal migrate so this already-migrated dedicated rehearsalDB receives the additive review refinement. Production migration/rehearsal remains a later gate.

RED source freshness:
`pnpm.cmd exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/wine-acquisition.integration.test.ts`
=>8failed/15passed. Reproduced first publication of8dayold/exact7day/future sources, mixed-age publication timestamp, future member mixed with a valid source, copied old evidence with fresh IDs, source-age expiry after publication, and directSQL publication-time renewal.
GREEN intermediate: same command =>23/23PASS after repository/SQL fixes.
RED readiness: same command =>1failed/23passed because disabled source-time guard still reported ready:true.
Final GREEN: same command =>1file/24testsPASS after readiness refinement, output clean. This includes the original acquisition regressions and literal0042 replay twice.
`pnpm.cmd --filter @wukong/db typecheck` =>PASS.
`pnpm.cmd --filter @wukong/db build` =>PASS.
`git diff --check` =>PASS (normal Windows LF/CRLF notices only).
All DB operations used the explicit localhost test URLs from task-3-environment.md. No production calls, shared-schema changes, or broad regression reruns. No outstanding findings known in this fix.
