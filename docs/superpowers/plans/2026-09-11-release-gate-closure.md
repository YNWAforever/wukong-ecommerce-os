# Release-gate closure — the phase between Packages A–J and Opak UAT

Successor to [the integration plan](./2026-08-30-wukong-catalog-operations-os-integration.md).
Companion records: [status](../../implementation/wukong-remediation-status.md) ·
[decisions](../../implementation/wukong-remediation-decisions.md) ·
[verification](../../implementation/wukong-remediation-verification.md)

## 1. Why this phase exists

The integration plan's last package is **K — Controlled Opak UAT and staged
rollout**, whose dependency is "all of A–J" and whose entry condition
([opak-uat-rollout.md](../../runbooks/opak-uat-rollout.md) §3) is "reviewed and
deployed code and migrations verified; freshness and all confirmations renewed
for the approved source; restoration evidence retained; explicit manual-write
authority."

K cannot start. Not because the work is large, but because **A–J were reported
complete and are not**. An adversarial package-by-package audit of the code
(2026-09-11) downgraded every one of A–J from `delivered` to `partial`, and K to
`not_started`. This phase closes that tail and makes each closure mechanically
guarded, so the same gap cannot be reported closed twice.

This phase enables no SHOPLINE write, runs no migration against production, and
changes no deployment control. Everything requiring merchant authorization is
named in §6 and deliberately left undone.

## 2. Corrected package status

The integration plan's §18 readiness table is stale: it marks every UAT stage
"Not ready" because the four go/no-go blockers were proposals when it was
written. **All four are now closed in code**, which the table does not say:

| Gate                     | §18 said   | Verified at 2026-09-11                                                                           |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------ |
| G6 workbook sheet name   | Proposed   | `packages/shopline/src/bulk-form-xlsx.ts:387` emits `name="Default"`                             |
| G7 Variant ID hard block | warns only | `packages/shopline/src/bulk-form.ts:630` rejects a non-null `variantId`; `bulk-form.test.ts:209` |
| G12 wave-size cap        | UI-only?   | `apps/web/lib/enrichment-batch-service.ts:166-168` enforces 1–5 server-side **on create**        |
| G4 freshness gate        | absent     | `assertApprovalFreshness`, via `apps/web/lib/listing-approval.ts:4`                              |

What the table should say instead is that the packages are `partial`. The
audit's findings, with citation-drift discarded and only substantive gaps kept:

| Pkg | Status      | The gap that matters                                                                                                                                                 |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | partial     | Its entire Outcome is unmet — see W2                                                                                                                                 |
| B   | partial     | Role-aware nav absent; `formatHkd`/`formatHkTimestamp` have zero callers while ad-hoc formatting survives; `DEFAULT_LOCALE` is `zh-Hant` where §13 specified `zh-HK` |
| C   | partial     | Its acceptance clause is a visual-regression capture that does not exist (W9)                                                                                        |
| D   | partial     | `/queue` lane divergence from §5; `DashboardListingsClient` reachable only through a wrapper                                                                         |
| E   | partial     | **`freshnessAttested` is client-asserted (W1)**; `/listings/new` never restructured (see §4)                                                                         |
| F   | partial     | Wave cap enforced on create only; cohort still built from `listRecent(MAX_BATCH_ITEMS)`                                                                              |
| G   | partial     | Ledger records no before/after and no per-field evidence reference; approval-invalidation events not visible in `/jobs` or `/quality`, which its Outcome requires    |
| H   | partial     | Reparse-and-assert compares against `update.sheet` rather than asserting every §11 invariant independently                                                           |
| I   | partial     | Empty-state evidence weaker than cited; no substantive defect found                                                                                                  |
| J   | partial     | Real a11y defects (W5); `bulk-import-panel.tsx` fully unlocalised (W4); `expect.soft` means the overflow assertion cannot fail a run; no results document            |
| K   | not_started | Correct — blocked on the above, plus merchant authorization                                                                                                          |

## 3. Workstreams, in priority order

Priority is by risk to the merchant, not by effort. Each item names the guard
that stops it reopening, because every gap in §2 was previously believed closed.

