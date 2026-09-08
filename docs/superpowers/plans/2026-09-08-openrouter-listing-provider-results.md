# OpenRouter listing provider implementation results

Date: 2026-09-08. Runtime implementation verified at `456e2c784c2306aebf585e2fbaad247bd2f3f983`. Branch: `codex/openrouter-listing-provider`; base: `69b6e6f`. Source implementation and synthetic verification completed. No live activation was performed.

## Change and compatibility evidence

Tasks 1–3 added shared validation/errors, a dedicated OpenRouter adapter using the existing OpenAI SDK, and consistent Worker/renderer/secret-verifier/doctor selection. The default example remains OpenAI; selecting OpenRouter requires its dedicated key and explicit model. No database schema, migration, SDK dependency, paid parser, provider fallback, review/export source-binding logic, SHOPLINE implementation or product-shot behavior was changed. Provider secret composition preserves the existing product-shot configuration. Two ingress tests were updated for sanitized health metadata; ingress implementation and authentication were unchanged.

The Task 3 synthetic RED run failed four of 18 focused Worker cases, including the unsupported OpenRouter provider constructor, missing key/model expectations and health metadata. New renderer/helper/doctor tests also initially failed. Task 2 initially failed because the adapter module did not exist. These are the reproduced implementation baselines. The earlier production `401 invalid_api_key` incident involved an OpenRouter credential reaching direct OpenAI; it was not repeated with a live or paid call during this implementation.

The actual installed SDK is exercised with injected local fetch responses in 60 OpenRouter cases. They establish the fixed chat-completions origin and dedicated authentication, configured model, image multipart ordering, strict JSON schema and required compatible parameters, preflight rejection, evidence/fact safeguards, one repair with summed request-local usage, terminal refusal/truncation/accounting failures, concurrency isolation, and sanitized transport diagnostics with one SDK attempt. This is wire compatibility evidence, not live model capability or image-reading quality evidence.

## Final local verification

Commands use repository-local binaries because the Windows pnpm shim stalled in prior task verification. AI typecheck includes both package source and scripts, matching the package command.

From `packages/ai`:

```powershell
node node_modules/vitest/vitest.mjs run
```

Passed: 125 tests in five files.

From the worktree root:

```powershell
node apps/worker/node_modules/vitest/vitest.mjs run apps/worker/src --exclude '**/*.integration.test.ts'
node --test tests/cloudflare-config.test.mjs tests/runtime-doctor.test.mjs tests/ci-workflow.test.mjs
node packages/ai/node_modules/typescript/bin/tsc -p packages/ai/tsconfig.json --noEmit
node packages/ai/node_modules/typescript/bin/tsc -p packages/ai/scripts/tsconfig.json --noEmit
node apps/worker/node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json --noEmit
node scripts/check-runtime-format.mjs
node scripts/check-runtime-format.mjs --forbidden-runtime
git diff --check
```

Worker: 170 tests in 15 files passed. Node: 78 passed (56 configuration/doctor plus 22 CI). Both AI typechecks and Worker typecheck passed. Runtime formatting, forbidden-runtime scan and whitespace checks passed. The unchanged `playwright.config.ts` emits the pre-existing `MODULE_TYPELESS_PACKAGE_JSON` warning in CI tests; it is not a regression or changed in this slice. The plan's Markdown formatting and one adapter-test wrapping difference were corrected in this documentation task. The controller authorized the test formatting change; it has no semantic changes. A post-edit CI rerun exposed two literal runbook assertions; explicit provider-specific secret commands and the accurate five-secret listing-only count resolved them without test or runtime changes.

Package-only builds were run topologically, never invoking Worker deployment scripts:

```powershell
$names = @('core','jobs','ai','assets','shopline','db')
foreach ($name in $names) {
  node packages/ai/node_modules/typescript/bin/tsc -p "packages/$name/tsconfig.json"
  if ($LASTEXITCODE -ne 0) { throw "Package build failed: $name" }
}
```

All six passed. An initial attempt assumed a compiler at `packages/core/node_modules/typescript/bin/tsc`, which is absent; rerunning with the already verified AI compiler resolved that environment-only command path issue. No source change was needed.

The renderer used only synthetic preview inputs:

```powershell
$env:CLOUDFLARE_ENV = 'preview'
$env:CLOUDFLARE_HYPERDRIVE_ID = '00000000000000000000000000000000'
$env:BUILD_SHA = (git rev-parse HEAD)
$env:AI_PROVIDER = 'openrouter'
$env:OPENROUTER_LISTING_MODEL = 'test/vision-model'
$env:S3_BUCKET = 'wukong-opak-preview-assets'
$env:S3_ENDPOINT = 'https://00000000000000000000000000000000.r2.cloudflarestorage.com'
$env:S3_REGION = 'auto'
$env:S3_FORCE_PATH_STYLE = 'false'
$env:PRODUCT_SHOT_PROVIDER = 'disabled'
node scripts/render-cloudflare-config.mjs
if ($LASTEXITCODE -ne 0) { throw 'Synthetic config render failed' }
Remove-Item Env:CLOUDFLARE_ENV
Push-Location apps/worker
try {
  node node_modules/wrangler/bin/wrangler.js deploy src/cloudflare.ts --dry-run --config ../../.wrangler/wrangler.generated.jsonc --outdir dist
  if ($LASTEXITCODE -ne 0) { throw 'Worker dry run failed' }
} finally { Pop-Location }
```

Passed with Wrangler 4.112.0: total upload 2424.06 KiB, gzip 433.91 KiB, then `--dry-run: exiting now.` The generated bundle selected `openrouter` / `test/vision-model`, dummy Hyperdrive, `SHOPLINE_ADAPTER=mock`, `SHOPLINE_PUBLISH_ENABLED=false` and product shots disabled. `CLOUDFLARE_ENV` was cleared after rendering because Wrangler otherwise treats it as an environment selector. No deployment or secret installation occurred; the synthetic model proves wiring only.

## Remaining activation and product gates

- Verify the actual live Worker baseline before choosing an isolated backport or full rollout. The older isolated `7a14937` revision from `49e84a3` is last-observed incident context, not a current live query. The source base `69b6e6f` includes later product-shot changes; do not silently activate them.
- No real model was chosen or queried. Verify public image/schema endpoint metadata, then obtain separate secret/deployment authorization. Save a dedicated `OPENROUTER_API_KEY`, explicitly resolve the obsolete OpenAI secret under exact-name checks, and preserve rollback credential access. Verify safe deployed provider/model/build metadata before separately authorizing one processing cycle.
- JPEG, PNG and WebP only for this adapter. PDF fails before dispatch; OpenAI PDF support remains. No paid parser is configured.
- Evidence consistency and immutable fact checks cannot independently prove image interpretation. Human factual review and export source binding remain mandatory.
- `estimatedCostUsd` is provider-reported USD credits from `usage.cost`; one successful repair sums both responses. Missing/invalid accounting is terminal. SDK retries are disabled, but existing Queue transport retries can incur extra cost. Successful-step-only `ai_runs` persistence is not a full ledger of failed or unknown billed calls. No live billing proof exists.
- No merchant uploads, real processing, provider calls, production reads/writes, secret changes, migrations, SHOPLINE writes, merge, push or deployment were performed for this task. The branch stops for review.
