# Astra6 T04–T05 and working-copy recovery implementation

Date: 2026-09-16 (Hong Kong). Shared worktree: `worktrees/astra6-recovery`; branch `codex/astra6-recovery`. Changes are uncommitted for the parent integrator.

## Implemented contracts

- `packages/core/src/working-listing.ts` defines a distinct incomplete working document, typed allowed changes, nullable commercial facts, independently empty bilingual copy, source selections and field ownership/locks. Zero is retained. Only vintage supports explicit not-applicable. Automatic merge protects operator-owned values even without locks and always excludes AI-supplied SKU, selling price and stock.
- `0028_listing_input_revisions.sql` adds `listing_drafts.input_revision` (legacy default 0) and immutable workspace-scoped input history. Composite listing/version foreign keys, revision and correction-operation uniqueness, RLS, SELECT/INSERT grants, update/delete revocation and an immutable-row trigger preserve history. Tenant audit inventory includes the table.
- `repos.listingInputs`: `getCurrent`, `getRevision`, `getByOperationKey`, explicit `initialize`, and `save`. Initialization is never performed by GET. Existing records are protected conservatively and marked `provenanceUncertain`; supplied initial manual values are operator-owned.
- Saving locks the listing and compares **both** expected revision and nullable base version. Correction-key replay occurs before CAS and returns the original committed revision; changed request digest conflicts. Save and audit share the caller transaction. Sources resolve within the current workspace, cannot move from another listing, and must have finalized metadata. Selected sources retain array order, role, analyse/reference-only use and at most one image hero; removal deselects without deleting originals or older snapshots. Ten images plus one PDF are supported; note length is 5,000.
- Saving supersedes active v2 runs in the same transaction, retaining run history and input snapshots. This requires the parent's additive 0029 operation migration. It does not settle or erase provider accounting.
- `PATCH /api/listings/:id/inputs`: strict typed payload, server session/role/workspace, stable correction key, save-only 200 and durable save-and-process 202. Save-and-process calls the parent's acceptance service inside the transaction and dispatches through the parent's helper after commit. Admission failure rolls back the correction, as technical spec §4 requires; the UI keeps edits and offers save-only.
- Review PUT accepts explicit null base only with expected input revision, persists manual ownership/revision, rescans compliance, and calls `promoteManual` for a real first reviewable version. It never calls an AI provider. Existing-version saves retain the old exact-version behavior and now fence human changes with a new input revision. Real source-image ownership is validated. Legacy callers without input revision remain compatible only while the listing is still revision 0.
- `save_inputs` and `submit_manual` are narrow audited workflow actions. Publishing refuses input mutation; approved/published/publish-failed corrections reopen editorial review and emit invalidation audit while retaining history.

## A12 selected candidate adoption

- New scoped `GET /api/listings/:id/runs/:runId` returns the immutable attempt identity and size-bounded, validated candidate differences; responses are no-store.
- New `POST .../runs/:runId/adopt` accepts only operation key, expected revision, nullable base and selected allowlisted field paths. Candidate values/evidence are loaded server-side. No browser-supplied candidate values or provenance are accepted.
- Candidate compatibility requires the same note and ordered source selection/digests/roles/use plus unchanged product-identity fields. Source or identity corrections invalidate compatibility; unrelated manual copy edits can be deliberately replaced. Locked fields require a separate saved unlock. Commercial merchant values are not adopted from AI.
- Selection writes an immutable input revision, server-derived field `candidateRunId`, source input revision and stable references into the stored candidate evidence. It audits selected field paths and identifiers only. Owner remains operator so later automatic merging preserves the accepted human decision. Replayed adoption has no duplicate effect; competing requests conflict under CAS.
- Legacy plain-content candidates are read with empty evidence. Missing evidence is explicitly labelled as unverified; adoption is not approval, independent verification or export readiness. The parent's Worker stores `{content,evidence}` and owns late-candidate persistence/fencing.

## Connected recovery editor

`apps/web/components/listing-working-copy.tsx` is wired by the parent into the no-version review screen. It provides:

- Empty/partial facts, bilingual title/description/SEO, non-vintage and field locks.
- Note and source previews; roles, reference-only use, hero, ordering and deselection.
- Source upload through the existing browser helper, immediate File[] snapshot, retained finalized files and resumable stored-key finalize retry.
- Save-only without AI, save-and-process, and manual review promotion after saving all source/note changes. Dirty fields survive background polling. Known stale responses preserve local edits and offer an explicit discard/reload action.
- Stable correction operation key across a lost response; safe bilingual guidance for failed save/processing/upload.
- Candidate load/compare/select/adopt using the exact displayed run and input/base version. Unsaved local edits prevent adoption. Missing field evidence remains visible.

## Verification

Executed against source in this shared worktree, using synthetic fixtures only:

