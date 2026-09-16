# Astra 6 implementation evidence

## Source identity and scope

Implementation branch: `codex/astra6-recovery`, based on fetched `origin/main` **63a6f762e67ebcc1d106334b59b04b45afe3d6b4** in `YNWAforever/wukong-ecommerce-os`. The original `claude/bulk-approve-error-handling` checkout and its untracked work were preserved. All nine implementation-pack manifest entries matched their SHA-256 values. The start document and all references were read in full.

The task reports record individual implementation slices. This record consolidates later integration fixes; earlier statements that parent wiring was pending are historical, not the current source state.

## Implemented behavior

| Tasks   | Source behavior                                                                                                                                              | Evidence boundary                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| T00–T02 | Verified repository/deployment identity; additive schema compatibility probe; safe provider error categories and per-request diagnostics                     | Read-only production observations in baseline report; no claim that production runs this branch     |
| T03     | Native picker snapshots live selection, appends/deduplicates/removes/reselects, retains successful uploads through retry, supports note-only manual creation | Native Chromium and connected local DB screenshots                                                  |
| T04–T05 | Immutable input revisions, persisted working content, source selection, operator ownership/locks, revision and base-version conflict checks                  | Tenant-scoped DB, route and component tests; manual correction survives reload                      |
| T06–T08 | Immutable run/retry identity, atomic outbox acceptance, lease fences, late candidates, saved correction UI, failure/status/retry actions                     | Worker, DB, route and component tests; real adapters exercised with mocked transports               |
| T07     | Physical invocation identity, bounded adapter repair, no hidden SDK retries, nullable unknown usage and retained spend holds; compatible extraction reuse    | No paid-provider billing verification                                                               |
| T09     | Local connected manual intake/recovery and synthetic processing verification                                                                                 | Real-product preview/provider/queue and production activation remain separate gates                 |
| T10–T11 | Independent image preparation before text version; saved-source and exact-version review/approval protections                                                | Synthetic image bytes and local object-store/DB tests                                               |
| T12–T13 | Existing delivery/export contracts preserved; approval policy checked before strict parsing of partial drafts                                                | Workbook/source-binding tests and synthetic connected pilot; no real SHOPLINE acceptance            |
| T14–T15 | Explicit public URL matched retrieval, identity-scoped suggestions, immutable rejection and explicit claim support                                           | Local synthetic source/route tests; no general-search quality claim                                 |
| T16     | Golden-set acceptance protocol retained                                                                                                                      | Authorized real product set and named acceptance owner pending                                      |
| T17–T19 | Exact bound batch outcomes, durable Advance receipts, pause/resume/cancel/retry lineage, reservations and unknown holds                                      | 50-item real-consumer/local-DB cohort plus control/race tests; cloud queue/DLQ transport unverified |
| T20     | Admin workspace voice/content policy/required fields/source-domain configuration, conflict protection and tenant-scoped usage                                | Core/DB/API/UI tests; second-tenant isolation checks                                                |
| T21–T22 | Operator guide, incident and rollback guidance, explicit staged acceptance gates                                                                             | Attended merchant run and elapsed shadow pilot not performed                                        |

## Integration findings corrected

- Manual facts now have explicit internal operator provenance derived from the immutable input snapshot. Both real provider adapters accept these facts without fabricated photo evidence; automatic fields still need evidence and generated facts must equal the saved facts.
- Reviewed non-reasoning OpenAI models omit the unsupported reasoning request option.
- Terminal immutable operations revoke unfinished step leases while preserving completed checkpoints. Same-owner checkpoint replay is a no-op and cannot replace the original output.
- Original file bytes are retained. Decoded JPEG/PNG/WebP derivatives strip metadata; corrupt/mismatched/oversized input is rejected. PDFs are structurally parsed in a timed worker with a bounded JavaScript heap, page count and page dimensions. This is not a claim of a total process-memory sandbox.
- Rating/award checks evaluate each claimed value, critic, medal and year rather than treating one supported fact as permission for all claims. Saved product name and market variant gate lookup, adoption and retained support; rejecting an accepted claim creates an input revision and invalidates approval/support. Independent review confirmed both P1 findings closed with no remaining actionable P1/P2 in that bounded pass.
- Additive migrations through **0040** include immutable evidence ledgers and indexes for new tenant foreign keys. No production migration ran.
- The production PDF worker resolves a native absolute parser path; the web app pins/externalizes the parser and traces it into deployment output. A regression check rejects numeric bundler module IDs and missing parser output. The lockfile retains baseline dependency resolutions and adds only pinned `pdf-lib@1.17.1` and its dependency closure. Frozen offline installation passed.