### W1 — Freshness attestation is asserted by the client (highest)

§19 ranks the freshness gate as the highest-severity risk in the whole plan. The
gate exists and is enforced — but its `not_attested` sub-check is a plain
boolean on the request body (`apps/web/app/api/listings/export/route.ts:35`,
`z.boolean()`). A client that sends `true` satisfies it. The server never
verifies that an operator re-confirmed the source is current.

This is a **design decision, not a typing task**, and it should be made
explicitly rather than closed by tightening a schema:

- **(a)** Treat it as a genuine server-side check: persist attestation as an
  event carrying an actor, a timestamp and the source digest it was made
  against, and have the gate read that record rather than the request.
- **(b)** Treat it as what it is — an operator attestation, not a check — rename
  it so no reader mistakes it for verification, and rely on the audit trail.

(a) is the honest reading of §11's "current merchant protected fields must still
be checked". Recommend (a). Either way the choice must be written down: a gate
that looks like verification and is not is worse than one that admits it.

**Guard:** a test that sends `freshnessAttested: true` with no attestation
record and asserts refusal.
**Acceptance:** an export attempt with a stale or absent attestation is refused
by the server, proven against a real Postgres.

**Done (2026-09-12).** Option (a): the attestation is now evidence the server
can falsify. The operator sends the digests they were shown; the server
refuses unless the attested set is exactly the requested set (400
`attestation_incomplete`), compares each digest against the current link, and
records the evidence on the export attempt. `freshnessAttested` is retired.

Planning changed the design once and the spec was amended to match. Feeding
the attested digest into `expectedRowDigest` -- which that field was always
documented to mean -- turned `row_digest_mismatch` from a comparison of a
value against a re-read of itself into a real check, so **no new freshness
reason was needed at all**.

Implemented as nine tasks under subagent-driven development. Review caught
five defects worth naming, because each was invisible to the tests:

- The advisory readiness path fabricated an attestation from a link that may
  not be the row the gate reads (`platform_products` has no unique index on
  `listing_id`), flipping a reported reason. Fixed with a discriminated
  attestation kind, so the advisory path can ask the policy question without
  inventing an answer.
- The catalog derived digests from the current page while selection survives
  paging, so a listing selected on page 1 and exported from page 2 was
  silently dropped. Digests are now captured at selection and preferred live
  only while the row is visible.
- `ensure()` ignored the attestation in its idempotency conflict check, so a
  retry with different evidence silently kept the old record.
- Both new copy strings were written into tables the export panel never reads.
- `attestationMismatchCount` claimed the operator was at fault for a reason
  that also fires on stale review confirmations.

**Not proven:** the integration suite has not been run since the deliver-path
change, because Docker stopped partway through. Migration `0025` was rehearsed
twice against real Postgres and the export-attempt tests passed 18/18 at that
time, but `source-binding.integration.test.ts` was edited afterwards and has
never been executed. Playwright has not been run at all.

### W2 — CI is green because the gate cannot see the failure

Package A's whole Outcome was "fix the CI formatting failure". It was never
done. `docs/superpowers/plans/Wukong_Catalog_Operations_OS_Claude_Code_Opus_Planning_Specification_2026-08-30.md`
still fails Prettier, and is absent from `.prettierignore`, from
`protectedUnrelatedFiles` (`scripts/check-runtime-format.mjs:22-27`) and from
`knownFormatDebt` (`:28-41`). CI passes only because the gate diff-scopes to
`merge-base..HEAD` (`:155-158`) and the file is already on main. **The next
commit that touches it turns CI red.**

This is the same shape as three defects this programme has already found: a
green check that is green for the wrong reason. Fix by deciding — per §21, the
decision is whether to reformat a document the user uploaded verbatim, or to
exclude uploaded reference documents from the runtime gate — then recording the
decision where the script itself states it.

**Guard:** extend `tests/ci-workflow.test.mjs` so the exclusion list is exact
and fail-closed, as `knownFormatDebt` already is.
**Acceptance:** the gate passes for any base whose diff includes the
specification.

