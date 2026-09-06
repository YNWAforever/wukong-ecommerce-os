# Photoroom Product Shot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagent-driven-development is an alternative only if the user selects it.

**Goal:** Turn one uploaded bottle photo into a reviewed, white-background image with a stable export URL, using a replaceable Photoroom adapter.

**Architecture:** The Cloudflare worker owns background removal and durable attempts. A Node-only renderer creates the exact review candidate; short database transactions own leases, approval, and publication while external I/O stays outside transactions. Existing listing review and delivery eligibility remain authoritative.

**Tech Stack:** Node 24, pnpm 11.7, TypeScript, Next.js 16 / React 19 / plain CSS, Cloudflare Workers and Queues, Postgres/Drizzle/RLS, private S3/R2, native fetch, existing sharp, Vitest and Playwright.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-09-07-photoroom-product-shot-design.md`; spec commit `8f86a3d`. User approved the written spec before this plan.
- Baseline source: `fe64fb80ff5b1ff6d8efa4962828170b68adcfc2`. Before execution, fetch main, compare new changes, and create an isolated `codex/` worktree using using-git-worktrees. Preserve unrelated work and the merged workbench.
- One selected actual photo; white background; no generative restyling, extra angles, or label reconstruction.
- Input cap: 10 MiB encoded and 40 megapixels decoded, further restricted by any lower existing upload limit. Output: square JPEG up to 1600 by 1600, white, 80 percent inset, at most 2 MiB, no subject enlargement.
- Provider choice is Photoroom. Live dispatch is disabled by default. No credentials, merchant files, real photos, paid calls, deployments, production migrations, seeding, or SHOPLINE writes are authorized by this plan.
- All write routes resolve workspace and role server-side. Every mutation is audited. RLS uses the existing non-superuser application role. Queue redelivery cannot blindly repeat paid calls.
- Final image approval is bound to the observed version, source identity, candidate digest, and render version. Raw source images never substitute for a missing approved image in the new workflow.
- Keep native sharp out of the Cloudflare bundle. Add a Node-only package subpath rather than exporting the renderer from the shared assets barrel.
- Preserve legacy CSV columns, Bulk Update locked fields and source binding, existing brand-background behavior outside the new workflow, and unrelated auth/runtime behavior.
- The seven tasks form one vertical image workflow. New-product XLSX and merchant pricing/SKU/category rules require separate designs.

## Preparation and command conventions

Run commands from the execution worktree root. On Windows use `corepack.cmd pnpm@11.7.0`; below `pnpm` means that command. Existing root integration config is `vitest.integration.config.ts`, not a root unit config. Package tests run from package directories through `pnpm --filter`.

Use graph discovery first and verify source in the execution checkout. Confirm the next migration number before creating `packages/db/drizzle/0021_product_shots.sql`; if main has taken 0021, select the next free number and record it in the result document. This is a filename reconciliation, not permission to alter existing migrations.

Read `CLAUDE.md`, `CONTEXT.md`, `docs/runbooks/local-development.md`, and the approved spec. Start only isolated synthetic services using the repository fixture. Use its established integration URL variables, not a hard-coded database name such as task67_integration. Never print configured URLs or credentials. Record red/green test evidence as each task proceeds; do not report planned checks as passed.

## File and interface map

New source files:

| File                                                           | Responsibility                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/core/src/product-shot.ts`                            | State, identity, limits, retry decisions                   |
| `packages/ai/src/photoroom-product-shot-provider.ts`           | Bounded HTTP adapter only                                  |
| `packages/assets/src/product-shot-render.ts`                   | Node-only exact JPEG rendering                             |
| `packages/db/src/repositories/product-shots.ts`                | Scoped attempts, dispatch budgets, approvals, publications |
| `packages/jobs/src/product-shot-queue.ts`                      | Typed product-shot queue envelope                          |
| `apps/worker/src/product-shot-pipeline.ts`                     | Claim, provider call, checkpoint, recovery                 |
| `apps/web/lib/product-shot-service.ts`                         | Prepare candidate and review operations                    |
| `apps/web/lib/product-image-publication.ts`                    | Narrow public token lookup and asset response              |
| `apps/web/app/api/listings/[id]/product-shot/route.ts`         | Read/choose source/request attempt                         |
| `apps/web/app/api/listings/[id]/product-shot/prepare/route.ts` | Idempotent authenticated Node preparation                  |
| `apps/web/app/api/listings/[id]/product-shot/approve/route.ts` | Exact candidate image approval                             |
| `apps/web/app/product-images/[file]/route.ts`                  | Stable `.jpg` GET/HEAD endpoint                            |
| `apps/web/components/product-shot-review.tsx`                  | New white-only review flow                                 |

