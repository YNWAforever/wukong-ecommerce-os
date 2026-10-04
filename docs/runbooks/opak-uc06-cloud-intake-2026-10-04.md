# Original UC06 cloud intake — 2026-10-04 HKT

The original UC06 synthetic criterion passes on the existing protected staging Preview: one20-product workbook enters readonly references, the operator checks the saved synthetic store and actual reference identity, then the same original workbook creates20 source-bound editable drafts. All20 Product IDs, leading-zero SKUs, store IDs and source receipts match; no silent mismatch. Same-byte UI replay returns the same receipt and creates0 drafts. This closes the original synthetic intake case; merchant API health, human AI quality, employee minutes and real-store delivery remain separate gates.

## Actual behavior and evidence

- Actual operator password/session/workspace and non-superuser/non-bypass runtime checked on Web2b8d77be / READYdpl_J3hvtmygPraTyp2XakUM9k2TXXH6, application label source5f9eddba. Reviewed Workerfcf96cda remains100%, separately source593c5283. No new Web or Worker deployment.
- The normal UI selects Reference only → Workbook, imports20 readonly records, shows20 catalog rows and keeps every canExport=false. The maintenance UI shows the existing synthetic.invalid store, uses the owned reference Product ID hint and refuses Start import until both identity and current-store/export confirmations are checked. This checks saved configuration and synthetic operator attestation; it does not certify live API access or merchant-origin evidence.
- Normal maintenance POST201 creates20 drafts, invalidates0 approvals and displays the source receipt. Independent PostgreSQL reads verify a unique exact Product ID/SKU/store/listing/source mapping for each20. All71 logical source-column values per row match1,420 comparisons, including protected ID/SKU/price/stock/barcode and lexical leading zeros. XLSX omits empty trailing physical cells;20 existing padding warnings remain visible and missing slots normalize to blank. No zero-warning claim.
- UI replay POST200 returns the same sourceImportId, replayed=true, alreadyImportedProducts20 and createdDrafts0. All eleven domain values match immediately before/after replay; neither source freshness nor working inputs are renewed.
- Read-only continuation uses the same original20 drafts: bound catalog has exactly20 rows, every actual detail page has editable Merchant SKU/Save draft, input revision1/no active version/no pipeline run, expected SKU/price128.5/stock6 and the original source receipt. Every new listing has an audit attributed to the real operator. Eleven domain values remain identical across this read-only continuation; AI records stay56, publish0 and batch count unchanged. No generation, edit-save, approval, export, Queue admission or merchant write.
- Four synthetic screenshots visually reviewed outside Git: readonly20/reference import receipt/bound20/editable detail. Original customer evidence, workbooks, auth/config/share URLs, raw errors and model content remain outside Git/public PR.

## Commands, failures and classifications

| Outside-Git command               | Actual result                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| node uc06-intake-v1/run.mjs       | Failed before import;9 successful prechecks,103.431s; helper omitted Workbook tab                                                           |
| node uc06-intake-v2/run.mjs       | Failed before import;9 successful prechecks,71.819s; tab did not yet reach selected state after early click                                 |
| node uc06-intake-v3/run.mjs       | Failed after20 successful import/replay checks,145.647s; helper sent unsupported platform filter; API correctly returned400 invalid_request |
| node uc06-intake-v4/run.mjs       | Same-cohort continuation38/38,173.011s; correct bound filter;0 repeat imports/new drafts                                                    |
| node final-uc06-hold-readback.mjs | Read-only 2026-10-04T01:02:14.530Z: exactfcf100/source593/five secret names/no probe vars/publicHEAD404/compute disabled-idle0.25CU         |

Disposition: application behavior already-fixed; remaining evidence scope changed to the exact original CSV criterion. The three helper failures stay failed; no source fix, permission relaxation or successful whole-command claim is invented. The successful continuation composes with the same v3 cohort's executed import/replay evidence. v3's full pre-import snapshot was not persisted by the failed helper, so no complete byte-hash continuity across that original import is asserted. The replay and read-only continuation equality checks are separately scoped and retained.

All four independent8-minute watchdogs stop normally; each window acknowledges logout/account401, both Queue pauses, closed ingress/no-cron and compute disable. Fresh metadata readback verifies idle/disabled0.25CU/public404; Queue/cron flags are acknowledgement-only. No migration/new app env/dependency/credential/paidAI/email/production mutation. Actual billing remains unmeasured under the standingUS$5 cap.

## Current release and compatible hold

Only UC06 advances:14PASS/3PARTIAL/13BLOCKED/all30. UC03/24/29 remain partial: original authenticated production500 and full cloud budget/unknown simulation are not completed. UC09–20 paid/human twelve-case score>=90/hardfail0 and UC30 synthetic cloud load/matched human20-item completion minutes remain blocked. Original UC24 explicitly permits simulated response loss; no paid-call authorization is needed to implement a properly isolated fake cost harness, but a zero-cost fake generation alone does not verify positive reservation/over-budget gates.

Prior exact evidence head e52ba24d CI37158090454 attempt2 SUCCESS43 and PR121–126 green/CLEAN were rechecked at this turn's start. Its first admin-SPA invite-field timeout remains unconfirmed and retained, with no source/test/timeout weakening. This new documentation-only head requires its own checks; final exact-head receipt/publication/archive stays outside Git to avoid recursive evidence-only commits.

Production0046/schema/safe-role/cache/effective Web/original500, exact first-operation authority, named recovery owner/confirmed recoverable point and merchant first-write/reconciled5→20→100 gates remain open. Main auto-deploy merge is held; PR120 remains a nongreen draft. Saved store configuration is not a real merchant connection pass.

Hold/rollback retains reviewed Worker/read-only R2 credentials/native POST/mail simulator guard, every source/row/version/input/audit/candidate/reservation/unknown record and Queue/DLQ. No database downmigration or purging. The new20 drafts stay unstarted and source-bound; stopping compute prevents new work without erasing replay evidence.

[Allowlisted receipt](./opak-uc06-cloud-intake-2026-10-04.json) · [All30 cloud cases](./opak-cloud-uat-results-2026-10-03.csv) · [Concrete production repair scope](./opak-production-repair-proposal-2026-10-03.md).
