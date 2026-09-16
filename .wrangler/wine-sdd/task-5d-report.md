# Task 5d report — actual Node wine document POST route

## Outcome and scope
DONE for the controller-approved narrowed Task 5d route slice, starting from `6d6e37a` on `codex/tavily-wine-enrichment-design`. Added only the actual Node POST route and adjacent route unit/local-database integration tests. No provider behavior, Queue pipeline, shared contract, migration, production data, credential, paid call, or feature-activation change was made.

The route exports `runtime = "nodejs"`, an injectable `createWineEvidenceDocumentPost` factory, and the actual default `POST`. The default composition reads `QUEUE_INGRESS_SECRET` lazily through a callback and resolves `getDatabase()` only after the existing handler has accepted the exact signed path/body/timestamp and parsed the strict request schema. Authorized requests use the real `createWineDocumentStore(database)` and existing `createWineDocumentService`/`createWineDocumentHandler`; no fake repository cast or caller-provided URL exists.

## Implemented behavior
- Missing, expired, or body-mismatched signatures return the existing sanitized 401 response before database resolution.
- Malformed signed JSON is sanitized by the existing route boundary and does not expose parser details or resolve the database.
- The local integration uses the dedicated localhost `wukong_wine_sdd` database, an accepted `wine-enrichment-v1` operation, persisted web evidence, the real durable claim/finish store, the signed handler, and an injected synthetic public fetch. It makes no external request.
- A valid product callback reads the persisted URL, performs synthetic robots and document fetches, commits a terminal ready result, and returns it. The repeated completed callback returns the exact persisted result and leaves the synthetic fetch count at two.
- A source ID belonging to another workspace, a stale listing revision, a cancelled operation, and an expired accepted deadline all return stale without network I/O. A previously committed started claim returns unknown without network I/O.
- The default `POST` composition is covered by Web typecheck and the successful production build route manifest, which includes `/api/internal/wine-evidence-document`.

## TDD evidence
RED, before production route code:
`pnpm.cmd --filter @wukong/web exec vitest run app/api/internal/wine-evidence-document/route.test.ts`
failed at module import with `Cannot find module './route'`; 1 failed suite, 0 tests. This was the expected missing-feature failure.

GREEN unit and callback regression:
`pnpm.cmd --filter @wukong/web exec vitest run app/api/internal/wine-evidence-document/route.test.ts lib/website/wine-document-handler.test.ts lib/website/wine-document-service.test.ts lib/website/public-fetch.test.ts lib/website/robots-policy.test.ts lib/website/extract-document.test.ts lib/website/public-fetch.integration.test.ts`
passed 7 files, 136 tests. Output clean.

GREEN local database integration:
`TEST_DATABASE_URL=postgres://wukong_app:...@127.0.0.1:54329/wukong_wine_sdd TEST_DATABASE_ADMIN_URL=postgres://wukong:...@127.0.0.1:54329/wukong_wine_sdd pnpm.cmd exec vitest run --config vitest.integration.config.ts apps/web/app/api/internal/wine-evidence-document/route.integration.test.ts`
passed 1 file, 2 tests. Credentials above are the documented local synthetic fixture values from `task-3-environment.md`; no environment file was sourced and no production system was contacted.

A first integration run reached the real successful route path but had one test-only assertion error (`Response.clone: Body has already been consumed`) after parsing the first response. The assertion now retains the parsed body; production code was unchanged. The rerun passed. A unit assertion was also corrected to the established flat `{code,message}` error shape after the first post-implementation run showed 2/3 behavior checks already passing.

## Other verification
- `pnpm.cmd --filter @wukong/web typecheck`: PASS.
- `pnpm.cmd --filter @wukong/web build`: PASS. Next.js compiled, typechecked, generated 44 static pages, and listed the new route. It emitted the pre-existing middleware-to-proxy deprecation warning.
- `pnpm.cmd exec prettier --write` on the three route files: PASS.
- `git diff --check`: PASS before report creation.

## Files changed
- `apps/web/app/api/internal/wine-evidence-document/route.ts`
- `apps/web/app/api/internal/wine-evidence-document/route.test.ts`
- `apps/web/app/api/internal/wine-evidence-document/route.integration.test.ts`
- `.wrangler/wine-sdd/task-5d-report.md`

## Self-review and remaining gates
The route is a thin adapter: HMAC/schema/error behavior remains owned by the existing handler, document policy and pinned Node fetch remain owned by the existing service, and durable authorization/claim/finish remain owned by the Task 5b repository. Database creation remains absent at module/build time. No fake store or repository object appears in route tests.

Task 5 route integration is complete for this narrowed slice. Task 8 must still compose Queue orchestration/recovery and aggregate cross-stage evidence/cache behavior. Task 13 must still run the full browser/runtime environment harness and deployment compatibility checks. Production migrations/rehearsal, Tavily credentials and allowance, activation, real merchant acceptance, and any production calls remain explicit later release gates.
## Review follow-up — malformed JSON assertion
The route implementation was unchanged. Review found the original assertion serialized the `Response` wrapper itself, which always produced `{}` and therefore could not prove parser details were sanitized. The malformed signed JSON behavior now has its own named test that awaits the response, asserts status 400, asserts the exact safe body `{code:"invalid_request",message:"Request body is invalid."}`, and retains the no-database-resolution assertion.

RED:
`pnpm.cmd --filter @wukong/web exec vitest run app/api/internal/wine-evidence-document/route.test.ts`
failed 1/3 at the new exact body assertion while deliberately expecting `message: "SyntaxError"`; the received body was `message: "Request body is invalid."`. This proves the assertion observes the response payload and rejects an unsafe/incorrect message.

GREEN:
The same command passed 1 file, 4 tests after setting the exact established sanitized response and splitting it into a descriptively named test. Output clean.