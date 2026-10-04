# Opak candidate preflight — 2026-10-05 HKT

## Completed behavior and limits

The current reviewed source is659519c90734dba4b35a8700e85affcef824cba4; its application code is byte-identical to binding repair187394c9. Current PR126 remains OPEN/CLEAN with successful CI, Vercel and Preview Comments checks. Exact prior terminal CI37213826698 has43 successful steps; exact PR previewdpl_FYricPgkYV1WMb4PkyL11RLU8hNG is a READY artifact, not authenticated flow acceptance. Original CI01/CI02 failures and unconfirmed rendering/timing causes remain retained.

The isolated staging branch6bec8486 and reviewed source share92d15ca0. Product-source differences are the Worker publish/consumer binding fix and common platform-product repository; the staging-specific apps/web/vercel.json deployment hold must be retained. No original fix is reimplemented.

A local candidate is compiled with Wrangler4.112.0 using the existing accepted preview version's names and non-secret variables, exact preview Hyperdrive/Queues and current source BUILD_SHA. It fixes workers_dev=false, preview_urls=false and empty cron, fake AI, mock SHOPLINE, disabled paid operations/publishing/product-shot/wine and TYPESAFE off. No secret value is loaded or included. DB dependencies rebuild and the dry-run pass with zero Wrangler errors/warnings; the bundle contains bindCreatedProduct.

| Local artifact       | Bytes                | SHA256                                                           |
| -------------------- | -------------------- | ---------------------------------------------------------------- |
| cloudflare.js        | 3422974              | 06df1c5b2de92f13ed9c42bd02842ef15996c2bbb8d3394c2f18523a92e3f565 |
| candidate-held.jsonc | recorded outside Git | 5e1ee6910a873e1fc95f9edec15867a46022758441301d23d03ec4c132e6b978 |

This bundle/config stays outside Git. It was not uploaded or deployed, does not create a cloud version and does not prove current cloud Queue/R2/audit acceptance. The checkout's existing generated config is a local test fixture with placeholder source/Hyperdrive and opencode-go/photoroom/wine test settings. Do not reuse it as an approved fake-only deployment config. That local fixture is not evidence that a deployed runtime has those settings; the separate candidate is derived from accepted version metadata.

Fresh normal-CLI metadata reads confirm the exact staging endpoint remains disabled/idle with min=max0.25CU. Active preview Workerfcf96cda-1054-4fdb-8ba0-0e002294c466/source593c5283bac242fc171850ee6358f2e9ccc77a1b remains100%; its immutable earlier R2/Queue receipts apply to that artifact. Production main branch metadata reads ready; no schema/root-cause or effective Web-connection claim is inferred from branch readiness.

## Findings and retained failures

- Candidate helper failed before any build with SyntaxError: Unexpected end of input. One missing closing brace was corrected; the failed helper hash and parse outcome are retained outside Git. No product fix is inferred.
- Current Vercel billing connector returned404 Plan not found. Normal CLI received JSONL but failed its single-JSON parser. These are failed reads; no billed amount or all-provider budget pass is fabricated. The earlier shared-project1.45954USD receipt remains dated, lagged and not a final isolated invoice.
- The supported normal browser attempt failed before startup: Windows sandbox helper apply deny-read ACLs. No billing page, session, application failure or production500 was observed; no browser-profile/cookie/credential workaround was used.
- Budget admission is blocked before any new staging upload/compute/Queue admission. The existing synthetic US$5 authority remains recorded, but unknown actual all-provider cost is not permission to exceed it.

## Commands and recovery

Commands were run locally with exact reviewed source and the outside-repo candidate config:

```powershell
pnpm.cmd --filter @wukong/db... build
node --check <outside-repo candidate helper>
wrangler --version
wrangler deploy --dry-run --config <outside-repo candidate-held.jsonc> --outdir <outside-repo worker-bundle>
wrangler versions view fcf96cda-1054-4fdb-8ba0-0e002294c466 --config <preview hold config> --json
wrangler deployments status --config <preview hold config> --json
```

No new application env, migration, dependency, credential or provider secret changed. Cloud compute was not resumed; no Queue submission, outgoing email, paid AI or real SHOPLINE call occurred. Held queues/ingress remain the existing operational state, with no new remote pause/cron-flag proof claimed. Production changes and merges are zero.

Before deploying this candidate, refresh conservative budget admission and the current exact preview identities, use the separately guarded preview-only config, preserve corrected Worker Object Read-only secrets, pair with a compatible guarded Web, bound the acceptance window and stop new admission on any hard/unknown result. Do not deploy the generated test fixture or use old source593 as a safe concurrency rollback; keep admission held while selecting a compatible artifact. Keep ledgers, accepted/unknown results, sources, audits, queues/DLQs and assets intact.

Production0046/cache-only approval and Codex operator are recorded. Restore owner/recoverable point, effective production Web DB/session, original detail/queue500, safe role/schema/cache/compatible runtime, paid-human quality, matched employee20minutes and first real SHOPLINE/reconciled5→20→100 remain open. UAT stays15PASS/3PARTIAL/12BLOCKED/all30. See the [current master-plan gates](../superpowers/plans/2026-10-01-wukong-opakcellar-fixes.md) and [bounded production proposal](./opak-production-repair-proposal-2026-10-03.md).
