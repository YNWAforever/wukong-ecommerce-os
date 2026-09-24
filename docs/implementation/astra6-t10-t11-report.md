# T10/T11 bounded integration review — 2026-09-16

> Integration update: this file records its original implementation slice. Parent wiring, final fixes and combined checks are recorded in [the consolidated delivery evidence](astra6-delivery-evidence.md). Earlier pending sibling-work notes below are historical.

## Implemented deltas

- T10/A18: no-version recovery displays original and actual persisted image results independently of failed text. Disabled provider has a visible setup message. Existing selected-source image request and preparation now accept a null text version with a required saved input revision. Request checks the observation under the listing lock; preparation checks it before IO and again before candidate attachment. Existing source-byte digest, attempt idempotency, quality metadata, provider/render provenance and approval guards are retained. Final image approval still requires a saved text version. No new image job system or provider call was introduced.
- T11/A19: confirmation PATCH locks the listing, checks the exact text version and observed nullable ledger revision before invalidating approval or changing confirmations. Competing same-version reviewers get a safe actionable 409 instead of overwriting each other. Browser sends the displayed ledger revision.
- T11/A19: changed saved source selections or source notes clear the active version's confirmations and field records, increment the ledger revision and append an audit reason. Original confirmation source meaning is not silently carried forward.
- T11/A19 and A11: generated review now exposes a collapsible working-copy editor for sources, role/order/use, notes and fields. Saves bind the observed active text version and input revision. Dirty working/review forms disable one another and block confirmation/approval; explicit Save as a review version updates the saved review separately.
- A23: existing role checks, workspace transactions, source ownership and image repository operator/reviewer authorization remain intact. No role expansion or 71-column/export change.

## Evidence

- Related image request/service/component, working editor, generated review and confirmation route suites: 98/98 passed at the main integration check. Additional exact-ledger UI assertion run separately.
- Real local Postgres image request test: 1/1; real operator membership, immutable source digest attempt reuse with no text version, stale input revision rejection, no text version fabricated.
- Real local Postgres confirmation test: 1/1; two same-version reviewers produce one 200 and one 409; saved source note clears confirmations and field records with ledger increment.
- No-version prepare test renders and stores actual JPEG using the existing local image renderer; stale input revision rejects preparation; approval absent without a saved version.
- Web typecheck and DB build passed after the main changes. Final stable parent gates are authoritative for the concurrently edited shared worktree.

## Explicit limits

These are source/unit/local-integration results, not complete A18/A19/A23 or G2 acceptance. Native browser, real product-label/vintage/bottle/count accuracy, actual provider configuration and merchant artifact acceptance remain separate checks. All tests use synthetic data and mocked queue/provider calls. No paid image call, production migration, remote publication or export contract change occurred.

The disabled/missing-configuration request path returns a safe setup outcome and the UI exposes it; it does not yet create a durable failed attempt when no image operation was admitted. Existing admitted image failure/DLQ behavior remains owned by the existing product-shot pipeline. Image attempt source identity remains pinned by asset id plus computed immutable byte digest; this change does not add a numeric working-input revision column to historical image attempts.

## Generated baseline and final follow-up

The active editor derives AI-owned fields from the exact observed active version while preserving persisted operator-owned/locked fields and unknown merchant values. GET and correction save use the same core baseline function. A note/source-only save therefore snapshots the generated content the operator saw, while immutable earlier input revisions remain unchanged. Fields derived from the active version are marked proposed, with no fabricated evidence references.

Additional verification: core baseline suite6/6; listing GET29/29; generated review/image route/dirty UI53/53. No-version image request + prepare gap is closed using existing attempt/source identity and input revision CAS; image replacement upload before a text version remains available through the working-copy source uploader. Final image approval still intentionally waits for a saved review version.

Final checks after baseline integration: inputs/confirmation/image local DB suites9/9; final editor/confirmation/image suites81/81. Latest web typecheck was blocked by concurrent sibling diagnostics: listing-operation-service.ts imported unresolved @wukong/ai and pipeline-runs.ts referenced inputRevision on the legacy listingPipelineRuns schema. Earlier web typecheck passed; parent stable full build remains authoritative. Owned core and DB builds passed before those concurrent edits.
