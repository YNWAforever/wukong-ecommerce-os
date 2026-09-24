# Tavily Wine Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved automatic wine/spirits/sake identification, Tavily evidence lookup, grounded bilingual content and recoverable review workflow.

**Architecture:** Extend the immutable listing-operation pipeline with typed identity, evidence and content sections. Worker-only provider adapters execute bounded calls behind durable admission and separate Go/Tavily ledgers; Web accepts operations and renders their persisted results. Retain existing listing versions, field locks, evidence adoption and publication gates.

**Tech Stack:** TypeScript, Zod 4, pnpm 11.7, Node 24, Next.js 16, React 19, Cloudflare Workers/Queues, Neon/Postgres, Drizzle, Vitest, Playwright, OpenCode Go and Tavily REST APIs.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-09-16-tavily-wine-enrichment-design.md`; user approved the written document on 2026-09-16.
- Source baseline: `3ca5b99520e056bda99c0efbe87192e619026f04`; design commit `6cb5307`. Reverify HEAD before implementation and preserve newer fixes.
- Scope: wine, spirits, sake; English and Hong Kong Traditional Chinese.
- Provider remains `opencode-go`; exact model `deepseek-v4.1-flash`; no implicit provider/model fallback.
- Maximum 2 basic Search + 1 advanced Search, 5 results each; at most 1 basic Extract batch of 5 URLs.
- Reserve 5 Tavily credits for a full operation; Go and Tavily have separate units and caps.
- Up to 5 logical Go calls with at most 1 schema repair each: 10 physical calls, maximum 4096 output tokens each. Reviewed full-context reservation: USD 3.194880. Section regeneration has at most 4 physical Go calls, USD 1.277952, and no search.
- Preserve the existing USD 10 workspace cumulative Go cap and all unknown-cost holds; changing a policy must not mutate an accepted execution snapshot.
- External request timeout 30 seconds for Tavily; response cap 8 MiB; retained model text 16,000 characters per source with an explicit truncation marker.
- Total operation deadline 15 minutes; no new calls after expiry. Evidence cache TTL 7 days, workspace scoped, keyed by identity/policy/rules.
- Price, stock and internal SKU only come from merchant input. Never silently overwrite operator-owned or locked fields/sections.
- Preserve SHOPLINE disabled. Production Tavily credentials, credit allowance, migrations, activation and real merchant acceptance are explicit release gates.
- No paid calls, production changes or private fixture publication during ordinary implementation tests.
- Graph indexing of this checkout was previously blocked by approval review; do not bypass that block. Current graph lookup has no matching index; use targeted local reads when needed.
- Commands below run from repository root in the selected worktree. On Windows use `pnpm.cmd`, quote paths containing brackets, and use explicit `git add -- <paths>`.

## Delivery map and dependencies

| Task | Deliverable                                                  | Depends on           |
| ---- | ------------------------------------------------------------ | -------------------- |
| 1    | Versioned domain contracts and synthetic fixtures            | baseline             |
| 2    | Identity matching and claim adoption rules                   | 1                    |
| 3    | Tenant-safe persisted stage/evidence/credit records          | 1                    |
| 4    | Worker-only Tavily adapter                                   | 1                    |
| 5    | Safe document acquisition and cache                          | 2, 3, 4              |
| 6    | Go stage prompts, schemas and accounting                     | 1, 2                 |
| 7    | Atomic dual-budget admission                                 | 3, 6                 |
| 8    | Checkpointed Queue orchestration and recovery                | 5, 6, 7              |
| 9    | Candidate projection and section regeneration                | 2, 3, 6, 8           |
| 10   | Authenticated operation and read APIs                        | 7, 8, 9              |
| 11   | Upload/progress/review UI                                    | 10                   |
| 12   | Fixed evaluation set and baseline comparison                 | 1, 2, 6, 8           |
| 13   | Real-stack bilingual acceptance and deployment compatibility | 3–12                 |
| 14   | Authorized rollout and merchant acceptance                   | 13, release approval |

Each task must have a focused red/green cycle and a small commit. No task can be marked complete from code inspection alone. Feature flags stay off until the entire path is verified. These tasks are dependent slices of one workflow, not separately deployable products.

## Module and file ownership

Create focused modules rather than expanding `listing-pipeline.ts` or `listing-review-client.tsx` with another large implementation:

- `packages/core/src/wine-enrichment-contracts.ts`: versioned identity, claim, evidence and section schemas.
- `packages/core/src/wine-identity-match.ts`: deterministic matching and ambiguity outcomes.
- `packages/core/src/wine-claim-policy.ts`: source applicability, trust and conflict decisions.
- `packages/core/src/wine-content.ts`: section projection and locked-content merging.
- `packages/core/src/wine-enrichment-budget.ts`: operation-mode call/credit ceilings.
- `packages/core/src/wine-enrichment-fixtures.ts`: public synthetic fixture constructors used by tests.
- `packages/ai/src/tavily-provider.ts`: fixed-endpoint REST transport only.
- `packages/ai/src/wine-enrichment-provider.ts`, `wine-enrichment-prompts.ts`: bounded Go stage calls and prompt versions.
- `packages/db/src/repositories/wine-enrichment.ts`: durable stages, evidence and snapshots.
- `packages/db/src/repositories/search-budget-reservations.ts`: integer credit holds and settlement.
- `packages/db/src/wine-enrichment-compatibility.ts`: additive migration readiness checks.
- `apps/worker/src/wine-evidence-acquisition.ts`: search/document policy and cache orchestration.
- `apps/worker/src/wine-enrichment-pipeline.ts`: one durable stage per Queue delivery.
- `apps/worker/src/wine-enrichment-runtime.ts`: production dependency wiring and ledger observers.
- `apps/web/lib/wine-enrichment-service.ts`: authorized acceptance, confirmation and read model.
- `apps/web/components/wine-enrichment-progress.tsx`, `wine-identity-choice.tsx`, `wine-content-review.tsx`, `wine-evidence-panel.tsx`: four focused UI boundaries.

Existing files to extend: package exports, `packages/db/src/schema.ts`, `client.ts`, migration registry; `packages/jobs/src/cloudflare-queue.ts`; Worker `cloudflare.ts`, `cloudflare-runtime.ts`, `worker-env.ts`; Web intake/process/read routes and review composition; `.env.example`, runtime manifest/renderer/doctor, CI and real-stack fixture.

## Shared contracts

Task 1 defines these names. Subsequent tasks import them instead of inventing parallel shapes. All stored payloads carry `schemaVersion: 1`; accepted runs also carry `flowVersion: "wine-enrichment-v1"`. Existing runs without that marker execute the legacy path.

```ts
export type WineKind = "wine" | "spirits" | "sake";
export type Vintage =
  | { state: "known"; year: number }
  | { state: "unknown" | "not_applicable"; year: null };