Colocate unit tests beside each source. DB integration tests belong under `packages/db/src/repositories`; route integration tests belong under `apps/web/app`, which the current root integration config includes. Do not put integration tests in an uncollected new lib folder.

Shared types in `packages/core/src/product-shot.ts`:

```ts
export type ProductShotState =
  | "queued"
  | "processing"
  | "cutout_ready"
  | "candidate_ready"
  | "approved"
  | "failed"
  | "outcome_unknown";
export type ShotIdentity = {
  workspaceId: string;
  listingId: string;
  sourceAssetId: string;
  sourceDigest: string;
  providerVersion: string;
  renderVersion: string;
};
export type ShotObservation = {
  attemptId: string;
  expectedVersionId: string;
  candidateDigest: string;
};
export type ShotCandidate = {
  assetId: string;
  digest: string;
  width: number;
  height: number;
  size: number;
  lowResolution: boolean;
};
export const PRODUCT_SHOT_LIMITS = {
  inputBytes: 10 * 1024 * 1024,
  inputPixels: 40_000_000,
  outputBytes: 2 * 1024 * 1024,
  canvas: 1600,
  inset: 0.8,
} as const;
export function nextShotAction(input: {
  state: ProductShotState;
  hasCutout: boolean;
  explicitFreshAttempt: boolean;
}): "reuse" | "prepare" | "dispatch" | "confirm_charge" {
  if (input.state === "approved" || input.state === "candidate_ready")
    return "reuse";
  if (input.hasCutout) return "prepare";
  if (input.state === "outcome_unknown" && !input.explicitFreshAttempt)
    return "confirm_charge";
  return "dispatch";
}
```

External route inputs use zod strict objects, UUID fields, and SHA-256 hex digests. They do not accept `workspaceId`, storage keys, provider URLs, or image bytes. The only upload path remains the existing validated asset upload/finalization flow.

### Task 1: Provider adapter and explicit image-call semantics

**Files:** Create `packages/core/src/product-shot.ts`, `packages/core/src/product-shot.test.ts`, `packages/ai/src/photoroom-product-shot-provider.ts`, and its test. Modify `packages/core/src/index.ts` and `packages/ai/src/index.ts` exports. Preserve `packages/ai/src/contracts.ts` compatibility.

**Interfaces:** Consume existing `ProductShotProvider`, `ProductShotInput`, `ProductShotResult`. Produce `PhotoroomProductShotProvider implements ProductShotProvider`, constructed with `{ apiKey: string; fetch: typeof globalThis.fetch; readSource: (assetId: string) => Promise<{ bytes: Uint8Array; mimeType: string }>; now: () => number }`. The caller binds readSource to the known workspace/listing; ignore provider-input readUrl entirely.

- [ ] Write a transport test that passes exactly one synthetic PNG and captures the outbound request. Decode multipart fields and assert only the selected bytes are sent. Add zero/multiple-asset rejection, >10 MiB rejection, provider 401/429/500, oversized streamed output, wrong content type, and connection timeout tests. Provider errors expose only stable error codes.

```ts
expect(request.url).toBe("https://sdk.photoroom.com/v1/segment");
expect(request.headers.get("x-api-key")).toBe("synthetic-key");
expect(form.get("image_file")).toBeInstanceOf(Blob);
expect(form.has("image_url")).toBe(false);
expect(result.usage.inputTokens).toBe(0);
expect(result.usage.outputTokens).toBe(0);
```

