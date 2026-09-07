# OpenRouter listing provider

Date: 2026-09-08
Status: Design approved in conversation; written specification awaiting review.
Base: GitHub main `69b6e6fb7859388495602ef1b00a3b9645896540`.
Branch: `codex/openrouter-listing-provider`.

## Problem and outcome

The deployed listing runtime calls OpenAI directly. The operator supplied an
OpenRouter credential, so recent controlled processing attempts failed with HTTP
401 and `invalid_api_key`. Add an explicitly selected OpenRouter listing provider
that extracts supported source facts and generates listing copy through the
existing `ListingAIProvider` contract.

This change covers source implementation and synthetic verification. Deployment,
secret updates, paid requests and processing real merchant assets require a
separate activation decision. No database migration is required.

## Architecture and alternatives

Use a dedicated OpenRouter adapter in `packages/ai`, sharing the existing prompts,
schema validation, evidence checks and protected-fact checks where practical.
Keep transport-specific request and response mapping inside the adapter. Preserve
the existing OpenAI and fake providers.

A base-URL-only replacement is rejected: the existing provider assumes OpenAI
model names, pricing and provider attribution. Replacing the SDK throughout the
application is also unnecessary: the pipeline already has an injected provider
boundary.

Choose the transport during the implementation compatibility check: use the
existing Responses interface only if official OpenRouter documentation and a
synthetic SDK wire test establish support for all required request shapes.
Otherwise use OpenRouter chat completions with explicit JSON-schema output and
map its response into the existing contract. This decision must be recorded in
the implementation plan before adapter code is written.

## Configuration and credentials

- `AI_PROVIDER=openrouter` selects the new adapter explicitly.
- `OPENROUTER_API_KEY` is a server-side Worker secret issued by OpenRouter.
- `OPENROUTER_LISTING_MODEL` is a required OpenRouter model identifier. Do not
  reuse `gpt-5.6-terra` or assume a model by translating its name.
- Use the fixed OpenRouter API origin `https://openrouter.ai/api/v1`.
- Missing credentials or model configuration fail before sending a request.
- Never fall back to `OPENAI_API_KEY`, another provider, or another model.

Update Worker environment types, provider construction, rendered configuration,
deployment secret checks, runtime doctor, example configuration and runbooks.
Update the repository instruction that currently excludes OpenRouter to reflect
the user's approved provider choice.

Before activation, verify the selected model's image-input and structured-output
support using OpenRouter's public model and endpoint metadata. Require compatible
provider routing; model-level support alone is insufficient. No paid model call
is needed for configuration discovery. Do not introduce a paid PDF/OCR plugin or
silently omit unsupported assets; unsupported formats fail explicitly.

## Data, validation and accounting

Preserve the extraction and generation result shapes in `contracts.ts`, source
identifiers, factual grounding, missing-field handling and all review/export
eligibility rules. Treat provider JSON as untrusted and validate it locally.
Refusals, malformed output and unsupported inputs must not create an approved
listing or fabricate facts.

Persist the provider as `openrouter` and the actual selected model. Do not apply
OpenAI's default token prices to OpenRouter calls. The compatibility check must
establish the response cost/usage fields and define their mapping into the
existing numeric `estimatedCostUsd` field. If reported cost is unavailable, an
explicit validated model-specific estimate is required; missing accounting data
must never silently become zero. Account for both requests if output repair is
used. Resolve this mapping in the implementation plan before coding.

Keep timeouts bounded and preserve existing queue idempotency and repair limits.
Retain safe diagnostics: allowlisted status/code metadata only, without keys,
prompts, signed asset URLs, source content or raw provider error bodies.

## Verification and acceptance

Use synthetic data and a local stub transport only. No real workbook uploads,
merchant records, SHOPLINE writes or paid providers.

Required regression coverage:

1. Provider selection and missing-key/model failures before network activity.
2. Exact OpenRouter origin, authentication and configured model in the outgoing
   SDK request; no credential crossover or silent provider fallback.
3. Image extraction and structured JSON generation through realistic wire
   responses, including locally rejected malformed JSON, refusal and unsupported
   input cases.
4. Existing evidence and protected-fact validation under the new adapter.
5. Token/cost mapping, repair accounting and invalid/missing usage behavior.
6. Sanitized authentication, throttling, timeout and server failures.
7. Worker runtime/configuration/preflight selection for OpenRouter, alongside
   unchanged OpenAI and fake behavior.

Run focused AI and Worker tests, relevant configuration/runtime-doctor tests,
type checks and a Worker dry run. Report exact commands and results separately
from live verification, which is outside this implementation approval.

## Rollout boundary

The production Worker currently uses an older source baseline plus its provider
diagnostic patch. Main includes later product-shot work. Before any future
deployment, compare the intended Worker artifact with the deployed revision and
choose a reviewed isolated backport or explicitly approved full rollout. Do not
silently activate unrelated functionality. Preserve SHOPLINE writes disabled.

Cloudflare secrets cannot be read back for automatic migration. The operator
will save the existing OpenRouter credential under `OPENROUTER_API_KEY` using
the deployment platform; never request the key in chat. A later activation check
must verify deployed provider/model metadata before any separately authorized
controlled processing attempt.

## Reference

- OpenRouter structured output and endpoint capability requirements:
  https://openrouter.ai/docs/guides/features/structured-outputs

## Written-spec review

Reviewed against the approved conversational design: explicit provider, dedicated
configuration, existing product safeguards, synthetic regression coverage and a
separate activation boundary are retained. Transport and accounting compatibility
are implementation-plan prerequisites, not claims of working integration.
