# Final audit — Phase 3 UI critique (2026-10-05)

Written before any UI change. Baseline: PR #121 head `84006670`, production
build served locally. Data is synthetic (an `Opak Cellar (synthetic)` workspace
with operator, reviewer and admin users) seeded from the project's own e2e
fixtures. No merchant data or live service was used.

Evidence:

- 54 "before" screenshots: 9 screens × 390/768/1440 px × EN / 繁中. They were
  captured with Playwright with reduced motion; none had horizontal overflow or
  page errors.
- Lighthouse accessibility audits (axe-core) on 7 authenticated screens.
- Manual WCAG contrast calculations on the `globals.css` tokens.

Screenshots and Lighthouse reports are kept outside Git. Each one is listed by
filename in the PR.

## Design read

The product is a dense operations tool for HK wine-retail operators and
reviewers working in two languages. It needs to be calm, legible, trustworthy
and keyboard-first. It is not a marketing page, so the landing-page rules in
`taste-skill` (hero, motion, imagery) don't apply. Only its general rules on
states, contrast and copy are used. The existing system (ink/navy/amber/stone
tokens, Georgia display, Inter body, 12/16 px radii) is coherent and stays.
This pass is a preserve-mode evolution, not a redesign.

## What works

- The product is honest about uncertainty: "operator-reported", "not
  verified", "tasks, not product count", and "this step does not write to
  SHOPLINE". This is domain-correct and is kept word for word, or made clearer.
- There is a skip link, every control has a label, the locale toggle exists,
  and the mobile bottom navigation works. Lighthouse accessibility is 96–100
  everywhere, and no screen overflows horizontally at 390 px.
- The Catalog table is dense and scannable. The Work Queue's status buckets
  map exactly to the state machine.

## Findings, by the brief's priority order

### 1. The needs-attention → review → approve loop

| #   | Finding                                                                                                                                                                                                                                                                               | Evidence                                       | Severity |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------- |
| U1  | On listing detail, the 15-item confirmation checklist sits below the whole form (about 2,500 px down at 1440 px). "Approve listing" is disabled beside a notice saying confirmations are incomplete, with no link to the checklist. Reviewers scroll down, tick, then scroll back up. | `listing-detail-en-1440.png`                   | High     |
| U2  | Every field shows two lines of orange text, "Not assessed" and "No source excerpt". Repeated 24 times in an alert colour, it reads as an error wall and hides the fields that actually need attention.                                                                                | same                                           | Medium   |
| U3  | In EN, product titles on Workbench and Catalog stay in Chinese. `workbench-reads.ts:48` and `workspace-reads.ts:206` always prefer `title.zh-Hant`.                                                                                                                                   | `workbench-en-1440.png`, `catalog-en-1440.png` | Medium   |
| U4  | Workbench dates use US order (`10/5/2026, 9:01:11 PM`, from `toLocaleString("en")` in `workbench-client.tsx:82` and `workbench-list.tsx:55`). The Work Queue and Jobs show `5 Oct 2026, 8:51 pm`. HK formatting is inconsistent between screens.                                      | Workbench vs Work Queue                        | Medium   |
| U5  | "1 products" on every Workbench row.                                                                                                                                                                                                                                                  | `workbench-list.tsx:43`                        | Low      |
| U6  | The Work Queue "In review" bucket indents and centres titles next to the checkbox, so they don't line up with the other buckets.                                                                                                                                                      | `queue-en-1440.png`                            | Low      |

### 2. Import flow error and retry states

| #   | Finding                                                                                                                                                                                                                                  | Evidence                        | Severity |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------- |
| U7  | A failed import (validation, API or network) shows only the muted one-line status used for the idle hint (`role="status"`). The file and export time _are_ kept, but nothing says so, and nothing looks different from the idle state.   | `bulk-import-panel.tsx:503-512` | High     |
| U8  | The export-time label, the `datetime-local` input, the confirmation checkbox and "Start import" all run inline as one paragraph that wraps mid-sentence at every width. The label isn't above its input, and the button floats mid-line. | `import-workbook-en-1440.png`   | High     |

### 3. Empty, loading and stale states

| #   | Finding                                                                                                          | Evidence                      | Severity |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------- |
| U9  | Workbench layout shift is 0.248 (Lighthouse, poor). The list renders after a client load with no reserved space. | `lighthouse/before-dashboard` | Medium   |
| U10 | Jobs pagination is unstyled native buttons squeezed between cards.                                               | `jobs-en-1440.png`            | Low      |

### 4. Tables, density and row links

| #   | Finding                                                                                                                                                                                                               | Evidence                    | Severity                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------- |
| U11 | The Admin › Members table: column headers are misaligned, native-size selects and inputs, no header cell for the action column (axe `td-has-header`), and a bilingual header ("角色 Role") even when the UI is in EN. | `admin-en-1440.png`         | Medium                                       |
| U12 | Jobs reconciliation rows identify the product by two raw UUIDs, not its name.                                                                                                                                         | `jobs-en-1440.png`          | Medium (data shape; out of scope, see below) |
| U13 | Catalog metric buttons fail axe `label-content-name-mismatch` (WCAG 2.5.3, 9 instances): the accessible name differs from the visible text.                                                                           | `lighthouse/before-catalog` | Medium                                       |

### 5. Typography and spacing

| #   | Finding                                                                                                                     | Evidence           | Severity                             |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------ |
| U14 | Metric numerals are set in Georgia, so `0` reads as the letter `O` (Jobs metrics, Catalog strip). Use tabular sans figures. | `jobs-en-1440.png` | Low                                  |
| U15 | Page H1s mix styles: the Workbench uses a sans heading, while Catalog, Queue, Import and Jobs use a large serif.            | screenshots        | Low (kept; this would be a redesign) |

### 6. Sign-in and magic-link screens

| #   | Finding                                                                   | Evidence                 | Severity |
| --- | ------------------------------------------------------------------------- | ------------------------ | -------- |
| U16 | At 390 px the locale toggle wraps "繁中" onto two lines.                  | `signin-zh-Hant-390.png` | Low      |
| U17 | An empty "狀態：" / "Status:" label always shows below the submit button. | same                     | Low      |

### Accessibility: tokens (WCAG 2.2 AA)

| Pair                                    | Ratio            | Needs | Result     |
| --------------------------------------- | ---------------- | ----- | ---------- |
| White on `--amber` (primary button)     | 4.20 (axe: 4.19) | 4.5   | Fail (U18) |
| `--amber` eyebrow text on `--stone`     | 3.82             | 4.5   | Fail (U19) |
| Focus ring `#d5914f` on stone / surface | 2.39 / 2.63      | 3.0   | Fail (U20) |
| Input border `--line-strong` on surface | 1.59             | 3.0   | Fail (U21) |
| `--muted` on stone / surface            | 4.77 / 5.25      | 4.5   | Pass       |

## Scope of this PR

These are fixed here, in plain CSS, using the existing tokens with no new
dependency:

- U1, U2, U4–U9, U11, U13, U14, U16–U21.

These are recorded but not changed:

- **U12:** it needs the reconciliation read model to carry titles, which is a
  data change.
- **U15:** unifying H1 styles is a redesign decision.
- **U10:** deferred as low priority.
- **U3:** deferred. Locale-aware titles need the Workbench four-branch UNION and the Catalog read model to return both titles. That is a read-model change in queries #121 tuned for its latency gate, so it belongs in its own reviewed change.

Nothing in this PR changes approval, eligibility, export or publish logic, or
the cautious wording.