- [ ] Run `pnpm --filter @wukong/ai exec vitest run src/photoroom-product-shot-provider.test.ts` and `pnpm --filter @wukong/core exec vitest run src/product-shot.test.ts`. Expected first result: the new behavior fails because the adapter/contracts are absent, not a missing database or credential.
- [ ] Implement the shared types above and the adapter request using injected fetch, `AbortSignal.timeout(30_000)`, `redirect: "error"`, a multipart Blob, and `format=png`. Confirm the documented PNG option against the official quickstart before coding. Read the response stream with a 10 MiB cap, not an unbounded arrayBuffer. Require an image/png response and PNG signature; decoded safety is checked again by Task 2. Reject more than one asset before readSource. Return existing AIUsage with zero tokens, estimatedCostUsd 0.02, provider model identifier `photoroom-remove-background`, promptVersion used as adapter version, and measured latency. Record estimation explicitly, not as a provider invoice. Never retry fetch inside the adapter.
- [ ] Add tagged errors `rejected`, `rate_limited`, `invalid_output`, and `outcome_unknown`. Any request that may have reached the provider but lacks a safe completed result is outcome_unknown. Render/cache failures after a saved cutout never go through this adapter.
- [ ] Re-run the two targeted suites, then `pnpm --filter @wukong/ai typecheck`. Commit only Task 1 paths with `feat: add bounded photoroom adapter`.

### Task 2: Deterministic exact candidate rendering

**Files:** Create `packages/assets/src/product-shot-render.ts` and `packages/assets/src/product-shot-render.test.ts`. Modify `packages/assets/package.json` with a `./product-shot-render` subpath shaped like its existing `./product-shot-flatten` export. Do not change the shared assets barrel.

**Interfaces:** Consume PRODUCT_SHOT_LIMITS. Produce `renderProductShot(cutout: Uint8Array): Promise<{ bytes: Uint8Array; mimeType: "image/jpeg"; width: number; height: number; lowResolution: boolean }>`.

- [ ] Generate a synthetic transparent PNG with a colored rectangular subject. Assert actual output pixels, JPEG dimensions/size, aspect ratio and white corners. Add empty alpha, corrupt PNG, >40M decoded pixels, offset subject, no-upscale, and encoded-byte limits. This tests image output rather than only sharp call arguments.

```ts
const input = await sharp({
  create: {
    width: 200,
    height: 200,
    channels: 4,
    background: "#00000000",
  },
})
  .composite([
    {
      input: await sharp({
        create: {
          width: 40,
          height: 100,
          channels: 4,
          background: "#ff0000ff",
        },
      })
        .png()
        .toBuffer(),
      left: 15,
      top: 50,
    },
  ])
  .png()
  .toBuffer();
const output = await renderProductShot(input);
expect(output.mimeType).toBe("image/jpeg");
expect(output.bytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
expect(output.lowResolution).toBe(true);
```

- [ ] Run `pnpm --filter @wukong/assets exec vitest run src/product-shot-render.test.ts`; expect missing renderer failure.
- [ ] Decode once with sharp's `limitInputPixels: 40_000_000`, honor orientation, ensure RGBA, and reject fully transparent input. Find foreground bounds from nonzero alpha; crop those bounds. Choose canvas side `min(1600, ceil(max(subjectWidth, subjectHeight) / 0.8))`. Scale subject by `min(1, canvas * 0.8 / max(subjectWidth, subjectHeight))`; center with integer offsets. Composite on white, strip metadata, encode JPEG quality 90. Try quality 80 then 70, then reduce canvas by 20 percent until 320 minimum, preserving no-upscale. If still >2 MiB, fail `output_too_large`. Mark lowResolution when the initial subject longest dimension is below 1280. Do not discard small opaque islands silently; human review catches segmentation errors.
- [ ] Re-run the renderer suite and existing `src/product-shot-flatten.test.ts`. Verify the new export uses `types`, `development`, and `default` entries pointing to source/dist consistently.
- [ ] Commit explicit Task 2 files with `feat: render reviewed white product images`.

### Task 3: Durable attempts, budgets, and publication records

**Files:** Create `packages/db/drizzle/0021_product_shots.sql`, `packages/db/src/repositories/product-shots.ts`, and `packages/db/src/repositories/product-shots.integration.test.ts`. Modify `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`, and `packages/db/src/cli/audit-verify.ts` plus its existing tests.

**Interfaces:** Consume ShotIdentity, ShotCandidate and ShotObservation. Produce workspace-bound `ProductShotRepository`:

