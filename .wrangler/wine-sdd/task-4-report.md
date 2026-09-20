# Task 4 Report: Bounded Tavily REST transport

## Implemented

- Added `TavilyProvider` using injected native `fetch`; no SDK and no runtime wiring.
- Fixed Search and Extract endpoints, bearer authentication, POST JSON, `redirect: "error"`, and a 30-second abort signal.
- Search serializes `auto_parameters: false`, `include_answer: false`, `include_usage: true`, `max_results: 5`, `topic: "general"`, allowed domains, and explicit basic/advanced depth.
- Extract accepts only 1-5 HTTPS URLs, always uses basic depth, and requests usage.
- Reads response bodies as streams and rejects both declared and actual bodies above 8 MiB.
- Validates Search and official Extract response shapes with Zod, including HTTPS result URLs and non-negative integer credits. Missing usage remains `null`.
- Maps official Extract results into the shared result contract with empty title and extracted text in both `content` and `rawContent`.
- Performs exactly one request. Provider status, network, timeout, malformed output, and cost discrepancy errors never include provider bodies, queries, headers, or credential-bearing cause messages.
- Exports transport types and constants from `@wukong/ai`.

## Interfaces

- `TavilyProvider.search(input): Promise<TavilyResponse>`
- `TavilyProvider.extract(input): Promise<TavilyResponse>`
- `TavilyResponse`: `{ results, requestId, credits }`; absent credits are `null`, never zero.
- `TavilyProviderError`: structured `code`, nullable sanitized `status` and `requestId`, nullable measured `credits`, and nullable `reservedCredits`.
- `cost_discrepancy` is thrown when measured Search/Extract credits exceed that physical call's reserved bound (basic Search 1, advanced Search 2, basic Extract 1). This preserves the measured amount so the runtime can retain an unknown hold, emit a discrepancy diagnostic, and disable later calls.

## TDD evidence

### RED 1

Command:

`pnpm.cmd --filter @wukong/ai exec vitest run src/tavily-provider.test.ts`

Expected failure: suite could not import `./tavily-provider.js` because production code did not exist.

### GREEN 1

Command: same focused command.

Result: 18/18 tests passed after implementing the initial bounded transport.

### RED 2

After checking the official Tavily Extract reference, added a test for its distinct result shape (`url` plus `raw_content`).

Command: same focused command.

Expected failure: `TavilyProviderError: invalid_output` because the initial shared parser required Search-only `title` and `content` properties.

### GREEN 2

Command: same focused command.

Result: 19/19 tests passed after adding endpoint-specific response schemas and deterministic Extract mapping.

## Final verification

- `pnpm.cmd --filter @wukong/ai exec vitest run src/tavily-provider.test.ts` — 1 file, 19 tests passed.
- `pnpm.cmd --filter @wukong/ai typecheck` — both TypeScript checks passed.
- `pnpm.cmd --filter @wukong/ai test` — 12 files, 211 tests passed.
- `git diff --check` — passed; Git emitted only its existing Windows LF-to-CRLF checkout warning for `index.ts`.

## Files changed

- `packages/ai/src/tavily-provider.ts`
- `packages/ai/src/tavily-provider.test.ts`
- `packages/ai/src/index.ts`
- `.wrangler/wine-sdd/task-4-report.md`

## Self-review

- Confirmed the module remains transport-only: no source-truth decisions, admission, ledger mutation, cache behavior, or runtime wiring.
- Confirmed no paid calls, environment changes, secret reads, logs, SDK dependency, or automatic retries.
- Confirmed redirects fail rather than forwarding the bearer secret.
- Confirmed official Extract output differs from Search and corrected this under a second red/green cycle.
- Search query construction from typed identity and stopping subsequent operation calls after `cost_discrepancy` remain caller/runtime responsibilities in later tasks, as required by the task boundary.

## Concerns

None.

## Review fix verification

Review fixes applied:

- Both Search and Extract response schemas now reject provider result arrays above the requested maximum of five.
- Every non-2xx response body is cancelled without reading or logging it before the sanitized status error is thrown. Cancellation failure remains best-effort and cannot expose provider content or replace status classification.

### Review RED

- `pnpm.cmd --filter @wukong/ai exec vitest run src/tavily-provider.test.ts` — 5 expected failures: over-returned Search and Extract arrays resolved, and 401/429/500 response streams were not cancelled.

### Review GREEN

- `pnpm.cmd --filter @wukong/ai exec vitest run src/tavily-provider.test.ts` — 1 file, 24 tests passed.
- `pnpm.cmd --filter @wukong/ai typecheck` — both TypeScript checks passed.
