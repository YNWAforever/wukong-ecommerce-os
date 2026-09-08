# OpenRouter Listing Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Process listing facts and copy with an explicitly configured OpenRouter credential while preserving existing product safeguards.

**Architecture:** Add an OpenRouter chat-completions adapter behind ListingAIProvider. Share existing factual validation with OpenAI; select provider credentials, model and required secrets consistently in runtime and deployment tooling.

**Tech Stack:** pnpm 11.7, Node 24, TypeScript, existing OpenAI SDK 6.x, Zod 4, Vitest, Cloudflare Workers.

## Global constraints

- Base: main `69b6e6fb7859388495602ef1b00a3b9645896540`.
- Worktree: `C:/Users/laich/Documents/WukongEommerce/worktrees/openrouter-listing-provider`, branch `codex/openrouter-listing-provider`.
- No database migration is required.
- Use synthetic data and a local stub transport only. No real workbook uploads, merchant records, SHOPLINE writes or paid providers.
- Preserve SHOPLINE writes disabled.
- No deployment, secret changes, automatic merge or paid retry under this implementation approval.
- Preserve other worktrees, existing OpenAI/fake behavior and review/export policy.
- Do not copy production environment files or request keys in chat.

## Compatibility decisions

Use `POST https://openrouter.ai/api/v1/chat/completions`, non-streaming multipart image messages, strict JSON-schema output and `provider.require_parameters=true`. The inspected Responses overview establishes stateless access but does not establish every required image/schema shape with the installed SDK. Choose documented chat formats for this slice; no protocol fallback.

Use the existing SDK's `chat.completions.create`, injected fetch, a fixed base URL, `maxRetries: 0` and a bounded timeout. Parse JSON locally so output and usage are evaluated together. SDK retries must not multiply queue retries.

Map `usage.prompt_tokens`, `usage.completion_tokens` and `usage.cost` into existing inputTokens, outputTokens and estimatedCostUsd. Require finite non-negative cost and safe non-negative integer counts. Explicit zero is valid; missing usage is not. Missing/invalid accounting throws terminal ProviderOutputError, never a transport error that causes a new billed call. Do not infer OpenAI prices, fetch a secondary generation record or invent zero cost.

Permit at most one schema-output repair after a complete response with valid accounting and no refusal. Sum both response envelopes' usage in request-local state. Do not repair transport errors, absent usage, truncation, refusal or grounding violations. Use the original source request plus a static schema reminder. Existing ai_runs persists successful steps only; this change does not create a complete failed-attempt billing ledger.

Support JPEG, PNG and WebP HTTPS URLs. Reject PDF and other formats before dispatch in OpenRouter for this slice, leaving OpenAI PDF support intact. No paid file parser is enabled. Model is required explicitly, with no production default. Reject auto/free routers, dynamic aliases and online/search variants. Validate real model and endpoint capabilities before later activation; synthetic tests do not prove live model quality.

Sources inspected on 2026-09-08:

- https://openrouter.ai/docs/guides/overview/multimodal/image-understanding
- https://openrouter.ai/docs/guides/features/structured-outputs
- https://openrouter.ai/docs/api_reference/responses/overview
- https://openrouter.ai/docs/cookbook/administration/usage-accounting

## Task 1: Share factual validation without changing OpenAI

**Files:** Create `packages/ai/src/listing-output-validation.ts` and `packages/ai/src/listing-provider-errors.ts`; modify `packages/ai/src/openai-listing-provider.ts` and its colocated test.

**Interfaces:** Move/export existing extractionOutputSchema, generationOutputSchema, generationInputRuntimeSchema, FACT_KEYS, assertFactsGrounded, assertGenerationGrounding and buildSafeListing with private helpers unchanged. Move existing error classes verbatim, re-export from the old path. Transport, pricing and asset mapping remain in OpenAI.

- [x] Establish baseline:

```powershell
corepack.cmd pnpm@11.7.0 install --frozen-lockfile
corepack.cmd pnpm@11.7.0 --filter @wukong/ai test
corepack.cmd pnpm@11.7.0 --filter @wukong/worker test
node --test tests/cloudflare-config.test.mjs tests/runtime-doctor.test.mjs
```

Expected: passing baseline. Record environmental failures separately.

- [x] Add class-identity regression:

```ts
import { ProviderOutputError as publicError } from "./index.js";
import { ProviderOutputError as legacyError } from "./openai-listing-provider.js";
expect(publicError).toBe(legacyError);
```

- [x] Perform the mechanical move, keeping exact existing implementations. The old provider re-exports classes:

```ts
export {
  ListingProviderError,
  UnsupportedAssetError,
  ProviderApiError,
  ProviderRefusalError,
  ProviderOutputError,
} from "./listing-provider-errors.js";
```