```ts
export interface ProductShotRepository {
  ensure(
    input: ShotIdentity & { actorId: string; explicitFreshAttempt: boolean },
  ): Promise<{ attemptId: string }>;
  claim(input: {
    attemptId: string;
    dailyLimit: number;
    now: Date;
  }): Promise<
    | { kind: "claimed"; leaseToken: string; sourceAssetId: string }
    | { kind: "skip" | "budget_exhausted" | "outcome_unknown" }
  >;
  saveCutout(input: {
    attemptId: string;
    leaseToken: string;
    assetId: string;
  }): Promise<void>;
  finishFailure(input: {
    attemptId: string;
    leaseToken: string;
    code: string;
    unknown: boolean;
  }): Promise<void>;
  saveCandidate(input: {
    attemptId: string;
    candidate: ShotCandidate;
  }): Promise<void>;
  approve(
    input: ShotObservation & { actorId: string },
  ): Promise<{ publicationToken: string }>;
  revoke(input: { publicationToken: string; actorId: string }): Promise<void>;
}
```

Also expose `get(attemptId)` returning identity, state, cutout asset, candidate, and lease metadata; `currentForListing(listingId)` returning the selected attempt; and `approvedForAsset({listingId, versionId, assetId})` returning a nonrevoked publication or null. Current selection must be a separate workspace/listing pointer so replacement and historical attempts coexist.

- [ ] Add isolated integration cases using the same admin/app URLs and helpers as neighboring repository suites. Explicitly create synthetic assets/listings in two workspaces. Test duplicate ensure, two concurrent claims, atomic daily limit, foreign asset rejection, expired processing lease -> outcome_unknown, cutout reuse, stale candidate approval, and revoked publication.

```ts
const claims = await Promise.all([claimSameAttempt(), claimSameAttempt()]);
expect(claims.filter((r) => r.kind === "claimed")).toHaveLength(1);
expect(await countDispatchedForSyntheticWorkspace()).toBe(1);
```

Here the two local test helpers wrap the new repository claim in separate `db.forWorkspace` transactions and count the dispatch ledger through the synthetic admin connection. Define them in this suite; never share global mutable test workspace IDs.

- [ ] Run `pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/product-shots.integration.test.ts`; expect missing table/repository behavior after a confirmed working isolated DB connection.
- [ ] Add attempts, current-selection, daily dispatch counters, and publication tables. Attempts store the full identity, generation ordinal, status, lease token/expiry, dispatched timestamp, cutout/candidate asset identities/digests, sanitized error, call estimate, actor/timestamps. Enforce composite workspace foreign keys, state CHECK constraints, uniqueness on identity plus generation ordinal, and a unique publication per candidate/approval binding. Require current selection before claim and before candidate save/approval. Publications pin final asset deletion with RESTRICT. Enable and FORCE RLS, restrict grants to necessary statements, and follow `app.workspace_id` policy conventions. Increment budget and mark processing in one transaction before I/O. An expired lease with dispatched timestamp never becomes a free automatic retry. Ordinary ensure returns the existing attempt; fresh retry requires explicitFreshAttempt and increments its ordinal.
- [ ] Implement short repository transactions and audit events: product_shot.requested, dispatched, cutout_saved, candidate_saved, failed, outcome_unknown, approved, revoked, and source_replaced. Persist events with each associated mutation. On saveCutout require the matching lease; saveCandidate compares current source and render version. Approval locks listing review state and current selection, checks observation, and does not mark the listing itself approved. Extend audit verification to these actions and foreign record checks.
- [ ] Re-run the integration suite, migration loading tests, and audit tests. Commit only Task 3 files with `feat: persist product shot attempts and approval bindings`.

### Task 4: Independent worker dispatch and recovery

**Files:** Create `packages/jobs/src/product-shot-queue.ts`, its test, `apps/worker/src/product-shot-pipeline.ts`, and its test. Modify `packages/jobs/src/{index,cloudflare-queue}.ts`, `apps/worker/src/{worker-env,ingress,queue-consumer,cloudflare-runtime,listing-pipeline}.ts`, `apps/web/lib/cloudflare-queue-runtime.ts`, their corresponding tests, `cloudflare-runtime.config.json`, `scripts/render-cloudflare-config.mjs`, `scripts/verify-cloudflare-secrets.mjs`, `.env.example`, and `tests/cloudflare-config.test.mjs`.

