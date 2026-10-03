# Opak retained safeguards and cloud role handoff — 2026-10-03

The PR120 inventory exposed two useful safeguards missing from the accepted stack. Both were reproduced on source `e094bf39debe3cc2c7b62c0f56867afbb5ef4593` before any production-code change. The fixes preserve the existing Queue/review/publication contracts. Separate cloud browser acceptance completes the synthetic role-handoff and admin workspace-switch criteria; it does not establish production or merchant acceptance.

## Findings and behavior

| PR120 safeguard                                                | Classification on e094 source | Result                                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validate bulk-approval results before clearing selection       | already-fixed/strengthened    | Current queue validation and selected-ID handling retained                                                                                                                            |
| Explain a listing without a review/export version              | already-fixed                 | Existing no-version guidance retained                                                                                                                                                 |
| Keep approval domain validation free of duplicate audit writes | already-fixed/strengthened    | Existing pure validation and committed repository audit retained                                                                                                                      |
| Safe Queue ingress failure diagnostics                         | reproduced                    | Exhausted transport or signing failure emits only a fixed event, literal stage and allowlisted code; raw exception/URL/credential text is excluded; recovered retry remains silent    |
| Preserve a newer import during in-flight publish update        | reproduced                    | Update completion leaves the existing mirror authoritative; it no longer upserts its claimed older SKU/raw row/digest/source binding. Create completion still establishes its binding |

These are five distinct contracts; PR120's historical draft/failed CI is not promoted to a green result. Its useful changes are represented in the reviewed repair stack without merging the obsolete branch blindly.

## Executed source verification

| Command                                                                                            | Actual result                                                                                              |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @wukong/web exec vitest run lib/cloudflare-queue-runtime.test.ts` before source fix | RED: 7 failures/12 passes; expected terminal diagnostics were absent                                       |
| `pnpm --filter @wukong/worker exec vitest run src/publish-product.test.ts` before source fix       | RED: 1 failure/31 passes; the concurrently refreshed imported snapshot was overwritten by the old snapshot |
| Same two commands after source fix                                                                 | GREEN: Web19/19 and Worker32/32                                                                            |
| `pnpm test`                                                                                        | exit0; fourteen successful Turbo tasks, Web2,283/2,283 and Worker408/408                                   |
| `pnpm lint`; `pnpm typecheck`                                                                      | exit0 each                                                                                                 |
| `pnpm build`                                                                                       | exit0; eight successful tasks; fresh Web compilation                                                       |
| `pnpm exec prettier --check` for the four changed source/test files; `git diff --check`            | passed after normalizing the ported patch's line endings                                                   |

The preceding exact e094 [full CI37113613076](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/37113613076) completed SUCCESS. This new safeguard checkpoint needs its own source-head CI; current terminal status is recorded on PR126, never inferred from the preceding head.

Independent read-only review found no Critical or Important issues. Final: minor (deferred): the existing comment at `apps/worker/src/publish-product.ts:20` still describes refreshing the row on success; update completion now intentionally preserves it. The runtime and its more specific completion comment are correct.

## Executed isolated cloud acceptance

Private guarded `cloud-browser-v26/run.mjs` passed **33/33 checks**, exit0, **116.58s**, on the exact existing isolated `7333d9496d43723cbb9fe0cef7517a8f8058b214` Web Preview. This is the preceding native-auth candidate, not a deployment of the new Queue/publish delta. Worker `f0614b8e-8628-4cc0-82f5-e318c6565be2` and held Queue/cron/ingress remain unchanged.

- Existing accepted-invite operator and reviewer actors use one real browser context: password POST200 and server identity/role; operator logout200/account+listings401, stored work cleared and Back protected; reviewer login has its own role and cannot inherit the operator's work/admin permission.
- Admin workspace Stay and failed Save retain input and original server workspace without a switch. Discard switches once. Successful settings CAS returns200 before switching and updates only the old tenant; every second-tenant profile value stays unchanged. The original canonical profile is restored by fresh CAS.
- Three actors log out through the real UI and return401. Only this run's contexts are claimed revoked; older fixture sessions were outside the assertion.
- Exactly two settings audit events in this successful window: save plus restore. AI20 and publish0 are retained, no invite row is created, valid invite sending is forbidden, no unexpected app write/page error. Fake/paid-disabled; outgoing email0/paidAI0/realSHOPLINE0. Actual cloud billing remains unmeasured.
- Independent eight-minute watchdog observed normal stop; compute disabled/idle and restore acknowledgements pass. One synthetic screenshot was visually reviewed outside Git.

The [30-case cloud matrix](./opak-cloud-uat-results-2026-10-03.csv) now contains **9 passed / 8 partial / 13 blocked**, all30 IDs retained. UC01 and UC28's remaining role-handoff/workspace-switch criteria are covered. New invitation delivery/enrollment, delayed-switch cloud fault, complete cohorts/load, controlled paid/human/merchant work remain separate scopes.

## Retained failures and rulings

v23, v24 and v25 remain failed receipts. v23's return-workspace action stayed on the same dashboard URL, so URL matching did not establish completed navigation; the subsequent helper navigation aborted. v24 waits for the actual switch response/navigation. v24/v25 then exposed a malformed helper fixture: a JSON string passed to a JSONB parameter was encoded twice. A read-only diagnostic confirmed the second profile was a string. The correct `postgres.sql.json` adapter creates an object; all three owned malformed fixture profiles were corrected without deleting rows/audits. Their original and corrected safe hashes are retained. The successful run checks object shape before browser work and compares all profile values; JSONB key order is not a field change. No product, session, permission or settings endpoint was relaxed for these helpers.

Final: Ruling: separate source-unit/race proof from cloud733 UI proof — their exact candidates differ; cost if wrong: an undeployed source change could be called cloud accepted.

Final: Ruling: unchanged session/RLS/cost/manual/freshness fences retain their existing dedicated local/CI evidence; this four-file review measures regression risk, not whole-stack production effectiveness. Cost if wrong: a bounded review could be presented as production sign-off.

Final: Ruling: create/import concurrency or deliberate unlink/rebinding is unchanged and was not diagnosed by this existing-binding update regression. Preserve existing create semantics and make no wider concurrency claim. Cost if wrong: the tested update boundary could be overstated.

## Configuration, rollback and remaining release gates

No new migration, environment name, dependency or provider key; no production mutation, merge, paid model call or real SHOPLINE write. Retain safe diagnostics and update snapshot preservation on compatible rollback, together with native POST, the Resend simulator guard and corrected Worker Object Read-only credentials. Preserve sources, versions, approvals, audit, cost ledgers, artifacts, Queue/DLQ and accepted/unknown outcomes.

Production0046/runtime-role/cache/recovery readiness remains failed; authority and a named backup/rollback owner/recoverable point are pending in the [concrete proposal](./opak-production-repair-proposal-2026-10-03.md). Authenticated original500 cause, controlled paid/human quality and employee-minute comparison, fuller cloud scopes and first real merchant5→20→100 confirmation/reconciliation/sign-off remain incomplete. Conditional merge cannot trigger main's automatic production deployment while these hard gates fail. Raw evidence, fixture identifiers/passwords, protected links and screenshots stay outside Git.
