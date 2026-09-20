# Wine enrichment operations

## Topology and dormant configuration

Vercel Web authenticates and accepts an immutable listing operation, then signs Worker ingress. Cloudflare Queues advance one durable stage per delivery. The Worker alone calls OpenCode Go and Tavily, reads immutable image snapshots from S3/R2, and requests guarded documents through `WEBSITE_FETCH_BASE_URL`. PostgreSQL holds tenant-scoped operations, stages, evidence, source authorities, proposals and separate Go/Tavily ledgers. Scheduled recovery flushes durable outbox work without replaying a started physical call.

| Setting                                           | Owner                           | Required behavior                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WINE_ENRICHMENT_ENABLED`                         | Web and Worker                  | Default `false`; render explicitly. Web gates new admission; Worker flag describes deployment intent and conditional secret requirements, not an execution kill switch. |
| `LISTING_PAID_OPERATIONS_ENABLED`                 | Web and Worker                  | Keep `false` until separate release approval. Accepted work continues to drain.                                                                                         |
| `AI_PROVIDER` / `OPENCODE_GO_LISTING_MODEL`       | Deployment configuration        | Explicit `opencode-go` / `deepseek-v4.1-flash`; no implicit routing or fallback.                                                                                        |
| `OPENCODE_GO_API_KEY`                             | Worker secret                   | Never on Vercel or `NEXT_PUBLIC_*`.                                                                                                                                     |
| `TAVILY_API_KEY`                                  | Worker secret                   | Required by rendered secret inventory when wine is enabled. Never on Vercel or in generated vars. Full/research needs it even when draining with flags false.           |
| S3 bindings and credentials                       | Existing storage owners         | Full/research requires storage plus immutable image snapshots; Web retains its normal upload configuration.                                                             |
| `WEBSITE_FETCH_BASE_URL` / `QUEUE_INGRESS_SECRET` | Worker callback / shared signer | Trusted HTTPS document origin and matching signer; full/research requires both.                                                                                         |
| `BUILD_SHA` / `CLOUDFLARE_HYPERDRIVE_ID`          | Deployment shell                | Supply the reviewed Git SHA and actual selected binding at render time. Never store stale values in an envfile.                                                         |
| Workspace `wineEnrichment` profile                | Server-controlled policy        | Reviewed enabled state, policy version, domains and Tavily allowance. Do not add a production cap or activate during local tests.                                       |

The renderer and runtime doctor derive names, never provider secret values. Predeploy doctor uses intended environment; live doctor uses observed public provider/flag metadata. Missing old flag metadata means dormant. Secret-name inventory is not a capability receipt. Deployment preflight requires Tavily when enabled and permits its retained secret when disabled so accepted full/research can drain; existence alone does not authorize new production activation. Preserve the separate decision about an existing unused OpenAI secret; this workflow neither deletes nor rotates it.

Accepted copy/section modes construct generation and quality handling without Tavily, document acquisition or image storage. Do not add a global secret check that prevents their draining. Legacy operations without the wine flow marker continue down the legacy path with both admission flags false. Wine operations always use their accepted execution snapshot, including when current policy changes.

## Schema and fresh health

The existing `loadSqlMigrations` registry discovers numbered SQL files in filename order, including reviewed `0041_wine_enrichment.sql`, `0042_wine_acquisition.sql` and `0043_wine_runtime_recovery.sql`. There is no additional journal entry to invent. Do not run the all-migrations command merely to test discovery. Production migration requires explicit approval and the controlled admin release connection; runtime remains `wukong_app`.

Authenticated health must confirm listing recovery compatibility, `wine-enrichment-0042-v1`, and separate `wine-runtime-0043-v1` readiness. The latter checks exact recovery functions, nonruntime owner, SECURITY DEFINER, fixed public search path, runtime EXECUTE and no PUBLIC EXECUTE. Do not weaken compatibility for equivalent-looking SQL. Health provides safe build SHA and booleans, never credentials.

Distinguish current health from immutable acceptance: `fullResearchConfigured` and `wineRuntime` are fresh diagnostics; the accepted `wine` capability retains its existing serialized contract/digest. Full/research admission requires fresh storage/document/provider readiness. Copy/section ignores full-research configuration. Missing/mismatched/stale capability must block new admission without rewriting old accepted records.

## Local verification

Use the existing dedicated `wukong_wine_sdd` database on loopback port 54329 and runtime/admin roles through process-local `TEST_DATABASE_URL` and `TEST_DATABASE_ADMIN_URL`. Verify the database target before running any tests. `vitest.integration.config.ts` does not apply migrations. No envfile, cloud endpoint, paid provider call or DDL is required by the checks below.

```powershell
node --test tests/cloudflare-config.test.mjs tests/runtime-env-manifest.test.mjs tests/runtime-doctor.test.mjs
pnpm.cmd exec vitest run packages/db/src/migrations.test.ts apps/worker/src/cloudflare-runtime.test.ts apps/web/lib/wine-capability-client.test.ts
pnpm.cmd exec vitest run --config vitest.integration.config.ts apps/worker/src/wine-extraction-handler.integration.test.ts apps/worker/src/wine-research-handler.integration.test.ts -t 'deadline crosses during|unknown Extract stops'
pnpm.cmd exec vitest run --config vitest.integration.config.ts apps/worker/src/wine-generation-handler.integration.test.ts -t 'actual Queue factory executes|local0043'
pnpm.cmd format:runtime:check
pnpm.cmd runtime:forbidden:check
```

For actual local HTTP/Queue proof, `node tests/e2e/wine-runtime-harness.mjs copy` starts the checked-in harness on 8789. Set process-local `WINE_RUNTIME_HTTP_URL=http://127.0.0.1:8789` and run the generation integration test filtered by `actual local Wrangler HTTP`. Stop the owned copy harness before starting `full`; use filter `actual local Wrangler full`. Full mode also requires the existing local Minio/Caddy HTTPS endpoint on localhost:9012 and the local CA through `NODE_EXTRA_CA_CERTS`. The test owns synthetic provider HTTP port 49221. `WINE_LOCAL_S3_E2E=1` opts into `packages/assets/src/wine-image-snapshot.integration.test.ts`. Stop only owned harness processes afterward.