**Done (2026-09-11).** The specification joins `protectedUnrelatedFiles`, which
already held a plan document for exactly this reason, and that list is now
exported and pinned by `assert.deepEqual` the way `knownFormatDebt` has always
been — plus a check that refuses to park a Prettier-clean file there, so the
list cannot become a dumping ground. Proven at `765c616~1`: 578 files checked,
0 failures, where the same base previously failed on exactly that file out of 579.

An earlier draft of this section set the acceptance at "passes over the whole
tree, not only over a diff". That was wrong, and is corrected above. From the
repo root the gate still fails on **26 of 787** files that predate it and have
never entered a diff since. That debt is real and worth paying down, but it is
not what kept the specification unformatted, and reformatting 26 unrelated
files does not belong in this workstream.

### W3 — A viewer sees every destination

§8 chartered role-aware navigation "consistent with the existing
`requireWorkspaceRole` mechanism". `NavItem`
(`apps/web/components/app-shell-nav.tsx:11-16`) carries no role field, and none
of the ten `SHELL_NAV_ITEMS` entries names one. The only gating is a binary
`isAdmin` prop controlling one extra row.

This is not a security hole — every route and API enforces its own role
server-side, and the nav is UX only, exactly as `CLAUDE.md` says of the
middleware cookie check. It is a truthfulness gap: the interface offers work the
reader cannot do.

**Guard:** a test asserting no nav entry's role exceeds the session role.
**Acceptance:** a viewer session renders no operator-only destination.

**Done (2026-09-11).** `NavItem` gains an optional `role`, and exactly three
destinations carry it — `/listings/import`, `/listings/new` and `/batches` —
matching the operator gate their own APIs enforce. `/batches` refuses a viewer
on the GET as well as the POST, which is why `batch-list.tsx` maps
`insufficient_role` for a plain read: the page rendered nothing but a
permission error. `visibleNavItems` reuses `requireWorkspaceRole` rather than
comparing roles itself, so the shell and the server cannot disagree about what
operator ranks above. The marked set is pinned exactly, so adding a destination
is a visible decision.

### W4 — The unlocalised tail, and a guard that stops it regrowing

`apps/web/components/bulk-import-panel.tsx` has zero `localized()` calls and
takes no locale prop: the entire `/listings/import` bulk-import surface is
hardcoded Traditional Chinese. `apps/web/app/(app)/listings/new/page.tsx` is the
same, and still uses the both-languages-at-once pattern
(`資料匯入 <span>LISTING INTAKE</span>`) that the batch work removed.

The batch feature was fixed this way twice in one week — first two components,
then the two siblings nobody had named — because nothing measured the gap.
`apps/web/lib/ui-vocabulary.test.ts` already proves the shape of the answer for
wording.

**Guard:** extend it into a localisation guard — fail when a component renders a
CJK string literal outside `localized()`/`stateLabel()`, with an explicit
allowlist for the surfaces not yet converted, so the list can only shrink.
**Acceptance:** the language toggle changes every string on `/listings/import`
and `/listings/new`.

**Done in part (2026-09-12).** The guard is installed, and it is the durable
half: it finds every source file containing Han characters with no notion of
language at all -- no `localized()`, no `stateLabel()`, no `"zh-Hant"` map, not
even a `Locale` in scope -- and pins the rest as a list that can only shrink.
It found **twelve** such files, not the two this workstream named.

Three are localised and struck off: `/batches`, `/batches/[id]` and
`/listings/new`. Nine remain, including `bulk-import-panel.tsx`, the largest and
the one named here. That one carries a coupling worth knowing before it is
attempted: `tests/e2e/bulk-update-pilot.spec.ts:239` selects its submit button
by the exact string `開始匯入 Import`, so localising the panel changes the pilot
journey and the two must move together.

The guard cannot see a file that localises most of its copy and hardcodes the
rest; that is what the retired-term check is for. It is a ratchet, not a proof.

