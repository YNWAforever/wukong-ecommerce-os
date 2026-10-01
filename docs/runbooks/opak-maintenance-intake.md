# Opak existing-product maintenance intake

Choose **Maintain existing SHOPLINE products** to work on an existing product. Check the displayed workspace store, obtain its current original SHOPLINE update export and enter its export time. A saved connection is configuration metadata; it does not certify live API access or authorize the first real SHOPLINE write.

Choose **Organize reference material** to keep website/workbook observations for research. Those records remain readonly delivery sources. Their **Start maintenance** action carries an owned candidate reference to maintenance; it does not create a platform binding by name or make the reference exportable. Choose **Create a new product draft** for the existing editable new-product path.

When using a reference, check the actual product ID in the new original export, store, vintage/NV, volume and pack. Missing observations require confirmation. Contradictory observations, duplicate IDs, ambiguous variants and known identity conflicts must be resolved; confirmation cannot override them. Upload the actual original bytes. The importer checks workspace/store/identity again before any mutation.

Keep the source receipt. A retry of identical bytes returns the same receipt and original export time with no duplicate drafts or refreshed approval. A different original export creates immutable source evidence and invalidates old approval bindings; review the current product again. Entering a later date cannot renew an old identical workbook. Approval/export still enforce their existing version/source/confirmation freshness gates; the intake check does not replace them.

Fresh maintenance drafts are editable without an AI run. Current imported merchant values initialize the draft once. Source copy is proposed evidence; saved human edits and locks are protected. Unknown pack stays unknown. Re-imports change source bindings, never silently overwrite current human input. Review and save a version through the existing revision checks before seeking approval.

The catalog counts reference records, drafts and bound SHOPLINE products separately. Use the corresponding workspace metric to find them; **Listing workflows** includes standalone unbound drafts. Multiple source records are not a unique-product count. A blocked record shows its support ID and has delivery actions disabled. An overall database failure shows an error and must not be treated as an empty catalog.

## Verification and release boundary

Synthetic local acceptance uses Better Auth, forced-RLS Postgres, fake AI and mock SHOPLINE with publishing disabled. Required suites include importer/intake units, source/workspace/record-isolation integrations, `workbook-import.spec.ts` and the opt-in 20-product `opak-maintenance-intake.spec.ts`. The latter requires `WUKONG_OPAK_E2E=1` and refuses non-loopback or non-task-owned databases. Production acceptance is separate.

T03 adds no migration or environment variable. Existing environment names remain `DATABASE_URL`, test database URLs, auth/SMTP/S3 configuration, `AI_PROVIDER`, `SHOPLINE_ADAPTER` and `SHOPLINE_PUBLISH_ENABLED`. Do not copy production credentials into the local harness. Production schema compatibility must first satisfy the runtime recovery pack.

Rollback stops new maintenance imports or restores compatible application code. Retain source imports, immutable rows, input revisions, audit and completed external results. Do not delete a replay receipt, lower permissions or remove source/approval checks. No real SHOPLINE write is authorized by this runbook.