Validation imports errors from the new error module, never an adapter. Existing evidence/altered-fact tests prove behavior preservation.

- [x] Run all AI tests and typecheck; inspect diff for unchanged prompts/schema/prices/request shapes. Commit explicit files: `refactor: share listing output validation`.

## Task 2: OpenRouter adapter with real SDK wire tests

**Files:** Create `packages/ai/src/openrouter-listing-provider.ts` and its test; modify `packages/ai/src/index.ts`.

**Consumes:** Task 1 validation/errors, existing contracts and prompts.
**Produces:** OpenRouterListingProvider implementing extract/generate; OpenRouterListingProviderConfig contains required apiKey/model and optional fetch/now/timeoutMs.

- [x] Write failing synthetic tests with the installed SDK and injected fetch. Define `extraction` using existing synthetic facts (nullable facts null, arrays empty, packQuantity 1), evidence empty and missingFields empty. No asset bytes leave the process:

```ts
const sent: Request[] = [];
const stubFetch: typeof fetch = async (input, init) => {
  sent.push(new Request(input, init));
  return Response.json({
    id: "synthetic",
    object: "chat.completion",
    created: 0,
    model: "test/vision-model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: JSON.stringify(extraction),
          refusal: null,
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
  });
};
const provider = new OpenRouterListingProvider({
  apiKey: "synthetic-key",
  model: "test/vision-model",
  fetch: stubFetch,
});
const result = await provider.extract({ assets: [], note: null });
expect(sent).toHaveLength(1);
expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
expect(sent[0]!.headers.get("authorization")).toBe("Bearer synthetic-key");
expect(result.usage.estimatedCostUsd).toBe(0.001);
```

- [x] Run `corepack.cmd pnpm@11.7.0 --filter @wukong/ai exec vitest run src/openrouter-listing-provider.test.ts`; expect missing-adapter failure.
- [x] Validate a trimmed nonempty key, explicit author/model slug (max128 characters; reject routers/variants above) and integer timeout1000..600000. Construct:

```ts
const client = new OpenAI({
  apiKey: config.apiKey,
  baseURL: "https://openrouter.ai/api/v1",
  maxRetries: 0,
  fetch: config.fetch,
  timeout: config.timeoutMs ?? 120_000,
});
```

- [x] Build extraction messages with existing system prompt and serialized prompt/allowedAssetIds/note first; validate all assets before appending image parts:

```ts
const imagePart = {
  type: "image_url" as const,
  image_url: { url: asset.readUrl },
};
```

Require HTTPS without URL credentials and supported MIME. Build generation messages from existing validated input and safe projection. Use zodResponseFormat from openai/helpers/zod:

```ts
const request = {
  model: config.model,
  stream: false as const,
  messages,
  response_format: zodResponseFormat(schema, schemaName),
  provider: { require_parameters: true },
};
const response = await client.chat.completions.create(request, {
  signal: AbortSignal.timeout(timeoutMs),
});
```

Here messages are the typed chat array built in the preceding step, schema is extractionOutputSchema or generationOutputSchema, and schemaName is listing_extraction or listing_generation. Omit OpenAI-specific reasoning defaults, tools and plugins.

- [x] Validate envelope usage before repair:

```ts
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  completion_tokens: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  cost: z.number().finite().nonnegative(),
});
```

Require exactly one choice; refusal/content filtering is ProviderRefusalError, non-stop finish is ProviderOutputError. Parse JSON and output schema, allowing one bounded schema repair as specified. Keep totals local to each call and validate sum overflow. Record valid response model or requested model when absent; reject inconsistent model identity across repair responses.

- [x] Apply shared grounding after schema validation; derive missing fields using FACT_KEYS. Return unchanged result contracts, prompt version and measured latency.
- [x] Sanitize transport errors to ProviderApiError. Port the deployed diagnostic pattern deliberately from worker-provider-diagnostics: allowlisted status/code, fixed event/provider/phase only, no raw error/prompts/URLs. Do not broaden queue retry policy; document existing transport retries.
- [x] Add regressions for successful generation; image wire shape; unknown sources; forged note; altered facts/images; PDF/missing key/model before fetch; one repair summed usage; exhausted repair; refusal/truncation; missing/negative/non-finite/zero usage; malformed JSON; concurrent totals; and 401/429/503/timeout with one SDK attempt and sanitized logs.
- [x] Run complete AI suite/typecheck, export adapter/config, commit explicit files: `feat: add openrouter listing provider`.

## Task 3: Consistent Worker selection and deployment preflight

**Files:** Modify `apps/worker/src/worker-env.ts`, `apps/worker/src/cloudflare-runtime.ts` and its test; create `scripts/listing-provider-config.mjs`; modify `scripts/render-cloudflare-config.mjs`, `scripts/verify-cloudflare-secrets.mjs`, `scripts/runtime-doctor.mjs`, `tests/cloudflare-config.test.mjs`, `tests/runtime-doctor.test.mjs`.