Task 8c established actual local HTTP/Queue and immutable S3 evidence using synthetic providers. It did not establish production cloud R2 IAM/retention, live provider accuracy, nonempty web-document acceptance or merchant acceptance. Task 13b must implement actual fullstack browser scenarios and screenshots before adding the wine Playwright command/artifact upload to CI. Do not create a placeholder browser spec or claim that existing local probes are screenshots.

## Recovery and immutable evidence

- Source freshness is bounded to seven days from original capture; copy and section regeneration cannot renew it. The operation deadline is accepted time plus 15 minutes. No new provider call starts after expiry, including time crossed during storage or registry I/O.
- Go remains a cumulative USD 10 workspace cap. Full/research reserves USD 3.194880 and five Tavily credits; copy/section reserves USD 1.277952 with no Tavily. Full flow permits at most ten physical Go calls including repairs; copy/section at most four. Accepted limits never change with current policy.
- Started calls and ambiguous transport outcomes preserve unknown cost holds and stop automatic work. Do not retry a paid call automatically, release the reservation, or turn an outage into successful empty search. A measured definitive failed search or genuine successful empty result can produce photo-only partial evidence; ambiguous transport cannot safely continue as that fallback. Retained photo evidence and recoverable/unknown state remain visible for review.
- Recovery uses exact durable stage/outbox binding and bounded attempts. A completed duplicate does not rerun its executor; started/unknown stages are not blindly re-enqueued. At deadline, settlement retains uncertainty and releases only known unused allowance.
- Manual adoption intentionally creates a listing version with a NULL pipeline key. Recover adopted evidence through the strict immutable proof chain: tenant/listing/version, section snapshot, origin run, successful original stages, accepted hashes, claims, registry authority and exact adopted text/metadata. Do not assign a fabricated pipeline key, rewrite stage output or treat current listing text as proof. Stale/rejected retained output remains inspection-only.
- Identity selection creates a new immutable input/operation. Historical selection survives later authority edits while newly unsupported factual claims remain blocked. Ancestry is bounded to 16. Preserve merchant price/stock/SKU, locks, operator-owned sections and original evidence.

## Ordered release gates

1. Complete independent code review and Task 13b actual browser/fullstack evidence: exact match, ambiguous identity selection through real Queue, conflict, real synthetic HTTP outage, duplicate delivery, manual edit, navigation return, expired evidence, injection, tenant isolation and section regeneration. Preserve screenshot/trace/runtime IDs. Run repository-wide validation separately and report baseline/environment failures honestly.
2. Obtain concrete approval for production additive migrations and each Worker/Vercel publication **before any production migration or deployment**. Local implementation and verification do not authorize these actions.
3. After those approvals, apply the approved additive migrations and deploy compatible Web and Worker readers **before any production `reliable_source` authority records are written**. Their canonical subject name is the lower-case domain; old readers reject this additive enum. Keep flags false through schema/readiness checks and mixed legacy/wine draining verification. Verify exact build SHA, Hyperdrive/Queue connectivity, document callback, HTTPS image snapshots, R2 conditional writes, namespace permissions and retention against the real topology. Authenticated append-only registry writes require a separate reviewed operator action; migration/publication approval alone authorizes no production seeding.
4. Obtain separate approval for production Tavily credentials and credit allowance, Go budget and activation. Keep SHOPLINE disabled and publishing false. Turning flags off stops new admission but does not cancel accepted work; preserve required old credentials and readers while draining.
5. Complete human labels for Task 12 before interpreting evaluation accuracy. Paid baseline/candidate evaluation must demonstrate at least 20% error improvement and p95 <= 180 seconds; six real merchant products, two per category, remain unverified acceptance gates. Synthetic fixtures or local harness results cannot satisfy them.
6. Activate only after these gates, provider configuration and independent review pass, under explicit release authorization. Retain rollback readers and unknown-cost holds; never use rollback to erase accepted evidence or budgets.