export type IdentityStatus = "candidate" | "matched" | "needs_confirmation";
export type FieldObservation = {
  value: string | number | string[] | null;
  state: "observed" | "normalized" | "unknown" | "not_applicable" | "conflict";
  evidenceIds: string[];
};
export type ProductIdentity = {
  schemaVersion: 1;
  kind: WineKind;
  producer: string | null;
  productName: string | null;
  aliases: string[];
  cuvee: string | null;
  vintage: Vintage;
  volumeMl: number | null;
  packQuantity: number | null;
  marketVariant: string | null;
  barcode: string | null;
  abvPercent: number | null;
  category: Record<string, FieldObservation>;
  observations: Record<string, FieldObservation>;
  status: IdentityStatus;
};
export type EvidenceSource = {
  schemaVersion: 1;
  id: string;
  kind: "photo" | "merchant" | "web";
  assetId: string | null;
  url: string | null;
  title: string;
  domain: string | null;
  capturedAt: string;
  excerpt: string;
  location: string;
  documentDigest: string;
  contentScope: "label" | "note" | "snippet" | "document";
  truncated: boolean;
  identity: ProductIdentity | null;
  trust: "verified_official" | "reliable" | "unverified";
  independenceKey: string;
};
export type SupportedClaim = {
  id: string;
  field: string;
  value: string | number | string[];
  kind: "fact" | "recommendation";
  scope: "product" | "brand";
  evidenceIds: string[];
  premiseClaimIds: string[];
  state: "accepted" | "unknown" | "conflict" | "rejected";
  reason: string;
};
export type SectionKey =
  | "selling_points"
  | "introduction"
  | "tasting"
  | "pairing"
  | "serving"
  | "brand_background";
export type ContentSection = {
  key: SectionKey;
  en: string;
  "zh-Hant": string;
  claimIds: string[];
  locked: boolean;
  owner: "automatic" | "operator";
};
export type WineContent = {
  title: { en: string; "zh-Hant": string };
  sections: ContentSection[];
  seo: {
    title: { en: string; "zh-Hant": string };
    description: { en: string; "zh-Hant": string };
  };
  tags: string[];
};
export type WineStage =
  | "extraction"
  | "search_basic"
  | "verification"
  | "search_deep"
  | "verification_deep"
  | "generation"
  | "quality_check"
  | "commit_candidate";
