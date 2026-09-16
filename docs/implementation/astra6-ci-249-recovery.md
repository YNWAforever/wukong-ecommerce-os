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
