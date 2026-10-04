# Opak current-content batch maintenance

Select specific owned products in Catalog. Selection survives pagination and filters; the count outside the current filter stays visible. Clear selection explicitly before starting different work. Readonly website/workbook references are not maintenance targets.

Choose only the desired content fields, a wave size from 1 to 5 and an approved budget. Preview lists selected, eligible and skipped counts, fields, cost bound and expiry. Unknown pricing is displayed as unknown. Preview does not call AI or enqueue work. Confirm creation uses the immutable preview. Expiry, source changes, current content changes or a status change require a complete new preview.

Starting a wave is separate. Any pending product that has changed since confirmation blocks new admission. Human values and locks, SKU, IDs, price, inventory, English name, images and unselected copy are protected. Unknown package facts need manual confirmation; a one-bottle value is never assumed.

If only selected copy was generated and other copy is incomplete, the result needs input. Open the product, adopt the allowed candidate fields, complete missing information and save a review version through the existing workflow. No incomplete active version is generated.

Pause stops new admission; accepted work can finish. Retry only a known failed current attempt. A changed input/source or a superseded run needs a new preview. An unknown provider outcome keeps its cost hold: reconcile that attempt before retrying. Successes stay completed. Each retry retains its parent, original mask and original fence.

Archive hides an entry from the normal work list. Show archived entries to restore it. Archive does not cancel execution, remove evidence, reset costs or mark the underlying workflow complete.

## Local verification

Use loopback PostgreSQL and explicit isolated database names beginning `opak_fixes_`. The content-reader suite truncates only its guarded dedicated fixture database; never point it at shared or production data.

```sh
WUKONG_OPAK_INTEGRATION=1 pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/maintenance-content.integration.test.ts packages/db/src/repositories/maintenance-recovery.integration.test.ts
pnpm --filter @wukong/web exec vitest run lib/batch-selection.test.ts app/api/enrichment-batches/preview/route.test.ts
pnpm --filter @wukong/worker exec vitest run src/operation-ai.test.ts src/listing-operation-pipeline.test.ts
WUKONG_OPAK_E2E=1 PLAYWRIGHT_E2E=1 pnpm exec playwright test tests/e2e/opak-current-content-batches.spec.ts --project=chromium --workers=1 --retries=0
```

The browser needs the complete `real-stack-server.mjs` runtime, fake AI, mock SHOPLINE and disabled publishing. A web-only server cannot prove Queue execution. Synthetic local fixtures and observed schema tests are separate from live model quality or merchant acceptance.

## Release and rollback

Additive migrations:

- `0049_batch_current_content_fences.sql`: batch item content fence.
- `0050_batch_selection_previews.sql`: selected fields, immutable preview/creation receipts, composite workspace foreign keys and indexes, forced RLS. App grants are SELECT/INSERT only for immutable receipts.
- `0051_batch_operational_archive.sql`: separate operational visibility timestamp.

No new paid/provider production environment variable is enabled by this batch. Test-only opt-in names are `WUKONG_OPAK_INTEGRATION` and `WUKONG_OPAK_E2E`.

Apply compatible additive schema in an authorized controlled release environment; verify the effective app role and existing 0046 compatibility first. Deploy the compatible worker before enabling the web producer's optional `contentFields` envelope: an old strict worker cannot accept the new maintenance job shape. Verify worker/web SHA and DB compatibility explicitly.

Rollback disables new admission and restores compatible web/worker code. Retain schema, immutable receipts, source rows, versions, run lineage and unknown-cost holds. Reconcile accepted external calls before any expansion. Production migration, paid AI, first real SHOPLINE write and the merchant 5→20→100 pilot remain separate authorization and evidence gates.