export type WineMode = "full" | "research" | "copy" | "section";
export type QualityIssue = {
  path: string;
  code: string;
  blocking: boolean;
  evidenceIds: string[];
};
export type VerificationResult = {
  identity: ProductIdentity;
  claims: SupportedClaim[];
  needsDeepSearch: boolean;
  issues: QualityIssue[];
};
```

Record types above describe the interchange contract, not unrestricted Zod records: Task 1 rejects unknown category/observation/claim field names at runtime. Wine category keys: appellation, grapeVarieties, fermentation, maturation. Spirits: spiritType, ageYears, caskType, batch. Sake: brewery, grade, riceVariety, polishingPercent, brewingYear. Merchant fields are never category fields.

### Task 1: Contracts and reusable test fixtures

**Files:** Create core contracts/fixtures and `wine-enrichment-contracts.test.ts`; modify `packages/core/src/index.ts`. No migration or production behavior change.

**Interfaces:** Produce `productIdentitySchema`, `evidenceSourceSchema`, `supportedClaimSchema`, `wineContentSchema` and the shared types above. Produce `wineIdentity(overrides?: Partial<ProductIdentity>): ProductIdentity` and `webEvidence(overrides?: Partial<EvidenceSource>): EvidenceSource` synthetic fixture constructors.

- [ ] Write a contract test that accepts explicit NV and rejects an inferred year, merchant values in category fields, a web source without HTTPS URL and an unknown section key.

```ts
import { expect, it } from "vitest";
import { productIdentitySchema } from "./wine-enrichment-contracts.js";
import { wineIdentity } from "./wine-enrichment-fixtures.js";
it("distinguishes unknown from explicit non-vintage", () => {
  expect(productIdentitySchema.parse(wineIdentity()).vintage).toEqual({
    state: "unknown",
    year: null,
  });
  expect(
    productIdentitySchema.safeParse(
      wineIdentity({
        vintage: { state: "not_applicable", year: 2020 } as never,
      }),
    ).success,
  ).toBe(false);
});
```

- [ ] Run `pnpm.cmd --filter @wukong/core exec vitest run src/wine-enrichment-contracts.test.ts`; expect the missing module/export failure before implementation.
- [ ] Implement strict Zod objects and refinements: UUIDs for stored IDs, finite numerical bounds, 1800–2100 vintage years, positive volume/pack count, 0–100 ABV/polishing, ISO timestamps, HTTPS web sources, disjoint evidence source requirements and exact category key sets. A known value requires at least one evidence ID; unknown/non-applicable semantics cannot silently become zero.
- [ ] Implement fixtures with synthetic producer `Fixture Estate`, product `Reserve Red`, unknown vintage/market and no merchant data. Each fixture returns a fresh object so tests cannot share mutable arrays.
- [ ] Run the focused test, core typecheck and core build; expect zero failures. Commit the four explicit files: `feat(core): define wine enrichment contracts`.

### Task 2: Exact identity and evidence adoption policy

**Files:** Create `wine-identity-match.ts`, `wine-claim-policy.ts`, `wine-source-authority.ts` and their tests; modify core exports. Reuse normalization rules from `matched-enrichment.ts` and `fact-grounding-rules.ts` without broadening legacy behavior.

**Interfaces:**

```ts
export type IdentityMatch = {
  state: "matched" | "ambiguous" | "mismatch";
  reasons: string[];
};
export function matchWineIdentity(
  observed: ProductIdentity,
  candidate: ProductIdentity,
): IdentityMatch;
export function decideWineClaim(input: {
  identity: ProductIdentity;
  claim: SupportedClaim;
  sources: EvidenceSource[];
  lockedFields: ReadonlySet<string>;
}): SupportedClaim;
```

- [ ] Add tests for brand-only candidates, two names under one producer, 2019 versus 2020, NV versus unknown, 700 versus 750 ml, barrel/batch/age mismatches, unsupported aliases and absent market. Test a brand-level history claim independently from a product ABV claim.

```ts
it("rejects a different vintage despite matching producer and name", () => {
  const observed = wineIdentity({ vintage: { state: "known", year: 2019 } });
  const candidate = wineIdentity({ vintage: { state: "known", year: 2020 } });
  expect(matchWineIdentity(observed, candidate)).toEqual({
    state: "mismatch",
    reasons: ["vintage_conflict"],
  });
});
```

- [ ] Run both new core test files and observe failure.
- [ ] Implement ordered checks: producer/name must be present; use only verified aliases; each known identity dimension must agree or return a named reason. A candidate missing a known discriminating dimension remains ambiguous. Unknown market permits brand facts but cannot substantiate market-specific specifications.
- [ ] Implement claim policy: merchant-only fields reject web/photo adoption; operator locks always win; precise official sources can support facts; otherwise require two independent reliable agreeing sources. Distinct domains with identical excerpt hashes are not independent. Scores/awards require original identifiable authority and exact applicable vintage. Missing source IDs, insufficient snippet context and truncated supporting spans yield unknown/rejected, not accepted.
- [ ] Implement a reviewed source-authority registry keyed by domain and producer/authority with proof URL, proof digest, verification date and verifier identity. Persist registry entries through Task 3; source acquisition can read but cannot self-promote a source based on a model answer. An unregistered official-looking domain remains unverified; use independently reliable sources or leave the fact unknown. Add tests for expired/revoked registry entries and a domain belonging to a different producer.
- [ ] Treat an existing trusted observed value versus incompatible trusted exact-product fact as a blocking conflict. Wrong-product or unverified source noise is rejected without blocking. Recommendations require accepted premise claim IDs and explicit recommendation kind.
- [ ] Run focused tests and core build; commit `feat(core): match wine identities and adjudicate evidence`.

### Task 3: Durable stages, provenance and separate credit reservations

**Files:** Create `packages/db/drizzle/0041_wine_enrichment.sql`, the two new repositories and their `.integration.test.ts` files, plus `wine-enrichment-compatibility.ts`; modify `schema.ts`, `client.ts`, `index.ts` and compatibility tests. Verify 0041 is still unused before assigning it.

**Interfaces:** Add `repos.wineEnrichment` and `repos.searchBudgetReservations`. Repository methods take workspace from the existing transaction scope, never caller-supplied cross-tenant scope.

```ts
export type StageRecord = {
  runId: string;
  stage: WineStage;
  inputDigest: string;
  state: "started" | "succeeded" | "failed" | "skipped" | "unknown";
  output: unknown;
  dependencyDigest: string;
  updatedAt: string;
};
export type SearchCall = {
  runId: string;
  slot: "basic_1" | "basic_2" | "advanced_1" | "extract_1";
  maximumCredits: number;
  requestDigest: string;
};
export type WineEnrichmentRepository = {
  claimStage(
    input: Omit<StageRecord, "output" | "updatedAt" | "state">,
  ): Promise<boolean>;
  readStage(runId: string, stage: WineStage): Promise<StageRecord | null>;
  finishStage(input: StageRecord): Promise<boolean>;
  beginSearchCall(input: SearchCall): Promise<boolean>;
  finishSearchCall(
    input: SearchCall & { credits: number | null; status: string },
  ): Promise<boolean>;
  saveEvidence(runId: string, sources: EvidenceSource[]): Promise<void>;
  readEvidence(runId: string): Promise<EvidenceSource[]>;
};
```

- [ ] Write integration cases using the existing database fixture pattern: cross-workspace read denial; duplicate `(workspace,run,stage)` claims; duplicate search slot suppression; immutable successful outputs; stale dependency rejection; retention of unknown credits; transactional rollback when only one provider's budget can be admitted.
- [ ] Run `pnpm.cmd exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/wine-enrichment.integration.test.ts packages/db/src/repositories/search-budget-reservations.integration.test.ts`; expect missing readiness/repository errors on the isolated database.
- [ ] Add tenant-scoped stage, source snapshot, section snapshot, reviewed source-authority registry, search call and search credit reservation tables. All listing/run/version links use composite workspace foreign keys, supporting indexes and RLS; copy the existing runtime role/grant pattern from 0039/0040. Add `wine_enrichment` JSON to input/version snapshot extension where needed, nullable for legacy rows; never rewrite historical content.
- [ ] Search reservation has `held`, `settled`, `unknown` states and integer units. Serialize aggregate admission by locking the workspace row. Unknown retains the reserved amount. A slot never started is released; started without terminal usage remains unknown. Settlement is idempotent and cannot lower a previously terminal unknown hold without explicit reconciliation evidence.
- [ ] Existing `ai_runs` USD ledger remains separate. Extend its accepted task/stage names for wine verification/checks; never insert Tavily credits as `estimated_cost_usd`.
- [ ] Migration and readiness must check columns, constraints, grants and RLS as the actual non-owner runtime role. Run migration twice in the isolated environment; expect idempotent replay and existing rows still readable. Commit `feat(db): persist wine evidence stages and search credit holds`.

### Task 4: Tavily transport with deterministic cost bounds

**Files:** Create `packages/ai/src/tavily-provider.ts`, `tavily-provider.test.ts`; modify AI exports. Do not install a SDK; use injectable native fetch and Zod.

**Interfaces:**

```ts
export type TavilyResult = {
  url: string;
  title: string;
  content: string;
  rawContent: string | null;
};
export type TavilyResponse = {
  results: TavilyResult[];
  requestId: string | null;
  credits: number | null;
};
export class TavilyProvider {
  constructor(config: { apiKey: string; fetch?: typeof fetch });
  search(input: {
    query: string;
    depth: "basic" | "advanced";
    allowedDomains: string[];
  }): Promise<TavilyResponse>;
  extract(input: { urls: string[] }): Promise<TavilyResponse>;
}
```

- [ ] Use actual request serialization with mock fetch; assert fixed `https://api.tavily.com/search` and `/extract`, bearer secret, POST JSON, `auto_parameters:false`, `include_answer:false`, `include_usage:true`, `max_results:5`, general topic and explicit depth. Test 401/429/timeout exactly once; missing credits remain null.