## Durable local runtime evidence

- [Native selection screenshot](evidence/astra6/t03-native-selection.png) and [metadata](evidence/astra6/t03-native-selection.metadata.json).
- [Completed listing pilot screenshot](evidence/astra6/t09-listing-pilot-complete.png) and [metadata](evidence/astra6/t09-listing-pilot-complete.metadata.json).
- [Manual recovery screenshot](evidence/astra6/t09-manual-recovery.png) and [metadata](evidence/astra6/t09-manual-recovery.metadata.json).
- [Compiled PDF recovery desktop](evidence/astra6/t09-needs-info-recovery.png), [mobile](evidence/astra6/t09-needs-info-recovery-mobile.png) and [run/revision metadata](evidence/astra6/t09-needs-info-recovery.metadata.json).
- [50-item consumer cohort](evidence/astra6/t19-consumer-cohort.json): captured 2026-09-16 Hong Kong time; exact workspace, batch, listing and run IDs retained. Fifty actual accepted operations traversed the consumer and PostgreSQL repositories. Fifty duplicate deliveries caused no extra calls. The terminal operations were 20 succeeded (10 partial/needs-input), 10 failed, 10 superseded and 10 cancelled; 50 extraction and 30 generation calls used the synthetic provider. Corrections/cancellation occurred during generation; late candidates were retained and no stale version was adopted.

The cohort uses an in-memory queue transport and controlled fake-provider callbacks. It does not establish Cloudflare delivery latency, a real process kill, remote DLQ/alert delivery, image recognition quality or provider billing.

## Verification on the final source

- `pnpm test`: **2,742 package tests + 103 Node checks passed**, 14/14 Turbo tasks. No failing unit tests.
- `pnpm test:integration`: **380 passed, 5 skipped**, 52 files passed and 3 guarded files skipped, against the isolated `astra6_validation` database and local object store. Skips are dedicated migration rehearsals (T01 compatibility, fresh export and import-result migration); T01 was also run separately below.
- `pnpm typecheck` and `pnpm lint`: **14/14 tasks passed** each.
- Fresh and drifted schema rehearsal through migration 0040: **2/2 passed**, including replay of all migration files.
- Next production build and Cloudflare Worker dry-run build passed. No deployment ran. PDF and Sharp bundle checks cover the production output; the two Linux libvips-specific assertions are skipped on Windows.
- Connected Chromium listing pilot: **1/1 passed**, covering native photos, persisted corrections, two immutable AI runs, exact approval, CSV, both signed image URLs, mock SHOPLINE publication and audit/tenant checks.

- Connected Chromium PDF recovery: **1/1 passed (52.8 seconds)** on the compiled production server. A structurally valid one-page PDF finalized, run 1 ended `needs_info`, corrections survived reload as revision 2, and a distinct attempt 2 reached `in_review` while run 1 remained terminal and readable. Desktop/mobile screenshots were visually inspected.

These checks ran on Node 24.18.0 / pnpm 11.7.0 on Windows with local PostgreSQL and object storage. Integration and browser providers were synthetic. Remote CI has not run for this branch.

## Release gates

| Gate                         | Current boundary                                                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 deployment consistency    | Production web SHA and Worker version observed read-only; this implementation has not been deployed and web/Worker signed-health agreement is unverified |
| G1 dependable draft creation | Synthetic local evidence available; authorized real-photo preview/provider path and production canary not performed                                      |
| G2 complete product          | Local engineering checks available; real merchant artifact/import/receipt acceptance not performed                                                       |
| G3 supported enrichment      | Synthetic matching/adversarial tests available; authorized 30–50 product golden evaluation not performed                                                 |
| G4 reliable batches          | Local exact-run cohort/control evidence available; cloud queue crash/DLQ/alert operational acceptance not complete                                       |
| G5 merchant use              | Named owner, attended acceptance, comparable manual baseline and elapsed pilot outcomes pending                                                          |

No paid provider call, production database write, deployment, real SHOPLINE write or merchant acceptance was inferred from local test success. See [operator guide](astra6-operator-guide.md) for the implemented workflow and recovery actions.
