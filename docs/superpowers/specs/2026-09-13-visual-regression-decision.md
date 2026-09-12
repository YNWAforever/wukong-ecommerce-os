# Visual regression: amend the acceptance clause, do not adopt baselines

Workstream W9 of the [release-gate closure plan](../plans/2026-09-11-release-gate-closure.md).
That workstream is explicitly a decision rather than a task. This is the record.

## The question

Packages B, C and J each cite "visual-regression capture" as acceptance
evidence, against the scope §14 of the
[integration plan](../plans/2026-08-30-wukong-catalog-operations-os-integration.md)
defines: every route in §5, both locales, desktop and 375px.

Either that becomes real, or it stops being an acceptance criterion.

## What is actually true today

Verified 2026-09-13, not taken from the plan:

- **Zero** `toHaveScreenshot` call sites anywhere in `tests/`.
- **Zero** committed PNG baselines (`git ls-files` matches no `.png`), and no
  snapshot directory.
- 26 `.screenshot()` calls exist, but they write to `testInfo.outputPath()`,
  which CI uploads only `if: failure()`. Nothing compares anything.

So three packages carry an acceptance clause no run can satisfy, and nothing is
currently being protected that dropping the clause would stop protecting.

## Decision

**Amend the three packages. Do not adopt a baseline matrix.**

### Why

1. **The baselines could not be maintained where the work happens.** CI runs
   `ubuntu-latest` (`.github/workflows/ci.yml:13`); development on this project
   happens on Windows. Pixel output differs by platform font rasterisation, so
   a Linux-generated baseline fails locally and a developer cannot regenerate
   it without running the suite in Docker. A baseline suite that only one
   machine can update is one that gets `--update-snapshots`-ed until it asserts
   nothing.

2. **An unsatisfiable criterion devalues the criteria beside it.** Package J's
   acceptance list also contains WCAG 2.2 AA, contrast, and route parity -- all
   of which now genuinely run. Leaving one clause in the same list that no run
   can satisfy teaches a reader that the list is aspirational, which is
   precisely how three of the §2 gaps came to be reported closed while green.

3. **The defects this project actually shipped were not pixel defects.** The
   ones found in this phase were an `aria-label` on a role-less `div`
   (invisible to a screenshot, and to the eye), a missing `h1`, a soft overflow
   assertion, and whole surfaces rendering in a language the reader did not
   choose. A screenshot diff catches none of the first three, and would have
   caught the fourth only if someone opened the diff and read Chinese.

### What the clause becomes

The evidence that runs today, per route in §5, in both locales and both
viewports:

- **Hard** horizontal-overflow assertion (`tests/e2e/catalog-usability-checks.ts`
  -- made hard in W5; it was `expect.soft`, which recorded a failure without
  failing the run).
- `<h1>` presence per route.
- Accessibility-tree and contrast assertions.
- The localisation ratchet (`apps/web/lib/ui-vocabulary.test.ts`), which fails a
  new surface rendering Chinese with no notion of language, and whose allowlist
  can only shrink.

Captures stay as **artefacts for a person to look at** -- they already upload on
failure -- which is what they always were: evidence for a human, not an
automated assertion.

## What would reverse this

A visual regression reaching the merchant that none of the above caught. The
response then is targeted baselines for the specific views that broke, not the
full 13 x 2 x 2 matrix: a small suite someone maintains beats a large one
everyone overrides.

## Scope note

This narrows what three delivered packages claim as evidence, which is a
reduction a human may reasonably overrule. It is written down rather than
quietly applied for that reason. It changes no application code, no
infrastructure, and no test that currently runs.