```ts
it("does not retry an ambiguous provider failure", async () => {
  let calls = 0;
  const provider = new TavilyProvider({
    apiKey: "fixture",
    fetch: async () => {
      calls++;
      throw new TypeError("network unavailable");
    },
  });
  await expect(
    provider.search({
      query: "Fixture Estate Reserve Red",
      depth: "basic",
      allowedDomains: [],
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});
```

- [ ] Observe red with `pnpm.cmd --filter @wukong/ai exec vitest run src/tavily-provider.test.ts`.
- [ ] Implement response streaming with byte counting, abort at 8 MiB, a 30-second signal and sanitized status/request IDs. Reject malformed URLs/usage and negative/non-integer credits. Extract only accepts 1–5 already approved HTTPS URLs and fixed basic depth. Do not log request queries, content, headers or credential-bearing errors.
- [ ] Search inputs are produced from typed identity rather than arbitrary merchant notes. Validate response size even when Content-Length is absent or false. Unexpected provider cost above reserved bound is recorded as a discrepancy and disables further calls in the operation.
- [ ] Run focused tests and AI typecheck; commit `feat(ai): add bounded Tavily search and extract transport`.

### Task 5: Safe source acquisition and scoped evidence reuse

**Files:** Create `apps/worker/src/wine-evidence-acquisition.ts` and tests, `apps/web/app/api/internal/wine-evidence-document/route.ts` with route/integration tests, `apps/web/lib/website/wine-document-service.ts`, and `packages/jobs/src/wine-document.ts`. Keep the existing Node DNS/TLS-pinned public fetch in Web; Workers must not import `node:https`, TLS socket or DNS transport modules. Reuse `public-fetch.ts`, `robots-policy.ts` and `extract-document.ts` through a signed internal callback, following the existing `/api/internal/website-document` boundary. Tavily credentials and calls remain Worker-only.

**Interfaces:**

```ts
export type EvidenceRequest = {
  workspaceId: string;
  runId: string;
  identity: ProductIdentity;
  allowedDomains: string[];
  policyDigest: string;
  rulesVersion: string;
  now: string;
  forceRefresh: boolean;
};
export type EvidenceAcquisition = {
  sources: EvidenceSource[];
  status: "complete" | "partial" | "unavailable";
  warnings: string[];
};
export function wineEvidenceCacheKey(input: EvidenceRequest): string;
```