**`/listings/import` closed (2026-09-13).** The acceptance criterion names the
route, not one component, and the route renders **three** of the nine:
`bulk-import-panel.tsx`, `supporting-evidence-panel.tsx` and
`new-product-blocked-panel.tsx`. All three are converted, so the list is now
**six**. The two small panels also carried the both-languages-at-once pattern
this workstream set out to remove.

Two things this found that the entry above did not predict:

- **The toggle failed in both directions.** `bulk-import-panel.tsx` was not
  simply "hardcoded Traditional Chinese": its chrome was Chinese and its
  failure messages were **English only**, so a reader who chose Chinese was
  answered in English. Failure copy now travels as the `[zh, en]` pair the
  batch screens already use (`batch-list.tsx:44`), and a message the server
  wrote is still repeated as it stands rather than given an invented
  translation -- the position `batch-list.tsx:87` already takes.
- **The coupling was wider than one line.** Four selectors used
  `開始匯入 Import`, not just `:239`, and a fifth assertion matched the
  Chinese success line. The fixture pins `locale=en`, so all five now read the
  English copy.

`/listings/new` was already struck off, so with `/listings/import` converted
this workstream's stated acceptance criterion is met. The six that remain are
`/admin` and its two panels, `listing-intake-form.tsx`,
`listing-view-models.ts` and `lib/listing-approval.ts`. `listing-view-models.ts`
is worth naming: it is a library, not a screen, so its Chinese can surface on
routes that are otherwise localised -- the one remaining entry the ratchet
cannot attribute to a single page.

### W5 — Accessibility defects Package J did not close

- All three `.metric-strip` containers put `aria-label` on a plain `<div>` with
  no role (`dashboard-listings-client.tsx:127`, `quality-summary-client.tsx:125`,
  `jobs-ledger-client.tsx:252`). `aria-label` on a role-less generic element is
  ignored by assistive technology — the label is not merely weak, it is absent.
- `/batches/[id]` renders no `<h1>` at all
  (`apps/web/app/(app)/batches/[id]/page.tsx`).
- `assertNoHorizontalOverflow` uses `expect.soft`
  (`tests/e2e/catalog-usability-checks.ts:21-23`), so a real overflow records a
  failure without failing the run.

**Guard:** make the overflow assertion hard, and add a heading-presence
assertion to the route sweep.
**Acceptance:** Package J's own clause — WCAG 2.2 AA for every route in §5 —
with the routes it never exercised included.

**Done (2026-09-12).** All three strips carry `role="group"`; `/batches/[id]`
has an `h1`, server-rendered so it exists at first paint rather than appearing
when the batch loads; and the overflow assertion is hard.

This contradicts a written decision, which is why it is recorded rather than
quietly applied.
`docs/superpowers/specs/2026-09-04-metric-tile-role-group-design.md:50` puts the
strip-level `aria-label`s out of scope, calling them "already-adequate". They
were not: ARIA prohibits `aria-label` on a generic element, so a plain `div`
never exposed one to assistive technology. The two tile tests now scope their
count to the strip children, which is what they always meant.

Still open from the same audit: the `/jobs` strip has no per-tile association at
all -- its tiles are bare `div`s -- so it received the container fix without the
tile fix that dashboard and quality already had.

### W6 — The confirmation ledger is thinner than §11 requires

§11 requires the ledger to record, per field, before/after and evidence for each
of the eight writable fields. The stored ledger records neither. This is schema
work and therefore the largest item here: additive migration, RLS, workspace
scoping and an audit event, under the discipline in §10.

It is listed sixth, not first, because nothing is currently wrong at runtime —
approval binding works. What is missing is the evidence a UAT stage has to
produce ("complete audit evidence", §18 go/no-go). It must land before Stage 2.

### W7 — Approval invalidation is invisible

`invalidateApprovalForConfirmationChange`
(`packages/db/src/repositories/listings.ts:754-789`) invalidates silently.
Package G's Outcome requires those events visible in `/jobs` and `/quality`. An
operator whose approval was invalidated by a source change currently learns it
by finding the listing un-approved.

### W8 — The wave cap protects creation, not advancement