| Check                                                                                          | Result                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core working-copy + workflow unit suites                                                       | 22/22 passed                                                                                                                                                                                           |
| Inputs route + existing review route + working-copy component + candidate compatibility suites | 21/21 passed                                                                                                                                                                                           |
| Real Postgres inputs, manual-promotion and candidate-adoption suites                           | 9/9 passed                                                                                                                                                                                             |
| Core and DB package builds                                                                     | Passed                                                                                                                                                                                                 |
| Web TypeScript                                                                                 | Blocked by concurrent sibling changes: intake test tuple typing, unresolved web @wukong/ai dependency, Worker settle callback return type. No child-owned diagnostics; parent final gate authoritative |

Integration database was the existing local disposable service at `localhost:54329`; app role `wukong_app` used workspace RLS. Tests reran additive migrations and used unique synthetic workspaces. No production mutation, live merchant fixture, paid model call or SHOPLINE write occurred.

Observed negative assertions include: stale nullable base; reused key with different digest; concurrent correction (one winner); foreign listing/source/run; source steal refusal; immutable prior source snapshots; source-only save; superseded run retention; manual first version and stale first-version resubmit; locked adoption; concurrent adoption; viewer denial; and exactly replayed adopted result. Browser-component tests cover lost-response key reuse, dirty note retention during new props, viewer controls, manual-save payload and selected-path adoption without client values.

## Evidence limits / release notes

- A10–A12/A23 have focused unit and real-database coverage. Happy-dom component interactions are not native Chromium, reload/re-login, full responsive/accessibility or real-photo acceptance evidence.
- End-to-end late-provider completion/checkpoint and billing fences are owned by the parent Worker implementation and require its tests; this report does not turn helper tests into queue-runtime evidence.
- Finalized source digests are the registered asset metadata (`sha256` or `clientSha256`); existing finalization can explicitly have `hashVerified:false`. This work does not claim an independent byte-hash/decoded-media verification that the existing finalizer did not perform.
- Candidate matching is deliberately conservative: changed source selection/note/identity requires a fresh attempt. No automatic external research or independent claim verification is added.
- G0/G1 live deployment, authorized real-photo accuracy, native browser, and merchant evidence remain the parent release gates. No production, preview or merchant acceptance is claimed here.
- Rollout requires additive 0028 and 0029 plus compatible Worker before new producers. Rollback should stop new producers and preserve revisions, candidates, run history and stored assets; do not drop immutable input history to accommodate old code.

## Integration correctness follow-up and bounded recovery (2026-09-16)

- Legacy GET now derives ordered originals for revision-zero working copies and excludes generated cutouts/candidates; reads remain mutation-free. Existing generated review edits send the observed input revision in PUT, including stale-save fencing.
- Automatic extraction evidence is filtered for all operator-owned/locked values and commercial facts. An AI excerpt cannot be attached to an operator-preserved value merely because extraction proposed the same field.
- Conservative cost ceiling is now a pure core export, with the existing AI export retained. Explicit numeric validation accepts real provider-policy objects without treating provider/model strings as numeric inputs.
- Migration 0032 adds bounded, read-only cross-workspace discovery of queued/running operations abandoned for at least 900 seconds. Workspace transactions lock the listing/run/steps, recheck leases with a 360-second grace, terminalize once, revoke stale step leases, audit, and retain unknown spend holds. Exhausted outbox identity and attempts remain intact. No provider call or paid requeue occurs. The legacy sweeper excludes revisioned drafts.
- Database.inspectListingRecoveryCompatibility reads base 0023-0027 capabilities plus recovery tables/columns, forced RLS, read grants, recovery function privileges and 0033 guards. Create/process/inputs/review fail with safe 503 listing_recovery_setup_required before writes if unavailable. Signed Worker health reports listingRecoveryReady; unauthenticated health has no catalog detail. Production migrations remain a separate approval gate.

Latest verification: DB build, Worker typecheck and web typecheck passed. Local Postgres recovery suite passed 4/4; Worker sweeper/health suites passed 32/32 before the additional explicit readiness assertion; editor/readiness suites passed 33/33. Prior source-only and candidate tests remain as recorded above. No production deployment, production migration, paid inference or merchant publication was performed. The schema check is a catalog capability check, not real-photo/provider/merchant readiness evidence.

Partial-extraction follow-up: stored stage:extract candidates now offer only populated factual fields, excluding commercial facts, empty values and localized copy/tags. Failed extraction candidates can be explicitly adopted with the same source/identity compatibility, lock and revision/base fences; blank copy cannot overwrite human text. Focused UI + candidate service tests passed 10/10, real Postgres adoption tests passed 3/3 including failed extraction fact adoption. Final Worker sweeper/health tests passed 33/33; core working-copy/workflow/cost suites passed 26/26.
Latest web typecheck rerun during concurrent Next build encountered only TS6053 for removed/regenerated .next/types/cache-life.d.ts, routes.d.ts and validator.ts. The earlier web typecheck passed after recovery gate integration; a stable final parent build/typecheck remains authoritative. Worker typecheck passed after all follow-ups.