**Produces:** listingProviderSecretNames(base, provider), consumed by renderer, secret verifier and doctor. Preserve composition with productShotSecretNames and existing repository provider attribution.

- [x] Write failing tests for OpenRouter without OpenAI model/key, missing OpenRouter configuration, and preserved OpenAI/fake/product-shot combinations.
- [x] Extend WorkerEnv with openrouter selection and optional OPENROUTER_API_KEY/OPENROUTER_LISTING_MODEL. Add factory branch:

```ts
if (provider === "openrouter") {
  return new OpenRouterListingProvider({
    apiKey: required(env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY"),
    model: required(env.OPENROUTER_LISTING_MODEL, "OPENROUTER_LISTING_MODEL"),
  });
}
```

- [x] Implement shared required-secret selection:

```js
export function listingProviderSecretNames(base, provider) {
  if (!["fake", "openai", "openrouter"].includes(provider))
    throw new Error("AI_PROVIDER is invalid");
  return provider === "openrouter"
    ? [
        ...base.filter((name) => name !== "OPENAI_API_KEY"),
        "OPENROUTER_API_KEY",
      ]
    : [...base];
}
```

- [x] Render only OPENROUTER_LISTING_MODEL for OpenRouter, with matching slug validation. Preserve OpenAI/fake rendering. Compose listing and product-shot secret selection everywhere. Doctor uses intended provider in predeploy and observed Worker metadata for live checks, not a misleading local default.
- [x] Preserve exact-secret checks: obsolete OPENAI_API_KEY is unexpected for OpenRouter. Report it; never automatically delete it. Test generated output contains secret names only, provider attribution is openrouter and SHOPLINE remains disabled.
- [x] Run AI/Worker suites plus both Node config/doctor suites. Commit explicit files: `feat: configure openrouter worker runtime`.

## Task 4: Runbook, verification and review handoff

**Files:** Modify `.env.example`, `CLAUDE.md`, `docs/runbooks/production-ai-runtime.md`; create `docs/superpowers/plans/2026-09-08-openrouter-listing-provider-results.md`.

- [x] Document exact configuration:

```dotenv
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_LISTING_MODEL=
```

Key comes from OpenRouter key management and belongs in Cloudflare Worker secrets. Model comes from public catalog plus compatible image/schema endpoint metadata. Blank examples deliberately fail validation. Describe image-only scope, reported cost mapping, one repair, SDK retries disabled, existing queue retries and successful-step-only accounting.

- [x] Update only the OpenAI-only repository instruction. Document activation as a separate reviewed action: compare deployed old Worker baseline, choose isolated backport/full rollout, verify model metadata, save dedicated secret, explicitly resolve obsolete secret, deploy reviewed artifact, verify metadata, then separately authorize one real processing cycle. Never read back or print a key.
- [x] Run local verification and record exact results:

```powershell
corepack.cmd pnpm@11.7.0 --filter @wukong/ai test
corepack.cmd pnpm@11.7.0 --filter @wukong/worker test
node --test tests/cloudflare-config.test.mjs tests/runtime-doctor.test.mjs tests/ci-workflow.test.mjs
corepack.cmd pnpm@11.7.0 --filter @wukong/ai typecheck
corepack.cmd pnpm@11.7.0 --filter @wukong/worker typecheck
corepack.cmd pnpm@11.7.0 format:runtime:check
corepack.cmd pnpm@11.7.0 runtime:forbidden:check
git diff --check
```

- [x] Build package dependencies topologically excluding Worker deploy scripts. Render preview config from the synthetic inputs in tests/cloudflare-config.test.mjs with openrouter and test/vision-model. Run only a dry run:

```powershell
corepack.cmd pnpm@11.7.0 --filter @wukong/worker exec wrangler deploy src/cloudflare.ts --dry-run --config ../../.wrangler/wrangler.generated.jsonc --outdir dist
```

Never invoke deploy:preview or deploy:production. A synthetic model proves wiring only.

- [x] Review branch diff for unrelated schema, source binding, SHOPLINE or product-shot changes. Record reproduced unsupported-provider baseline, test counts, compatibility proof and remaining live gates in results file.
- [x] Commit explicitly staged docs: `docs: document openrouter setup and verification`. Stop for review; no merge/deployment/real processing.

## Self-review

All seven acceptance categories map to Tasks1-3; Task4 covers rollout and runtime verification. Chat transport and required reported usage resolve compatibility choices before implementation. No schema, SDK dependency, paid parser or provider fallback is introduced. Evidence consistency does not independently prove a model's reading of an image; factual review remains mandatory. Implementation and synthetic verification are complete; see the dated results file for actual commands and outcomes. Live verification has not run and remains separately authorized.
