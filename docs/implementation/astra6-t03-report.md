# Astra 6 T03 native intake and recovery repair

Date: 2026-09-16
Branch: `codex/astra6-recovery`

## Scope

Implemented native multi-selection repair, manual note-only intake, stable create idempotency, immutable processing replay test coverage, connected working-document recovery, and the approval-first delivery gate exposed by the local pilot.

## Behaviour implemented

- Snapshots the native chooser's live `FileList` synchronously before clearing it.
- Appends selections, skips duplicate identities with a localized notice, supports remove/reselect/cancel, and revalidates the existing 10-image, 1-PDF, 20 MiB, MIME, and nonempty-byte limits.
- Creates 64 x 64 previews and revokes object URLs on removal and unmount. React updater callbacks contain no message or preview side effects.
- Preserves finalized asset IDs and stored keys through selection changes and failed create retries.
- Supports nonblank note-only drafts with explicit AI or manual processing mode.
- Sends a stable UUID `Idempotency-Key` for the same create payload through response loss; a changed file, note, or mode receives a new key.
- Reads and renders a no-version working document. Manual corrections save as a new input revision and survive reload.
- Checks workspace-scoped approval state before strict publish parsing or image, connection, and publisher work. An incomplete unapproved version returns `approval_required` instead of an internal error.

No new source roles are persisted without a backend contract.

## Verification

| Check                                | Result | Evidence                                                                                                                                              |
| ------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake selection/client/replay tests | Passed | 3 files, 27 tests                                                                                                                                     |
| Create/process/view route tests      | Passed | 4 files, 50 tests; queued outbox recovery, replay after revision change, no-version working document                                                  |
| Legacy intake route fixture          | Passed | 4 tests against accepted run and outbox contract                                                                                                      |
| Delivery service and route suites    | Passed | 3 files, 56 tests; incomplete unapproved content gates before strict parsing and external I/O                                                         |
| Native Chromium picker               | Passed | Synthetic local harness; append, remove, reselect, cancel, two previews                                                                               |
| Connected manual recovery            | Passed | Local Postgres; note-only create, no active version/run, revision 1 reload, corrected note and producer saved as revision 2 and retained after reload |
| Web production build                 | Passed | Next.js compile and TypeScript completed after shared dependency fixes                                                                                |

Durable evidence:

- `docs/implementation/evidence/astra6/t03-native-selection.png`
- `docs/implementation/evidence/astra6/t03-native-selection.metadata.json`
- `docs/implementation/evidence/astra6/t09-manual-recovery.png`
- `docs/implementation/evidence/astra6/t09-manual-recovery.metadata.json`

Both screenshots are explicitly labeled synthetic local-harness evidence. AI used the fake provider, SHOPLINE used its mock adapter, and no paid or production calls occurred.

## Pilot diagnosis

The previously observed delivery pre-approval 500 was reproduced directly. `requireForPublish` rejected the incomplete active version before policy evaluation with `active listing version content is invalid`. The approval-first gate now returns 409 without strict content parsing or external I/O. The pilot was updated to enter SKU, price, and stock through the real working editor because those fields are operator-owned and are intentionally excluded from AI evidence.

## Connected recovery and pilot closure

- The full Chromium listing pilot passed: two valid image sources, operator-owned commercial corrections, two immutable AI operations, approval, CSV export, every emitted signed image URL downloaded successfully, mock SHOPLINE publication, and tenant/audit verification.
- The compiled production server accepted a `pdf-lib` generated one-page PDF through the real finalize route. Its unclear first run ended `needs_info`; a reload retained the source and note; corrected note plus manual producer saved revision 2; a distinct attempt-2 run reached `in_review`; and the original terminal run remained readable.
- Harness startup failures were traced to two configuration errors and resolved: split admin/runtime database URLs silently seeded another database, and omitting `TEST_DATABASE_URL` made the guarded callback runner exit explicitly. The fixture now fails fast when database host, port, or database name differ and includes auth-audit context when mail is absent.

Readable recovery evidence:

- `docs/implementation/evidence/astra6/t09-needs-info-recovery.png`
- `docs/implementation/evidence/astra6/t09-needs-info-recovery-mobile.png`
- `docs/implementation/evidence/astra6/t09-needs-info-recovery.metadata.json`
- `docs/implementation/evidence/astra6/t09-listing-pilot-complete.png`
- `docs/implementation/evidence/astra6/t09-listing-pilot-complete.metadata.json`