`enrichment-batch-service.ts:166-168` validates `waveSize` on create; `:377-379`
advances using the **stored** `batch.waveSize`. A row whose stored value is
outside 1–5 — through an earlier bug, a migration, or a direct write — is
honoured. G12 asked for the cap to be enforced by the API rather than the UI;
half of the API enforces it.

**Done (2026-09-13).** The advance path now claims
`Math.min(batch.waveSize, MAX_ENRICHMENT_WAVE_SIZE)`, and the cap lives in one
leaf module (`apps/web/lib/enrichment-wave-limit.ts`) that the route schema, the
create validation and the advance path all read — it was three separate
literals, so moving one would have left the others on the old bound.

One correction to the paragraph above: the exposure is only the **ceiling**, not
"outside 1–5". `enrichment_batches.wave_size` already carries
`CHECK (wave_size > 0)` (`0005_enrichment_batches.sql:20`), so Postgres refuses a
zero or negative value however it is written. That is why advance clamps rather
than refuses: clamping can only ever dispatch fewer calls, never more, and it
leaves the batch usable instead of stranding it. A clamp that fires also logs
`enrichment_batch.wave_size_capped` with both numbers, because a stored value
the API cannot produce means something wrote the row outside it.

Two tests, because a clamp has two ways to be wrong: a row holding 40 claims
exactly the cap, and a row holding 2 still claims 2 — the clamp must not become
a floor.

### W9 — Decide whether visual regression is an acceptance criterion at all

Packages B, C and J each cite "visual-regression capture" as acceptance
evidence. There are **zero** `toHaveScreenshot` call sites and **zero**
committed PNG baselines; `catalog-usability.spec.ts:221` writes screenshots to
`testInfo.outputPath()`, which CI uploads only `if: failure()`. Nothing compares
anything, so three packages carry an acceptance clause no run can satisfy.

Two honest options, and this is a decision rather than a task: adopt real
baselines across the route × locale × viewport matrix and accept the ongoing
churn, or amend the three packages to drop the clause and rely on the
a11y/overflow assertions that do run. Recommend amending — the matrix is 13
routes × 2 locales × 2 viewports, and a baseline suite that is always slightly
wrong gets ignored, which is worse than not having one.

**Decided (2026-09-13): amend.** Recorded in
[visual-regression decision](../specs/2026-09-13-visual-regression-decision.md),
with five clauses in the integration plan amended to match: §14's scope
definition, B's and C's acceptance bullets, and J's two.

The recommendation held, and gained a concrete reason it did not have: CI runs
`ubuntu-latest` while development happens on Windows, so a Linux-generated
baseline fails locally and cannot be regenerated without Docker. A suite only
one machine can update is one that gets `--update-snapshots`-ed until it
asserts nothing.

Worth keeping in view: the defects this phase actually found — an `aria-label`
on a role-less `div`, a missing `h1`, a soft overflow assertion, and surfaces
in the wrong language — are all invisible to a screenshot diff, or visible only
to someone who opens it and reads Chinese.

### W10 — Make the release gate a gate

[`production-readiness.md`](../../runbooks/production-readiness.md) is the entry
condition for K. **Every box in it is unchecked**, and nothing verifies any of
them: `scripts/` holds a format checker, an env manifest, a runtime doctor and a
Cloudflare secrets verifier, but no readiness check.

Much of it is already mechanically true and merely unrecorded. CI pins Node 24
and pnpm 11.7.0 (`ci.yml:46-52`), does a frozen install (`:54`), proves the
forbidden runtime surface absent (`:78`), renders and validates Wrangler
configuration, builds database dependencies (`:99`), migrates (`:101`), runs
lint/typecheck/unit/integration/build/full Playwright, and runs `audit:verify`
against the real-stack draft.

Split the checklist in two and mechanise the first half: a script that verifies
what CI can prove and emits the evidence, following the precedent of
`runtime-env-manifest.mjs`, whose test derives truth from source so the list
cannot fall behind the code. The remainder — owners, secret custody, rotation
cadence, deployment IDs, merchant approval — is irreducibly human and should say
so next to each box, rather than sitting unchecked and ambiguous.