- [ ] Test exact expiry boundary, different workspace/policy/vintage, URL de-duplication, private-address redirects, robots denial, missing product schema, content truncation, unverified official domains and duplicated syndicated content.
- [ ] Run `pnpm.cmd --filter @wukong/worker exec vitest run src/wine-evidence-acquisition.test.ts`; verify red.
- [ ] Build the cache key from workspace, normalized full identity, policy digest and rules version; store `capturedAt` and enforce seven days at read time. Successful evidence is immutable; force refresh produces new evidence IDs.
- [ ] Define strict internal request `{workspaceId,runId,sourceId,inputRevision,kind:"robots"|"product"}`; sign the exact body/path/timestamp with existing queue HMAC. The Node handler loads the persisted source URL and approved run state, validates workspace/revision/deadline, applies existing DNS pinning and robots rules, and returns bounded document metadata/text. It must not accept a caller-provided arbitrary URL. Worker pins the callback origin to `WEBSITE_FETCH_BASE_URL`, never a searched page. Test missing/expired signatures, mutated bodies, stale runs and source IDs from another workspace.
- [ ] Generate basic identity queries from producer/name/known vintage/volume. Source body snippets do not alter query instructions. Rank only inside the policy-allowed set; fetch robots and approve redirect destinations before reading pages. Add generic article extraction with source spans when JSON-LD Product is absent, retaining existing product extraction as one parser.
- [ ] The optional Extract batch runs once for public, policy-approved candidates, never after robots denial or access refusal. Verify result URL and returned document provenance; retain snippet/document distinction, hash and truncation metadata. Claims unsupported by retained spans remain unknown.
- [ ] Begin and finalize each Tavily slot through Task 3 before/after network I/O. On a duplicate claimed slot, return its stored terminal result or stop as unknown; do not call again. Run existing Web fetch/robots safety suites, internal callback tests and new Worker tests; commit `feat(worker): acquire scoped and policy-checked wine evidence`.

### Task 6: Versioned Go prompts and grounded section outputs

**Files:** Create `packages/ai/src/wine-enrichment-provider.ts`, `wine-enrichment-prompts.ts` and tests; modify shared chat transport, AI exports, `apps/worker/src/operation-ai.ts`, AI run stage types and their tests. Keep legacy OpenRouter and Go adapter contracts intact.

**Interfaces:**

```ts
export type WineExtraction = {
  identity: ProductIdentity;
  evidence: EvidenceSource[];
};
export type GenerationRequest = {
  identity: ProductIdentity;
  claims: SupportedClaim[];
  current: WineContent | null;
  lockedPaths: string[];
  tone: string;
  claimPolicy: string[];
  section: SectionKey | null;
};
export interface WineEnrichmentProvider {
  extract(input: import("@wukong/ai").ExtractionInput): Promise<WineExtraction>;
  verify(input: {
    identity: ProductIdentity;
    sources: EvidenceSource[];
  }): Promise<VerificationResult>;
  generate(input: GenerationRequest): Promise<WineContent>;
  check(input: {
    content: WineContent;
    claims: SupportedClaim[];
  }): Promise<QualityIssue[]>;
}
```

- [ ] Capture outgoing stage requests in tests; assert pinned model, stable run session, correct role prompt version and separately committed physical calls. Test wrong model, missing usage, refusal, JSON truncation and unknown source/claim IDs.
- [ ] Run new AI tests and operation-ai test, observe red.
- [ ] Refactor the existing internal chat completion engine into a reusable typed JSON completion function; keep maxRetries zero, two attempts per logical call and exact Go model identity. `WineEnrichmentProvider` is a separate adapter so its extract return type cannot accidentally replace the legacy `ListingAIProvider` contract.
- [ ] Version all four prompts `wine-extract@1.0.0`, `wine-verify@1.0.0`, `wine-generate@1.0.0`, `wine-check@1.0.0`. Snapshot them with contract/rules versions. Verification emits candidates and claim suggestions; Task 2 makes final deterministic adoption decisions. Dispatch by the stored flowVersion before applying prompt-version guards: legacy runs keep LISTING_PROMPT_VERSIONS and the legacy adapter; wine-enrichment-v1 validates its four-role version set and uses the new provider. Do not mutate the global legacy prompt constants to force new flow support.
- [ ] Extraction prompt explicitly handles category differences, original excerpts, unknown versus NV, age versus vintage and commercial-field exclusion. Verification prompt treats source text as quoted untrusted material and prohibits invented source IDs. Generation restricts to accepted facts/recommendations, keeps locked content and emits structured bilingual sections. Check prompt reports path-specific issues without rewriting values.
- [ ] Reserve evidence-linked factual output and premise-linked recommendation output separately. Validate every ID/span, value, brand/product scope and lock before accepting. Failure after one schema repair is terminal for that stage; quality rejection does not start an unbudgeted rewrite loop.
- [ ] Run full AI tests, Worker operation-ai tests and typechecks; commit `feat(ai): add versioned wine verification and writing stages`.

### Task 7: Atomic dual-provider admission and immutable policy

**Files:** Create `packages/core/src/wine-enrichment-budget.ts` and tests; modify `paid-listing-policy.ts`, profile schema, `apps/web/lib/listing-operation-service.ts` and admission tests. Add an explicit `wineEnrichment` policy alongside legacy listingAi.

**Interfaces:**

```ts
export function wineOperationBudget(mode: WineMode) {
  return mode === "section" || mode === "copy"
    ? { goPhysicalCalls: 4, goReservedUsd: "1.277952", tavilyCredits: 0 }
    : { goPhysicalCalls: 10, goReservedUsd: "3.194880", tavilyCredits: 5 };
}
```

Actual reservation derives the monetary amount from the reviewed model registry and bounded output count, then asserts agreement with the numbers above; no arbitrary cheaper token estimate.

- [ ] Test modes, underpriced models, exhausted Go cap, exhausted Tavily cap, missing secret capability, duplicate operation keys and partially satisfiable budgets. Integration test two concurrent admissions competing for the last five credits.

```ts
it("reserves a full workflow rather than the old four-call ceiling", () => {
  expect(wineOperationBudget("full")).toEqual({
    goPhysicalCalls: 10,
    goReservedUsd: "3.194880",
    tavilyCredits: 5,
  });
  expect(wineOperationBudget("section").tavilyCredits).toBe(0);
});
```