**Interfaces:** Consume Task 1 adapter and Task 3 repository. Produce a discriminated message:

```ts
export const PRODUCT_SHOT_INGRESS_PATH = "/ingress/product-shots";
export const productShotJobSchema = z
  .object({
    kind: z.literal("product_shot"),
    workspaceId: z.string().min(1),
    draftId: z.string().uuid(),
    attemptId: z.string().uuid(),
  })
  .strict();
export type ProductShotJob = z.infer<typeof productShotJobSchema>;
```

Export `runProductShot(job: ProductShotJob, deps: ProductShotPipelineDeps): Promise<void>`. Define ProductShotPipelineDeps in the same file with forWorkspace: Database["forWorkspace"] (or the existing exported forWorkspace function type if the concrete Database is a handle), providerFor: (identity: ShotIdentity) => ProductShotProvider, assetStore: AssetStore, providerName: "disabled" | "fake" | "photoroom", dailyLimit: number, and now: () => Date. Import Database from @wukong/db, AssetStore from @wukong/assets, and the provider contract from @wukong/ai; use the actual existing transaction callable rather than adding an untyped wrapper. Bind source reading to the persisted source asset, never the queue message alone.

- [ ] Add tests that dispatch the same queue message concurrently and after cutout persistence; assert provider invocation count remains one. Inject a provider timeout and assert outcome_unknown with no automatic second dispatch. Test budget denied and provider disabled before invocation, replaced source rejected, and malformed/unsigned ingress denied.
- [ ] Run `pnpm --filter @wukong/worker exec vitest run src/product-shot-pipeline.test.ts` and `pnpm --filter @wukong/jobs exec vitest run src/product-shot-queue.test.ts`; expect missing handler/schema failures.
- [ ] Implement: load current attempt -> validate configured provider/budget -> short claim transaction -> read selected asset -> provider call outside transaction -> persist cutout at deterministic private attempt key -> short saveCutout transaction. If storage/DB fails after dispatch but before checkpoint, retain unknown state unless the deterministic stored object can be validated and recovered. Never dispatch a second provider call during that recovery. Cutout-ready returns successfully and waits for Node preparation. Add the new discriminant to ingress and consumer before legacy listing-message handling, and use the existing listing queue transport/binding to avoid provisioning a new queue. Queue payload has no keys, signed URLs, or image bytes.
- [ ] Wire automatic attempt creation for the selected source during the new workflow's process request, independently of text generation. Do not wire the old optional inline product-shot step simultaneously: new workflow must have exactly one image dispatch path. Retain legacy tests and behavior when disabled. Extend runtime validation for PRODUCT_SHOT_PROVIDER (`disabled`, `fake`, `photoroom`), PHOTOROOM_API_KEY, and PRODUCT_SHOT_MAX_CALLS_PER_WORKSPACE_PER_DAY. Require positive finite integer budget for photoroom; disabled remains the committed preview/production default. Use existing HMAC ingress signing and never send the provider key to web clients.
- [ ] Re-run targeted queue/runtime tests and `pnpm --filter @wukong/worker typecheck`. Run the worker build with locally generated synthetic runtime configuration and inspect bundle/imports for sharp. This is `wrangler deploy --dry-run` through the existing build script, not deployment. Commit explicit Task 4 files with `feat: queue recoverable product shot processing`.

### Task 5: Exact preview, source replacement, and image approval

**Files:** Create the three product-shot API routes in the file map and colocated route tests; create `apps/web/lib/product-shot-service.ts`, `apps/web/components/product-shot-review.tsx` and their unit tests. Modify `apps/web/components/listing-review-client.tsx`, `apps/web/app/api/listings/[id]/process/route.ts`, `apps/web/lib/listing-approval.ts`, single and bulk approve routes and their tests. Add localized strings using the existing component locale pattern.

**Interfaces:** GET product-shot returns a sanitized state DTO with attemptId, source preview URL, candidate preview URL/digest, observed version, lowResolution and allowed actions. POST product-shot accepts `{sourceAssetId, expectedVersionId, explicitFreshAttempt:false}` by default; true is only allowed after an explicit fresh-attempt action. POST prepare accepts `{attemptId, expectedVersionId}`; POST approve accepts ShotObservation. No endpoint accepts workspace identifiers.

