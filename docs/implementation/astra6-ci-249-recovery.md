# CI 249 product-shot recovery

## Cause and correction

The failed Chromium trace from GitHub Actions run 35045631423 showed a successful image-state read for a legacy listing with an active version and `inputRevision: 0`. Selecting a source sent that observed zero to the product-shot endpoint, which returned HTTP 400 `invalid_request` before dispatch. The UI then had no final image to display.

Request, prepare and approval now accept nonnegative revision metadata for versioned listings. Exact-version conflict checks still apply. Request/prepare without an active version continue to require a positive saved input revision, so zero cannot bypass the saved-input check.

Three route regressions first reproduced the 400 response, then passed after the validator change. Additional checks retain rejection of missing, zero, negative and fractional revisions on unversioned actions.

The connected product-shot test also now enters SKU, price and stock through the working editor, saves them, and promotes the saved revision before approval. AI does not own those commercial fields. Its post-withdrawal export assertion expects the listing-level `approval_required` response, matching the approval-first delivery gate.

## Verification

- Product-shot route, request, service and component tests: 75 passed.
- Product-shot no-version, route and publication integration tests: 18 passed against the isolated local validation database and object store.
- Web typecheck passed.
- Full compiled-server Chromium product-shot suite: 4/4 passed (2.3 minutes), covering English and Traditional Chinese selection, replacement, acceptance, publication/privacy, definitive failure and unknown-outcome retries. The browser harness also completed the production build.

All provider behavior in the local browser suite is synthetic; no paid provider or real merchant write was used. Production and merchant gates in the consolidated evidence remain unchanged.

## Follow-up from the next CI run

Run 35048872124 passed the product-shot browser step on 7e070ec, then exposed two failures in the broader Queue suite. The batch test expected HTTP 200 for an accepted advance command (the endpoint returns 202), and repeated fixture setup tried to delete a workspace referenced by immutable dispatch history.

Each real-stack fixture now creates fresh tenant identities and retains previous audit/operation records. The batch test asserts the exact accepted status. With that assertion corrected, the connected journey reproduced a production regression: imported drafts without an input snapshot were skipped during batch admission. Admission now initializes their first immutable snapshot under the listing lock, seeds validated imported commercial facts, and preserves existing operator corrections and review versions. Status is rechecked under the lock before accepting work.

Verification of this follow-up:

- New real-import regression cases plus batch control/exact-run integration tests: 6 passed. The new missing-snapshot case failed before the service change.
- Batch service and advance route unit tests: 37 passed.
- Web typecheck passed.
- Real-consumer 50-item cohort: passed.
- Full compiled-server Wrangler Queue browser suite: 30 passed, 2 skipped on Windows (the guarded alternate-auth case and POSIX process-group case), in 3.6 minutes.
- Post-suite pilot audit: 0 missing actions and 0 accessible foreign records, confirming that later fixture setup preserves the earlier pilot evidence.
- Independent review found no actionable P1/P2 issue.

Remote CI for the final follow-up commit remains a separate check; these counts describe local verification. Production and merchant acceptance remain unverified.