- [ ] Observe red, implement mode-specific validation and reserve both ledgers in the same workspace-locked transaction before outbox creation. Roll back the operation acceptance if either reservation fails.
- [ ] Snapshot operation mode, selected section, full policy, identity/input digest, prompt versions, rules, absolute deadline and limits. Preserve unknown holds and existing USD10 cap. New policy defaults disabled; an absent policy stays on legacy listing processing.
- [ ] Restrict actual stage call slots to the immutable limits; no caller-supplied credit/call ceiling can increase them. Confirm terminal settlement handles zero-start skipped stages separately from ambiguous started calls.
- [ ] Run focused core/Web tests and isolated budget integration tests; commit `feat(admission): reserve immutable Go and Tavily budgets together`.

### Task 8: Durable Queue stages and safe recovery

**Files:** Create `apps/worker/src/wine-enrichment-pipeline.ts`, `wine-enrichment-runtime.ts`, tests; modify `packages/jobs/src/cloudflare-queue.ts` and tests, Worker `cloudflare.ts`, `cloudflare-runtime.ts`, repository outbox wiring.

**Interfaces:** Add optional `flowVersion: "wine-enrichment-v1"` and `stage: WineStage` to the new envelope variant; legacy v2 messages retain exact parsing/key behavior. The run still owns all accepted input; Queue fields cannot override it. Add `packages/jobs/src/wine-document.ts` exports and test callback serialization separately from Queue envelopes.

```ts
export function wineStageMessageKey(runId: string, stage: WineStage): string {
  return `wine-run:${runId}:${stage}`;
}
export const WINE_STAGE_ORDER: WineStage[] = [
  "extraction",
  "search_basic",
  "verification",
  "search_deep",
  "verification_deep",
  "generation",
  "quality_check",
  "commit_candidate",
];
```

- [ ] Write Queue tests proving each delivery advances at most one stage, duplicate messages do not repeat calls, cancelled/superseded runs start no call and incompatible retry lineage cannot reuse evidence.
- [ ] Run `pnpm.cmd --filter @wukong/worker exec vitest run src/wine-enrichment-pipeline.test.ts` and jobs schema tests; observe red.
- [ ] For each delivery: load accepted run; verify workspace/input revision/flow/deadline; lock and claim stage; release transaction; perform bounded work; lock again and verify current revision; persist stage result and next-stage outbox atomically. Outbox dedupe uses run plus stage, not just run ID.
- [ ] Basic stage can execute its two distinct slots, recording after each. Verification marks whether deep work is necessary; skip deep stages with explicit skipped records otherwise. Cache hit skips network and releases unused credits on settlement.
- [ ] On lost response, persist unknown physical call and stop automatic replay. On loss between result commit and Queue ack, read committed stage/output/outbox and advance without repeating network. A claimed stage with no terminal call is recovered conservatively, not lease-retried into another billable call.
- [ ] Full/research mode traverses all necessary stages. Copy/section mode verifies saved identity/evidence digest and expiry, then starts generation; no search. An expired section dependency returns `evidence_refresh_required` rather than silently researching.
- [ ] If search fails but photographed identity is complete, proceed with photo-only claims and partial warning. Ambiguity/conflict creates needs_info candidate; it never activates an incorrect complete version. Before commit, apply locks and current revision checks again; stale outputs remain inspectable only.
- [ ] Run existing recovery tests plus new real Queue tests, including 15-minute deadline using an injected clock. Commit `feat(worker): run wine enrichment as recoverable Queue stages`.

### Task 9: Content projection, edit ownership and section regeneration

**Files:** Create `packages/core/src/wine-content.ts`, tests; modify working listing/input/version projection and `apps/web/lib/listing-claim-support.ts`. Persist section ownership with the existing input revision, not client-only state.

**Interfaces:**

```ts
export function renderWineDescription(
  content: WineContent,
  locale: "en" | "zh-Hant",
): string {
  return content.sections
    .map((section) => section[locale].trim())
    .filter(Boolean)
    .join("\n\n");
}
export function mergeWineSections(
  current: WineContent,
  candidate: WineContent,
): WineContent {
  const protectedByKey = new Map(
    current.sections
      .filter((section) => section.locked || section.owner === "operator")
      .map((section) => [section.key, section]),
  );
  const sections = candidate.sections.map(
    (section) => protectedByKey.get(section.key) ?? section,
  );
  for (const section of protectedByKey.values()) {
    if (!sections.some((next) => next.key === section.key))
      sections.push(section);
  }
  return { ...candidate, sections };
}
```

- [ ] Test locked sections omitted from new output, existing operator text, legacy full-description edits, absent optional paragraphs and stale evidence. Title/SEO/tags remain protected by existing field ownership in addition to section merging.
- [ ] Observe red with the new core suite.
- [ ] Apply the section merge only to validated candidates; project description deterministically for existing export and delivery readers. Old descriptions without a reliable section mapping are protected as a whole, not heuristically split.
- [ ] Candidate differences show proposed content, source IDs and dependency versions. Adoption checks expected input revision/base version; section-only regeneration cannot modify other sections or protected commercial values.
- [ ] Extend claim support to section paths, maintaining the binding between committed version, accepted claims and source snapshots. Test saved-source edits invalidate only dependent claims and copy; identity edits invalidate product evidence across sections.
- [ ] Run core projection tests and existing Web review/delivery regression suites; commit `feat(content): preserve manual wine sections across regeneration`.

### Task 10: Operation APIs and durable UI read model

**Files:** Create `apps/web/lib/wine-enrichment-service.ts` and tests; create `apps/web/app/api/listings/[id]/wine-enrichment/route.ts`, `apps/web/app/api/listings/[id]/wine-enrichment/identity/route.ts`, `apps/web/app/api/listings/[id]/wine-enrichment/regenerate/route.ts` and adjacent `route.test.ts` files. Extend existing listing/run read routes.