- [ ] Add factory-injected route tests for unauthenticated/foreign/member permissions, zero/multiple source selection, stale observations, invalid prepared output, and idempotent preparation. Verify preparation storage I/O happens outside DB transactions and saves the exact rendered asset. Verify changing the source invalidates current image approval without deleting an older publication.
- [ ] Run `pnpm --filter @wukong/web exec vitest run app/api/listings lib/product-shot-service.test.ts components/product-shot-review.test.ts`; expect missing route/behavior failures while existing tests remain executable.
- [ ] Implement the prepare factory using Node runtime, scoped asset read, Task 2 renderProductShot, private write, and Task 3 saveCandidate. Use deterministic candidate keys including cutout digest/render version; compare source/version again at save. GET has no mutation; the UI calls prepare only when state is cutout_ready and can retry after failure. Multiple prepares may repeat cheap rendering but converge on one immutable candidate. Preparation never calls the provider. Only the persisted JPEG is shown for approval.
- [ ] Implement side-by-side original/final review with fixed white, localized status/error/retry text, low-resolution notice, and keyboard-accessible controls. Choose the only eligible photo automatically; with several, require one main-photo selection. Abort stale reads on route changes and retain state in the database, not just React. Image approval records current candidate acceptance; existing listing approval promotes that exact candidate into canonical imageAssetIds and rebinds it to the resulting version in the same transaction. Do not rerender at listing approval. Existing listing factual confirmations and blocked flags remain mandatory. Include single/bulk approval tests to prevent either path bypassing image requirements or selecting the first historical cutout.
- [ ] Re-run route/component suites and existing listing approval integration tests. Commit explicit Task 5 files with `feat: review exact product shot candidates`.

### Task 6: Stable public delivery and export eligibility

**Files:** Create `apps/web/lib/product-image-publication.ts`, its test, `apps/web/app/product-images/[file]/route.ts` and its route test. Create `apps/web/app/api/listings/[id]/product-shot/publication.integration.test.ts`. Modify Task 3 migration/repository before merge, `packages/assets/src/listing-image-resolver.ts` and tests, web deliver route composition, `apps/worker/src/shopline-runtime.ts` and tests, `apps/web/lib/delivery-service.review-fix.test.ts`, and `.env.example`.

**Interfaces:** Produce `resolveApprovedProductImage({workspaceId, listingId, versionId, assetId}): Promise<string>` for exports, and `lookupPublishedImage(token): Promise<{workspaceId:string; storageKey:string; digest:string; size:number} | null>` for the server-only public response adapter. Route receives only filename/token and returns JPEG bytes or 404.

