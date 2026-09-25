# WukongCommerce: advisory Jev listing verification

Date: 2026-09-22
Status: design and written specification approved in conversation on 2026-09-22.

## Purpose and scope

Check generated English and Traditional Chinese product listings against supplied facts and evidence. Record narrow, typed judgments for evaluation without changing listing approval, compliance flags, delivery eligibility, or publishing behavior. The first release is an optional server-side advisory component, disabled by default.

Model routing, semantic retrieval, automatic correction, new review UI, and reasoning-trace classification are separate future work. This release does not access or request private model reasoning.

## Verified project context

The inspected checkout is `C:/Users/laich/Documents/WukongEommerce`, branch `claude/bulk-approve-error-handling`, baseline `c65b139`. Other worktrees exist; execution must recheck branch state and isolate implementation from unrelated work. This baseline is an inspection reference, not a deployment target.

`packages/ai/src/contracts.ts` defines extraction facts, field evidence, bilingual generation, and AI usage. `apps/worker/src/listing-pipeline.ts` owns generation, immutable version creation, evidence persistence, deterministic compliance scanning, and pipeline completion. `packages/db/src/repositories/ai-runs.ts` stores provider usage and supports aggregate cost reporting. Its current task union contains extract, generate, and product_shot; verification must be represented explicitly rather than disguised as generation.

## Input and question design

Introduce an injected `ListingVerifier` port alongside the existing listing provider. It receives the generated canonical listing, extraction facts, field evidence, and available source note. Credentials remain in the server-side adapter.

Construct a bounded state object containing only the relevant product data. Do not include credentials, signed asset URLs, unrelated workspace information, or customer records. Asset identifiers alone do not establish evidence. Image-only statements without usable text evidence are marked unassessed; this release does not add OCR or image interpretation.

Use independent Jev Noul questions in one request per listing. Each question asks whether a specific defect exists, with its full meaning in the instructions rather than only its identifier:

- Does the English title, description, or SEO content assert a factual product claim unsupported by the supplied evidence?
- Does the Traditional Chinese title, description, or SEO content assert an unsupported factual claim?
- For producer, vintage, origin, grape variety, volume, and ABV: does the generated content contradict the supplied facts or usable source evidence? Keep these dimensions separate.
- Do the two language versions disagree on material product facts?

Use ordinary code for exact numeric comparisons, required fields, schema validation, and evidence presence. Model checks supplement those checks. Extracted facts are model-derived inputs and must not be presented as independently verified source truth. Instruction-like content in source notes remains data; question instructions specify that it must not control the verifier.

Keep the check list fixed and bound serialized request state to 32 KiB of UTF-8 JSON. Oversized input yields an explicit unassessed result rather than silent evidence truncation. Missing evidence is distinct from contradiction. Wording and check identifiers are versioned.

## Result contract

Record schema version, question-set version, actual provider model, listing version ID, content digest, evidence digest, timestamp, and mode `advisory`. Each check records its stable ID, target fields, assessment state, and raw defect probability when assessed.

Assessment states are `assessed` and `insufficient_evidence`. Service outcomes are `completed`, `unavailable`, and `skipped`. A completed result can contain unassessed checks. Never manufacture probabilities for absent or invalid answers. This version exposes no overall pass/fail verdict and sets no approval threshold.

Require finite probabilities between zero and one and all expected response keys. An incomplete or malformed response produces `unavailable`, with a sanitized error category. Jev does not need to generate prose explanations; check labels and field references are defined by code.

## Pipeline and persistence

After successful generation, call the verifier outside database transactions, under the existing generation lease. Bound the entire verification operation to five seconds with no automatic retry in the first release. A provider failure produces an unavailable result and allows the normal listing workflow to continue.

When the generated listing version is persisted, bind the verification record to that exact returned version ID and content digest. Store the validated verification payload in a dedicated `verify` AI-run entry. Extend the AI-run types and any database task constraints consistently. Store only structured judgments, hashes, usage, and sanitized error categories in this entry; do not duplicate source content there.