**Interfaces:** POST wine-enrichment accepts `{mode,expectedInputRevision,baseVersionId}` plus Idempotency-Key. POST identity accepts selected candidate ID and the same revision/base guards. POST regenerate accepts `{mode:"copy"|"section",section?,expectedInputRevision,baseVersionId}`. GET existing run returns:

```ts
export type WineProgress = {
  runId: string;
  inputRevision: number;
  stage: WineStage | null;
  state:
    | "queued"
    | "running"
    | "needs_info"
    | "in_review"
    | "failed"
    | "superseded"
    | "cancelled";
  completedStages: WineStage[];
  candidates: ProductIdentity[];
  issues: QualityIssue[];
  enrichment: "complete" | "partial" | "unavailable";
  goEstimatedUsd: string | null;
  tavilyCredits: number | null;
};
```

- [ ] Test unauthorized/member/operator roles, cross-tenant IDs, missing idempotency keys, unknown candidate IDs, two tabs editing and repeated acceptance. Confirm errors do not expose API keys, source private URLs or provider raw payloads.
- [ ] Run focused Web route tests and observe red.
- [ ] Delegate acceptance to existing listing transaction service with Task 7's mode branch; do not call providers in HTTP handlers. Identity confirmation validates a persisted candidate against the exact run, writes a new input revision/audit and creates a new operation.
- [ ] Extend read model with persisted stage results; do not derive completion from elapsed time. Distinguish blocking issues from optional missing data. Keep server-side publication/required-field checks authoritative.
- [ ] Follow existing database integration test placement under `apps/web/app/**` so the root integration config includes them. Run route unit/integration suites; commit `feat(api): expose wine research and section regeneration operations`.

### Task 11: Three-screen operator experience

**Files:** Create the four UI components in the map and their `.test.tsx` files; modify `listing-intake-form.tsx`, `listing-processing-panel.tsx`, `listing-review-client.tsx`, `apps/web/lib/review-ui-copy.ts`, locale dictionaries discovered through existing imports, and listing detail page composition.

**Interfaces:** Components consume `WineProgress`, `WineContent`, `EvidenceSource[]`, `QualityIssue[]` and explicit callbacks that call Task 10 APIs. Server state remains the source of truth.

- [ ] Write interaction tests: preserve completed uploads after one file fails; navigate away/back and show current stage; select persisted identity candidate; inspect original source excerpt; edit a paragraph; regenerate another paragraph without changing the edited one.
- [ ] Run focused component tests and observe red before wiring.
- [ ] Intake uses one primary action with optional merchant data and front/back/package guidance. Progress lists real stages and recovery actions; no fake completion percent. Ambiguity shows candidate differences in name/year/volume/market with accessible radio controls.
- [ ] Review shows bilingual editable sections, a blocking-issue count, optional-data notices and expandable evidence drawer with URL/excerpt/time/scope/truncation. Present field/section diff before explicit adoption. Source links use safe external-link attributes.
- [ ] Distinguish re-research, regenerate all copy and regenerate section; show when network search/credits may be involved. Prompt before discarding unsaved edits; preserve the existing locale-switch state behavior.
- [ ] Validate keyboard navigation, screen-reader labels, loading/error/empty states and both locales. Run existing intake/processing/review suites plus new tests; commit `feat(web): add guided wine enrichment and evidence review`.

### Task 12: Fixed 60-case evaluation and measurable comparison

**Files:** Create `packages/ai/fixtures/wine-enrichment/manifest.json`, public synthetic label/source fixtures, `packages/ai/src/wine-enrichment-eval.ts`, `.test.ts`, `packages/ai/scripts/wine-enrichment-eval.ts`; modify AI package scripts and evaluation documentation.

**Interfaces:** Manifest entries define `id`, `kind`, image fixture references, frozen source references, labeled identity/claims, expected ambiguity, required tags and privacy classification. Evaluation reports accuracy and coverage separately.

- [ ] Write evaluator tests before adding provider output fixtures; verify that abstaining on every case cannot pass, wrong identity/cross-vintage claims fail and recommendations are not counted as supported factual claims.

```ts
export function correctedBaselineErrors(
  before: boolean[],
  after: boolean[],
): number {
  if (before.length !== after.length) throw new Error("case_set_mismatch");
  const errors = before.filter((value) => !value).length;
  if (errors === 0) return after.every(Boolean) ? 1 : 0;
  const corrected = before.filter(
    (value, index) => !value && after[index],
  ).length;
  return corrected / errors;
}
```

- [ ] Observe red with the evaluator suite, then implement per-case identity matching, answerable-field accuracy, supported factual claim ratio, optional section coverage and correction counts. Reject mismatched fixture/source/prompt hashes between baseline and candidate runs.
- [ ] Populate 30 wine, 15 spirits and 15 sake independently labeled cases covering all approved boundaries; distinct case count is not achieved by duplicating one sample with new IDs. Keep unlicensed/private real images out of git; synthetic tests do not establish merchant acceptance.
- [ ] Capture baseline outputs before changing live prompts and candidate outputs with identical frozen inputs. Report mocked/frozen evaluation separately from authorized live timing. CLI defaults offline; a live flag alone is insufficient without configured approved scope and budget.
- [ ] Gate zero wrong auto-confirmations, zero protected-value overwrites/cross-vintage awards, no regression in core accuracy, at least 20% correction of baseline errors and non-collapsed auto-confirmation coverage. Record p50/p95, sample count, tokens, credits and unknown costs. The p95≤180s target requires live measurements, not mocked timing.
- [ ] Commit public fixtures/evaluator only after manual label review: `test(eval): add fixed wine enrichment accuracy benchmark`.