- [ ] Test no original, transparent cutout, unapproved candidate, foreign asset or stale binding can resolve as an export image for this workflow. Test published image access after advancing clock beyond the signed URL TTL, GET/HEAD content headers, invalid token 404, old-version retained URLs, and revoked publication 404. Test export without publication blocks with actionable feedback rather than falling back to source.
- [ ] Run `pnpm --filter @wukong/web exec vitest run lib/product-image-publication.test.ts app/product-images` and the new publication integration test via root integration config. Expect missing lookup/route behavior.
- [ ] Use a 32-byte cryptographically random base64url token, store only its SHA-256 hash in the lookup table, and produce the public URL once as `new URL('/product-images/' + token + '.jpg', configuredOrigin)`. Persist the returned URL alongside its versioned approval so it remains recoverable; never log it. Validate configured origin as HTTPS in production. Publication creation is idempotent for a given approved candidate, with concurrent creation protected by a uniqueness constraint.
- [ ] Implement a narrowly scoped SQL SECURITY DEFINER function taking only token hash and returning only active publication object coordinates. Fix search_path, fully qualify tables, revoke PUBLIC execution, grant only to wukong_app, and prohibit dynamic SQL. The application role must not gain unscoped SELECT on attempts/assets. Add SQL-level tests for execution grants and foreign-row isolation. Return rows only for a publication whose creation was validated in the scoped approval transaction; originals cannot be inserted as publication targets. Stream the stored final image through the Node route without a presigned redirect. Use `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, and `Cache-Control: no-store` so revocation takes effect. Find the active middleware/proxy entry through the graph and add an exact product-images route exception only if it currently intercepts this path; add an auth boundary test that adjacent API paths still require a session. Do not change general public-path matching.
- [ ] Extend image resolution with an optional publication-aware branch activated only for this new workflow. Keep legacy resolution unchanged. Web and worker delivery must re-evaluate current listing version and candidate publication binding; retain all current delivery policy/source checks and unchanged CSV delimiters/columns. Publication revocation blocks new export even if an older file exists. Run delivery unit tests, publication integration tests, and existing source-binding tests; commit explicit files with `feat: serve approved product images at stable urls`.

### Task 7: End-to-end acceptance, runtime checks, and handoff

**Files:** Create `tests/e2e/product-shot.spec.ts`, `docs/runbooks/product-shot-processing.md`, and `docs/superpowers/plans/2026-09-07-photoroom-product-shot-results.md`. Modify `tests/e2e/real-stack-fixture.ts`, `tests/e2e/real-stack-server.mjs`, runtime tests/config only for fake bindings, and `CONTEXT.md`.

- [ ] Add a synthetic fake provider controlled by local test fixtures only. Cover success, definitive failure and ambiguous completion. Prevent fixture code from choosing a real provider regardless of inherited developer environment. No new tests call Photoroom sandbox or production.
- [ ] Write browser acceptance cases using the real-stack fixture: one source auto-selected; several require selection; white candidate review; page reload preserves draft; failed processing retry; ambiguous retry asks about another charge; successful checkpoint reuse does not change copy/provider count; source replacement invalidates image approval; stale browser approval rejected; approved URL available anonymously; unapproved original remains private; listing eligibility still blocks export when facts are unconfirmed. Run both supported locales through existing locale helpers.
- [ ] Run `pnpm exec playwright test tests/e2e/product-shot.spec.ts --workers=1 --retries=0` with the isolated fixture configured. Record exact pass/fail counts and resolve failures before broad checks.
- [ ] Run required repository checks:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm build
pnpm format:runtime:check
pnpm runtime:forbidden:check
pnpm --filter @wukong/db audit:verify
pnpm exec playwright test tests/e2e/product-shot.spec.ts tests/e2e/workbench.spec.ts tests/e2e/catalog-usability.spec.ts tests/e2e/bulk-update-pilot.spec.ts --workers=1 --retries=0
```

All DB/audit/browser commands require verified synthetic URLs and locally migrated isolated services; use the existing runbook fixture rather than production environment files. Expected: all selected tests pass with zero unexpected skips, type/build checks pass, audit reports zero missing actions and zero accessible foreign records, and worker build has no native sharp import. Report any intentional migration-test skips separately. Do not rerun broad suites unless a new change/failure justifies it.

- [ ] Document proposed env names, where the administrator obtains the key, the public-origin contract, budget behavior, uncertain-charge retry behavior, and disabled-by-default runtime. Record which source/template risks remain: glass/label segmentation quality, provider billing and live configuration unverified, new-product XLSX absent, and SHOPLINE acceptance untested. A live single-photo trial, production migration/deployment, merchant upload and paid enablement remain separate actions requiring authorization.
- [ ] Commit exact Task 7 paths with `test: verify product shot workflow and runtime gates`. Request focused review of workspace isolation, paid-call recovery, approval/version binding and public lookup privilege. Stop after reviewable implementation; do not merge/deploy automatically. Shut down only owned synthetic services.

## Spec self-review and execution handoff

Coverage: provider selection and secrets -> Tasks 1/4; white exact rendering and limits -> Task 2; durable retries, cost limits and audit -> Tasks 3/4; simple operator flow and source selection -> Task 5; stable approved-only URLs and retention -> Task 6; production boundary, local regressions and live acceptance limits -> Task 7. Legacy August components are reused instead of reimplemented. The migration adds only the image workflow and does not change existing source-import evidence.

Before execution, verify snippets against current exported repository types; do not suppress type errors with any. The exact public resolver privilege and promotion transaction are review-critical and must pass integration tests before UI acceptance is considered sufficient. This plan is documentation, not evidence that any of these tasks have executed.
