# Opak UAT Rollout Runbook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `docs/runbooks/opak-uat-rollout.md`, the runbook governing the four-stage Opak UAT sequence (Package K of the master catalog-operations plan), with a live-verified go/no-go gate table, the rollback-source-file procedure, the `/jobs` reconciliation gap documentation, and a stage sign-off template.

**Architecture:** One new file, no code changes, no tests to run. The task breakdown below writes the document in three content-authoring passes (grouping related sections so each task is a manageable, self-checkable chunk) followed by a format-gate pass and one final commit — not one commit per task. A prose runbook isn't independently useful or reviewable half-written the way working, tested code is; this session's own precedent (every design spec and plan doc this session got exactly one commit, not several) applies here too. Each authoring task still gets its own verification step (grep-based section-presence and content checks) so mistakes are caught before the next task builds on top.

**Tech Stack:** Markdown only. Verification uses `grep`/`Read` for content checks and `node scripts/check-runtime-format.mjs` (the project's real diff-based format gate — not raw `prettier --check .`, which produces CRLF false-positives on this Windows checkout).

---

**Live-code discipline:** every fact in §2's gate table below was verified against the live checkout during this session's design pass (2026-09-03). Still, before Task 1 begins, confirm the two reference runbooks it must match haven't changed shape since they were last read.

**Environment:** pnpm is not reliably on PATH — use `corepack pnpm` for any command that needs it (only Task 4's format-gate check does). This plan's other steps use plain `node`, `git`, and text-search tools.

---

## Task 1: Write §0 header, §1 Purpose & Scope, §2 Readiness snapshot

**Files:**

- Create: `docs/runbooks/opak-uat-rollout.md`

- [ ] **Step 1: Read the two reference runbooks for style**

Read `docs/runbooks/shopline-pilot-onboarding.md` and `docs/runbooks/production-readiness.md` in full. Confirm the conventions this new runbook must match: an H1 title, a short unnumbered intro line or paragraph, `## N. Title` numbered sections, imperative operator language, fenced code blocks for real commands, explicit caveats stated plainly rather than hedged. Confirm neither file already covers the four-stage UAT sequence, the rollback-source-file procedure, or a stage sign-off template — if either does, stop and report back rather than proceeding (this would mean the design's scope-boundary assumption was wrong).

- [ ] **Step 2: Create the file with this exact content**

```markdown
# Opak UAT rollout

Governs the four-stage UAT sequence for the Opak pilot. This is a living document — §2's gate table reflects the state of the code as of the date below; re-verify it against the live repository before any real go/no-go decision, do not treat it as permanently accurate.

## 1. Purpose and scope

This runbook governs the four-stage UAT sequence defined in `docs/superpowers/plans/2026-08-30-wukong-catalog-operations-os-integration.md` §11/§18: Stage 1 (1–5 products, attended) → Stage 2 (30–50, golden set) → Stage 3 (50–100, 2-week shadow pilot) → Stage 4 (full catalog). It turns that master plan's process outline into something an operator and Opak can actually follow stage by stage, with go/no-go gates checked against live code rather than a plan document that goes stale the moment code changes.

This runbook does not own everything UAT touches:

- Infrastructure-level rollback — disabling SHOPLINE, pausing Cloudflare Queues, rolling back the Worker or Vercel deployment, DLQ replay — is [`production-readiness.md`](./production-readiness.md)'s "Rollback" section. §5 below is a narrower, different kind of rollback: restoring one SHOPLINE product's prior content from a retained source file.
- Day-to-day mechanics — Developer Center setup, merchant enablement, importing/enriching/exporting a catalog, bulk-approve, the admin area — are [`shopline-pilot-onboarding.md`](./shopline-pilot-onboarding.md)'s territory. This runbook references those sections by number instead of re-explaining them.

## 2. Current readiness snapshot

Verified live against the repository on 2026-09-03.

| Gate                                                                                        | Status                 | Evidence                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sheet-name fix (`"Sheet1"` → `"Default"`)                                                   | Closed, on `main`      | `packages/shopline/src/bulk-form-xlsx.ts:345`, `WORKBOOK_XML` declares `name="Default"`                                                                                                                        |
| Variant-ID hard block                                                                       | Closed, on `main`      | `packages/shopline/src/bulk-form.ts:627`, `severity: "error"`, row dropped                                                                                                                                     |
| Freshness gate (content/evidence/source-digest checks before approval and before export)    | Closed, on `main`      | `packages/core/src/content-freshness.ts`, `assert-approval-freshness.ts`, `assert-export-freshness.ts`; wired into `apps/web/app/api/listings/[id]/approve/route.ts` and `apps/web/lib/bulk-export-service.ts` |
| Eight-field confirmation ledger                                                             | Closed, on `main`      | `packages/db/src/repositories/review-confirmations.ts`, `apps/web/components/confirmation-checklist.tsx`, `apps/web/lib/review-confirmation-keys.ts`'s `allConfirmed()`                                        |
| CSRF/secure-cookie config                                                                   | Closed, on `main`      | `apps/web/auth.ts:101-110`, cross-checked against installed `better-auth@1.5.5` source                                                                                                                         |
| Batch wave-size cap, server-enforced                                                        | Closed, on `main`      | `packages/db/src/repositories/enrichment-batches.ts`'s `claimWave` — no client-reachable override path                                                                                                         |
| `/listings/new` wiring                                                                      | Closed, on `main`      | `apps/web/app/(app)/listings/new/page.tsx` → `ListingIntakeClient` → real presign/upload/finalize/create flow                                                                                                  |
| SHOPLINE write gating (preview mock, production disabled)                                   | Closed, on `main`      | `scripts/render-cloudflare-config.mjs:82-83`, immune to env override, proven by `tests/cloudflare-config.test.mjs`                                                                                             |
| Multi-product export: no-op row leak fixed                                                  | Closed, pending merge  | PR #65, commit `5e5ef7b`                                                                                                                                                                                       |
| Multi-product export: reparse-and-assert self-check                                         | Closed, pending merge  | PR #65, commits `f9577ea` → `c15d6a4`                                                                                                                                                                          |
| Multi-product export: mixed-store rejection                                                 | Closed, pending merge  | PR #65, commit `083899c`                                                                                                                                                                                       |
| Package J accessibility/security/observability hardening                                    | Closed, pending merge  | PR #64                                                                                                                                                                                                         |
| `/jobs` reconciliation (recording what SHOPLINE actually accepted after a manual re-import) | Open                   | no `POST /api/listings/[id]/shopline-import-result` route exists; see §4                                                                                                                                       |
| Tested rollback-source-file procedure                                                       | Closed by this runbook | see §5                                                                                                                                                                                                         |
| `audit:verify` run as a stage-level gate (not just per-draft)                               | Partially closed       | CLI exists and is tested (`packages/db/src/cli/audit-verify.ts`), but nothing runs it across a whole stage today — this runbook's sign-off template (§6) requires it                                           |

PR #64 and PR #65 both modify `apps/web/app/api/listings/export/route.test.ts`. A real three-way merge simulation (`git merge-tree`) confirms zero conflicts between them — they touch disjoint line ranges and merge cleanly in either order. Both must land on `main` before Stage 1 begins (Package K depends on Package J per the master plan's dependency graph: `{C,D,E,F,G,H,I} → J → K`); no coordination is needed beyond merging both.
```

- [ ] **Step 3: Verify the sections landed correctly**

```bash
grep -c "^## " docs/runbooks/opak-uat-rollout.md
grep -n "^# Opak UAT rollout" docs/runbooks/opak-uat-rollout.md
grep -c "^|" docs/runbooks/opak-uat-rollout.md
```

Expected: the first command reports `2` (sections 1 and 2 only — 3–7 come in later tasks), the second finds the title on line 1, the third reports `17` (1 header separator row + 1 header labels row + 15 gate rows in the table — count the table rows in Step 2's content to confirm before running).

- [ ] **Step 4: Do not commit yet**

This task's content is the first third of one document — commit happens once, in Task 5, after the whole file is written and format-checked.

---

## Task 2: Write §3 Stage sequence, §4 `/jobs` reconciliation gap

**Files:**

- Modify: `docs/runbooks/opak-uat-rollout.md`

- [ ] **Step 1: Read the current file**

Read `docs/runbooks/opak-uat-rollout.md` in full and confirm it ends after §2's PR-merge-conflict paragraph (Task 1's Step 2 content), with nothing after it.

- [ ] **Step 2: Append this exact content**

```markdown
## 3. Stage sequence

Each stage's entry gate is a subset of §2's table plus the previous stage's exit criteria. No stage introduces a code gate not already listed in §2.

### Stage 1 — Attended contract UAT (1–5 products)

**Entry:** the sheet-name fix, Variant-ID block, freshness gate, and eight-field confirmation ledger are all Closed in §2, and the rollback-source-file procedure (§5) is in place.

**Exit:** a manually-triggered SHOPLINE re-import of a Wukong-generated file succeeds for all 1–5 products, with zero identifier coercion and zero unintended field changes — verified by diffing the re-imported product against the intended eight-field change set.

This stage does not require PR #65's multi-product export fixes or PR #64's Package J hardening _by content_ — Stage 1 is single-product export territory. Both must still be merged first, since Package K depends on Package J in the master plan's dependency graph.

### Stage 2 — Golden set (30–50 products)

**Entry:** Stage 1 signed off. Same code gates as Stage 1; still single-row or small-batch delivery.

**Exit:** 100% header/workbook acceptance and 100% intended-row import success across the set, with any partial success explicitly reconciled by hand — the `/jobs` endpoint doesn't exist yet, so this stage uses §4's manual-log workaround.

### Stage 3 — Shadow pilot (50–100 products, 2 weeks, manual import only)

**Entry:** Stage 2 signed off; the multi-product export fixes (PR #65) merged and live; the `/jobs` reconciliation endpoint (§4) built and live — this is the one gate this stage adds beyond Stage 2's.

**Exit:** two weeks of manual-import cycles with `/jobs` showing clean reconciliation — no unresolved partial-import records — and zero locked/pass-through-field regressions.

### Stage 4 — Catalog-scale rollout (full catalog)

**Entry:** written Opak sign-off after Stage 3; all of Packages A–J complete and merged to `main`.

**Exit:** none — this is the terminal state. Ongoing operation follows `shopline-pilot-onboarding.md` from here.

## 4. `/jobs` reconciliation — documented gap

Nothing today records what SHOPLINE actually accepted after an operator manually re-imports a Wukong-generated file. The intended endpoint, `POST /api/listings/[id]/shopline-import-result` (or equivalent), does not exist in the repository.

**Stage 1–2 workaround (manual).** Keep a plain log — a shared sheet, or the pilot change log `shopline-pilot-onboarding.md`'s header already requires — recording, per import: the file's digest, the product IDs included, SHOPLINE's reported accept/reject count, and the reason for any rejected row. This is sufficient at Stage 1–2's 1–50-product scale. It is explicitly **not** sufficient at Stage 3's 50–100-product, 2-week cadence — the volume and duration make a manual log unreliable as a reconciliation record.

**Stage 3 requirement.** Before Stage 3 begins, a small follow-up PR must build the missing endpoint and a minimal `/jobs` UI surface for it, reusing the existing jobs-ledger patterns from Package I. This runbook does not design that PR — it states the requirement and points at the master plan's §10 and §16 (Package I) for the original design intent.
```

- [ ] **Step 3: Verify the sections landed correctly**

```bash
grep -n "^## " docs/runbooks/opak-uat-rollout.md
grep -c "^### Stage" docs/runbooks/opak-uat-rollout.md
```

Expected: the first command lists 4 numbered sections (1–4) in order with no gaps or duplicates; the second reports `4` (Stage 1 through Stage 4 subsections).

- [ ] **Step 4: Do not commit yet**

Same reasoning as Task 1 — one commit for the whole document, in Task 5.

---

## Task 3: Write §5 Rollback procedure, §6 Sign-off template, §7 Out of scope

**Files:**

- Modify: `docs/runbooks/opak-uat-rollout.md`

- [ ] **Step 1: Read the current file**

Read `docs/runbooks/opak-uat-rollout.md` in full and confirm it ends after §4's Stage 3 requirement paragraph (Task 2's Step 2 content), with nothing after it.

- [ ] **Step 2: Append this exact content**

````markdown
## 5. Rollback-source-file procedure

This is a different, narrower concept than `production-readiness.md`'s infrastructure rollback (disabling SHOPLINE, pausing Queues, rolling back a deployment). This procedure restores one SHOPLINE product's prior content using a retained source file — it does not touch infrastructure at all.

1. **Retain every export before it's used.** Before any write — single-row or multi-product — keep the exact bulk-form export file used: the bytes returned by `/api/listings/<id>/deliver` (`method: "bulk_form"`) or `/api/listings/export`, not a regenerated copy. Name it deterministically, e.g. `<date>-<stage>-<digest-prefix>.xlsx`, and store it in the pilot's shared evidence location alongside the change log `shopline-pilot-onboarding.md` already references.
2. **Verify the retained file round-trips before relying on it.** Run the same profiling tool `shopline-pilot-onboarding.md` §4 uses before an import, applied here to a file that was delivered rather than imported:

   ```bash
   pnpm --filter @wukong/shopline bulk-form:profile <file>
   ```
````

Confirm the reported aggregate counts match what was actually delivered. 3. **To roll back a specific write:** find the immediately-prior retained export for the affected product(s) — the last file whose content differs from the one that caused the problem — and manually re-import _that_ file into SHOPLINE via the merchant admin, following the same caution as a normal import: **do not open it in Excel first** (`shopline-pilot-onboarding.md` §4, step 2). This restores every column in the file, not just the eight enrichable ones — it is a blunt, whole-row restore. Use it only when the alternative is worse. 4. **This is the ADR-12 rollback procedure for a bad bulk-form write.** ADR-12 defines rollback as stopping the pipeline and correcting via a separate, explicitly authorized manual action — not automatic reversal. This procedure is exactly that separate action, and requires the same written-approval discipline `shopline-pilot-onboarding.md` §3 already requires before touching a hidden test product.

## 6. Sign-off template

At each stage boundary, record a written sign-off capturing:

- Stage number, product count, and date range.
- §3's exit criteria for that stage, each checked off with evidence — a screenshot, a `/jobs` export or the manual log from §4, an `audit:verify` run's output.
- The result of running `audit:verify` against the stage's actual drafts:

  ```bash
  pnpm --filter @wukong/db audit:verify
  ```

  Its reported missing-action count and accessible-foreign-record count must both be `0`. This closes the "run `audit:verify` as a stage-level gate" item flagged Partially Closed in §2.

- Opak's named approver and their explicit written approval to advance — or not — to the next stage.
- Any defect found during the stage: whether it was fixed inline as a small follow-up PR (the same pattern PR #65 used for the multi-product export bug) or deferred, and to where.

## 7. Out of scope

This runbook does not build the `/jobs` reconciliation endpoint (§4) — that's a follow-up PR's job. It does not modify `production-readiness.md` or `shopline-pilot-onboarding.md`. And it is not itself an execution of any UAT stage: running a real stage needs real Opak data, real SHOPLINE writes, and calendar time. This document is the process those executions follow, not a substitute for running them.

````

- [ ] **Step 3: Verify the sections landed correctly and the document is complete**

```bash
grep -n "^## " docs/runbooks/opak-uat-rollout.md
grep -c "TBD\|TODO\|FIXME\|placeholder" docs/runbooks/opak-uat-rollout.md
````

Expected: the first command lists exactly 7 numbered sections (1–7) in order, no gaps, no duplicates. The second reports `0` — no placeholder markers anywhere in the finished document.

- [ ] **Step 4: Do not commit yet**

Proceed to Task 4's format check before the single final commit in Task 5.

---

## Task 4: Format check

**Files:** `docs/runbooks/opak-uat-rollout.md` (verification only, fix in place if needed)

- [ ] **Step 1: Run the project's real format gate**

```bash
node scripts/check-runtime-format.mjs
```

This is diff-based against the merge-base with `origin/main` and CRLF-normalized — it correctly ignores the CRLF-only false positives a raw `prettier --check .` would report on this Windows checkout, and only flags genuinely unformatted files actually touched on this branch.

- [ ] **Step 2: If `docs/runbooks/opak-uat-rollout.md` is listed as requiring Prettier, fix it**

```bash
corepack pnpm exec prettier --write docs/runbooks/opak-uat-rollout.md
node scripts/check-runtime-format.mjs
```

Expected after the fix: the file no longer appears in the "Runtime files requiring Prettier" list (or the list is empty / doesn't mention this file at all if it was already clean).

- [ ] **Step 3: Read the file back once more in full**

Confirm the Prettier pass (if it ran) didn't alter any factual content — table rows, PR numbers, commit SHAs, section numbering — only whitespace/line-wrapping. If Prettier reflowed a long line in a way that changed a rendered table cell's content, that's a bug in this task; fix the source manually instead of accepting the reflow.

---

## Task 5: Final verification and commit

**Files:** `docs/runbooks/opak-uat-rollout.md`

- [ ] **Step 1: Full read-through against the design spec**

Read `docs/runbooks/opak-uat-rollout.md` in full one more time, side by side with `docs/superpowers/specs/2026-09-03-opak-uat-rollout-runbook-design.md`. Confirm every one of the design's §1–§8 points has a corresponding, complete section in the runbook — not summarized, not abbreviated. Confirm all 15 gate-table rows from §2 are present with correct status labels. Confirm cross-references resolve: `production-readiness.md` and `shopline-pilot-onboarding.md` are linked correctly (relative paths `./production-readiness.md` and `./shopline-pilot-onboarding.md`), and every `§N` reference inside the runbook points to a section that actually exists in the same document (e.g., §5's rollback procedure really is section 5, not section 6).

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/opak-uat-rollout.md
git commit -m "docs: add the Opak UAT rollout runbook"
```

(Add a `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.)

- [ ] **Step 3: Report status**

Do not push or open a pull request — stop here and report back with the full verification results (Task 1–4's checks, Task 5's cross-reference confirmation), matching how every prior package/fix this session was handed back for the user's own review/merge.