### Task 13: Real-stack browser acceptance and deployment consistency

**Files:** Create `tests/e2e/wine-enrichment.spec.ts`, extend `tests/e2e/real-stack-fixture.ts` and its established local server harness, `.github/workflows/ci.yml`; modify runtime config scripts, manifest, `.env.example`, Worker env/health and their tests; create `docs/runbooks/wine-enrichment.md`.

**Runtime inputs:** `WINE_ENRICHMENT_ENABLED=false` default on producer and Worker; Worker-only `TAVILY_API_KEY`; server-only policy version/cap in workspace profile. Health reports flow support and build SHA, never key values. New code remains dormant for legacy operations.

- [ ] Test manifest denies Tavily key on Vercel, renderer adds secret only when enrichment enabled, health capability mismatch blocks new flow and Go model remains exact. Test existing legacy runs are handled even while the new feature is disabled.
- [ ] Run red config/route tests, implement conditional secret/capability checks and updated reservation compatibility. Keep the existing unused OpenAI secret decision separate; no unsolicited credential deletion.
- [ ] Exercise real local Postgres, object storage, Queue and Web with deterministic synthetic Go/Tavily HTTP responses. Scenarios: normal exact match, ambiguous vintage, true conflict, Tavily outage fallback, duplicate Queue delivery, mid-run manual edit, return after navigation, expired cache, source injection, unauthorized tenant and section regeneration.
- [ ] Use authenticated UI fixture enrollment; capture screenshots through Playwright after assertions for upload, progress, ambiguity and final bilingual review. Never label synthetic provider screenshots as live merchant acceptance. Keep screenshot/trace/runtime IDs in test artifacts and CI artifact upload.
- [ ] Run the documented local service prerequisites, then:

```powershell
pnpm.cmd exec turbo run build --filter=@wukong/db
pnpm.cmd --filter @wukong/db db:migrate
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd test:integration
pnpm.cmd build
pnpm.cmd exec playwright test tests/e2e/wine-enrichment.spec.ts
pnpm.cmd format:runtime:check
pnpm.cmd runtime:forbidden:check
```

Use an explicitly isolated database for migrations/tests; never run these commands against production credentials. The real-stack fixture must configure its documented local ports/provider endpoints before Playwright starts.

- [ ] Expected: new and existing tests pass; no duplicate physical calls; correct budgets/tenant boundaries; screenshots and exact runtime evidence retained. Record baseline/environment failures separately. Commit `test(runtime): verify full wine enrichment workflow and rollout gates`.

### Task 14: Authorized rollout and merchant acceptance

**Files:** Update `docs/runbooks/wine-enrichment.md` and add `docs/implementation/wine-enrichment-verification.md`. Private evidence stays in ignored artifacts; public report contains aggregate results only.

- [ ] Record exact reviewed commit, green CI, preview deployment, readiness response, migration rehearsal result and pending external gates. Recheck current HEAD/production release before deployment; preserve any newer changes.
- [ ] Prepare the concrete migration diff, Worker artifact, producer flags, Tavily secret installation path and proposed workspace credit allowance. Get authorization only for items not already authorized in the session; design approval does not install secrets or enable paid Tavily traffic.
- [ ] After authorization, rehearse migration on an isolated branch and validate runtime-role grants. Apply additive migration, deploy Worker that supports both old/new flows with new admission off, deploy matching Web, verify capability, then enable the approved workspace policy and flags. Do not accept new envelopes before the consumer supports them.
- [ ] Verify real processing for 6 approved products, 2 per category. Record run/stage IDs, provider statuses, facts and source applicability, actual/estimated/unknown usage, durations, resulting version and merchant corrections. Do not publish to SHOPLINE.
- [ ] Merchant validates identity and content; capture actual browser screenshots if tooling is available. If unavailable, explicitly leave browser acceptance open and deliver backend evidence without claiming complete user-journey verification.
- [ ] Rollback admission by disabling the new feature for new operations; existing accepted runs retain a compatible consumer and immutable policy, drain or cancel with recorded outcomes. Do not drop evidence tables, remove secrets or clear unknown holds. Reverting Web code alone is not sufficient if new envelopes remain queued.
- [ ] Report completed implementation and measured gates separately from pending merchant/production evidence. Commit documentation with accurate results and explicit limitations.

## Verification and review checkpoints

- After Tasks 1–2: domain rules review; no provider activity needed.
- After Tasks 3–7: tenant boundaries, calls/credits and unknown settlement review.
- After Tasks 8–10: end-to-end service flow and race/recovery review.
- After Tasks 11–13: usability, bilingual browser evidence and regression gate.
- Task 14 only executes under its concrete release authorization.

## Plan self-review coverage

| Approved spec                                      | Tasks                        |
| -------------------------------------------------- | ---------------------------- |
| Scope and existing-module reuse (§1–2)             | 1–3, 6, 8–11                 |
| Upload, progress, review (§3)                      | 8–11, 13                     |
| Identity and category fields (§4)                  | 1–2, 6, 12                   |
| Tavily, safe sources and privacy (§5)              | 2, 4–5, 13                   |
| Adoption/conflict policy (§6)                      | 2, 8–10, 12                  |
| Prompts and bilingual full page (§7)               | 6, 9, 11–12                  |
| Persistence, cancellation, reuse/retry (§8)        | 3, 5, 7–10, 13               |
| Independent budget ceilings (§9)                   | 3–4, 6–8, 13–14              |
| Fixed evaluation, browser and merchant gates (§10) | 12–14                        |
| Dependency order and production gates (§11)        | task dependency table, 13–14 |

All task states are initially unchecked. A committed plan is not implementation evidence.