**Done (2026-09-12).** Twenty boxes, split six automated and fourteen human,
with every box annotated in the runbook to say which it is and every human one
carrying a reason. `pnpm release-gate:check` proves the automated six and names
the rest; `tests/release-gate.test.mjs` links the two lists in both directions,
so a box with no check fails and a check with no box fails. Adding a line to
the runbook now forces a decision about which kind it is.

The six that source settles: `DATABASE_ADMIN_URL` reaching no runtime surface;
CI pinning Node 24 and pnpm 11.7.0 through to full Playwright; the real-stack
harness being a production build with fake AI and mock SHOPLINE; `audit:verify`
running against the synthetic draft; and the two SHOPLINE adapter settings,
which live in `scripts/render-cloudflare-config.mjs` rather than in the config
file its name suggests.

The command prints, and the code repeats, that a green run is **not** sign-off:
it proves the repository is configured as described and nothing about a
deployment. The human half is the gate.

One thing the work turned up: `tests/cloudflare-config.test.mjs` pins the root
test script verbatim, so adding a root test file fails until the pin is
updated. That is the same shape as the guards this plan keeps asking for, and
it worked -- it caught the new file immediately.

## 4. Stale records to reconcile

Three claims are now false and are load-bearing for the readiness verdict:

1. §18's readiness table (above). Rewrite it against §2 of this document.
2. The verification record's "does NOT support" list still says
   `workspaceProfile.claimPolicy` "is read by no deterministic checker" and that
   the outbox "is not self-healing". Both changed on 2026-09-11 (`7cc1332`,
   `89f5241`). It also says classification accuracy "needs golden-set
   measurement"; the golden set exists (`e2f3c20`) — what remains outstanding is
   running it against a real provider.
3. Package E's `/listings/new` clause describes a 3-tab restructure that was
   never built there. The capability exists on `/listings/import`
   (`ListingIntakeTabs`, localised). Record the IA decision rather than leaving
   the plan describing a shape the product does not have.

## 5. Sequence

W2 and W3 are independent and can land immediately. W1 needs its decision made
first. W4 and W5 share the route sweep and should land together. W6 is the only
migration, and should be rehearsed twice for idempotency — as `0022`–`0024`
were — before anything depends on it.

```
W2 ─┐
W3 ─┼─> W4+W5 ─> W10 ─> K Stage 1 entry
W1 ─┘            ↑
W6 ─> W7 ────────┘
W8 ─┘
W9 (decision, no code)
```

W6 and W7 must precede UAT Stage 2 rather than Stage 1: Stage 1 is five attended
products whose evidence a human assembles, Stage 2 is where the ledger has to
carry it.

## 6. Out of scope, and what needs authorization

Not in this phase, and not startable from here:

- **Any real SHOPLINE write.** Preview stays `SHOPLINE_ADAPTER=mock`, production
  stays `disabled` with `SHOPLINE_PUBLISH_ENABLED=false`. The first real write
  needs its own separate confirmation.
- **Package K itself.** Every stage exit in the UAT runbook requires written
  merchant evidence. No amount of engineering closes it.
- **Real-provider verification of `listing-extraction@1.1.0`.** Still the single
  largest unproven item: the prompt has never been sent to a model, the E2E
  harness runs `AI_PROVIDER=fake`, and the fake provider builds evidence by
  slicing the note verbatim, so it can never exercise the grounding path a
  photograph takes. This needs a credential and a paid call, and must stay
  separate from the fake-AI harness.
- **Attributing the historical production run.** Needs the two queries in the
  status record run against production.

## 7. Exit criteria

This phase is complete when W1–W8 and W10 are closed with their guards in place,
W9 is decided and recorded, §4's three stale records are corrected, and
`production-readiness.md` distinguishes every mechanically-verified box from
every human-gated one. At that point Package K Stage 1 is blocked only on
merchant authorization and a deployment — which is where it should be blocked.

It is **not** complete when the gates are green. Three of the gaps in §2 were
green when they were reported closed.

> No application code, infrastructure, database, deployment or production
> SHOPLINE state was changed while preparing this plan.