Persist the AI-run entry and a matching audit event through the existing workspace-scoped transaction. Database persistence errors retain the worker's existing retry semantics; provider failures are converted to data before this transaction. Do not silently claim that a failed database write was recorded.

Use the pipeline idempotency key plus a verification suffix and question-set version for record uniqueness. Completed pipeline re-delivery reuses the recorded outcome rather than calling Jev again. A process crash before commit can cause another provider call on retry; do not claim exactly-once external execution or complete billing coverage for interrupted calls.

Historical results remain attached to their original immutable version. A new human-edited version never inherits the previous version's verification as a current result. No automatic re-verification on edits is included in this slice.

## Configuration and usage

Use `TYPESAFE_VERIFICATION_MODE=off|advisory`, default `off`; `TYPESAFE_API_KEY` for the server-side credential; and an explicit `TYPESAFE_MODEL` for reproducible evaluations. Validate the selected model against current TypeSafe documentation during implementation. Do not invent a credential or enable calls solely because a key happens to exist.

Record actual usage returned by the service, duration, and model. Compute estimated cost only from a verified, versioned rate configuration. If usable usage or pricing is missing, preserve that as unknown; never treat an unknown charge as zero. Update cost reporting as necessary to show both known totals and unknown-cost runs.

Logs contain identifiers, status, timing, and sanitized categories only. Source text, full model responses, prompts, secrets, and signed URLs must not appear in logs.

## Evaluation and acceptance

Use at least 40 synthetic labelled cases: 10 valid bilingual listings, 10 unsupported-claim cases, 10 factual contradictions, and 10 cross-language mismatches. Include correct translations that are not literal, non-vintage products, unit conversions, missing text evidence, conflicting evidence, and instruction-like source content. Keep a labelled holdout separate from threshold exploration.

Deterministic tests must cover mode off (zero calls), one batched request, valid probabilities, missing keys, out-of-range values, oversized input, missing evidence, timeout, provider errors, version binding, replay, workspace isolation, audit persistence, and unknown-cost reporting. Existing compliance and approval outcomes must be identical with advisory verification enabled or disabled.

An opt-in evaluation report shows each check's probabilities and labels, assessed-case coverage, unavailable counts, false-alarm and missed-error rates at explicitly named exploratory thresholds, measured latency, known estimated cost, and unknown-cost coverage. Thresholds are evaluation parameters only; they do not become production policy. No speed, accuracy, or cost improvement is claimed without measured WukongCommerce results.

Implementation can be verified with fakes and synthetic fixtures without a live account. A real-provider evaluation requires an authorized credential, explicit call budget, and approved data scope. Production migrations, deployment, and enabling live verification are separate release actions.

## Planned implementation boundaries

1. Define verifier input/result schemas and the deterministic question builder in `packages/ai`, with focused contract and evidence tests.
2. Add the TypeSafe adapter with strict response validation, request bounds, timeout, sanitized failures, and usage accounting.
3. Extend workspace-scoped AI-run persistence and audit support for version-bound advisory results and unknown-cost visibility.
4. Wire the optional verifier into the worker generation path, configuration, and replay tests.
5. Add labelled fixtures, an opt-in evaluation runner, and operational documentation.

The detailed implementation plan follows written-spec review. These boundaries are sequencing guidance, not completed implementation.

## References

- TypeSafe Noul: https://docs.typesafe.ai/primitives/noul.md
- Verification cascade: https://docs.typesafe.ai/cookbooks/sde_cascade.md
- Current documentation index: https://docs.typesafe.ai/llms.txt

## Specification review

Scope stays advisory. Missing evidence, provider failure, storage failure, and unknown billing have separate meanings. Listing identity is an immutable version, not a mutable draft ID alone. External calls occur outside transactions. Existing authorization, compliance, and publishing decisions remain deterministic. There are no unresolved behavior placeholders in this specification.
