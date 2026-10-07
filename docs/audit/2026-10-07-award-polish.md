# UI polish pass toward award-level SaaS quality (2026-10-07)

This pass follows `2026-10-05-ui-critique.md`. That audit fixed the review
loop, the import states and the contrast tokens. This one looks at the product
as a whole, asking whether it reads as one system, and works in short loops:
critique, fix, re-capture, re-measure.

Data is synthetic: a real-stack run (fake AI, mock SHOPLINE) seeded by the
project's own Playwright journeys, with a synthetic admin enrolled through
`/register`. No merchant data or live service was used.

## Method

Each round re-captured every screen. That is 15 screens (13 signed in, 2
signed out) at 1440 and 390 px, in both EN and 繁中, for 60 full-page
captures. Each capture recorded:

- horizontal overflow
- console and page errors
- cumulative layout shift (CLS)

The final round also ran axe-core 4.10 with the WCAG 2.0, 2.1 and 2.2 A/AA tags
on all 15 screens in both languages.

| Measure                                     | Before       | After     |
| ------------------------------------------- | ------------ | --------- |
| Captures with CLS > 0.05 (of 60)            | 30           | 0         |
| Worst CLS (Workbench, 390 px)               | 0.65         | 0         |
| Workbench page height, 1440 px, 25 rows     | 4,518 px     | ~2,580 px |
| axe WCAG 2.2 AA violations (30 page×locale) | not measured | 0         |
| Horizontal overflow / console errors        | 0 / 0        | 0 / 0     |

## Findings and what changed

### System level

| #   | Finding                                                                                                                                                                                                          | Change                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `Inter` was named in the font stack but never loaded, so every screen rendered in the OS fallback.                                                                                                               | Inter is self-hosted through `next/font`, with CJK fallbacks named explicitly.                                                                                                    |
| A2  | Georgia has only old-style figures. "Synthetic task 0" rendered its zero as a lowercase "o", and so would every vintage in a product title.                                                                      | The display face is self-hosted Source Serif 4, which has lining figures, through a `--font-display` token. The last Georgia rules now use the token.                             |
| A3  | Status was plain text on most screens. Where it was coloured, the same state used different colours on different screens (In review was amber on detail and plain on Catalog).                                   | There is one `StatusPill` (`components/status-pill.tsx`) and one set of `--tone-*` tokens, each 6.8–7.4:1. Workbench, Catalog, Admin and the detail and batch chips all use them. |
| A4  | Page titles mixed a sans Workbench H1 with 46 px serif marketing taglines ("Your complete work queue, grouped by status"), and an eyebrow repeated the nav label above each title.                               | Every page has one H1 style: display serif, 28–36 px. The H1 is the page name from the nav, the lede carries the explanation, and section H2s are semibold sans.                  |
| A5  | The footer started inside the first viewport and jumped down when content streamed in. This was the CLS on every signed-in page.                                                                                 | `.app-main` reserves the viewport below the top bar.                                                                                                                              |
| A6  | Seven CSS variables were used but never defined (`--space-*`, `--color-text*`, `--border`, `--radius-md`, `--color-danger`, plus `--accent` and `--cobalt`), so the browser silently dropped those declarations. | They are defined as aliases of the existing tokens. The two one-off references now point at real tokens.                                                                          |
| A7  | Every `<details>` showed the browser's default triangle.                                                                                                                                                         | A drawn chevron replaces it and rotates when the disclosure is open. Reduced motion is respected.                                                                                 |
| A8  | The account menu was a raw disclosure that wrapped "▶ Account · email" over two lines.                                                                                                                           | It is now an initials avatar, a truncated identity and a chevron. The full text is kept as the accessible name.                                                                   |

### Screens

| #   | Screen         | Finding                                                                                                                                                                                          | Change                                                                                                                                                                            |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Workbench      | Rows were 150 px each, with a repeated "LISTINGS" eyebrow and status as body text.                                                                                                               | Rows are ~70 px: title and status pill on one line, kind, source, count and time on a muted line.                                                                                 |
| S2  | Workbench      | The Import button and the list arrived after load and pushed the page down (CLS 0.63 on mobile).                                                                                                 | The action slot is reserved, skeleton rows hold the list's space, and pending counts match final height.                                                                          |
| S3  | Catalog        | Draft rows had unstyled status, blocker and action cells, and their text was larger than the product name.                                                                                       | Draft rows match platform rows: pill, blocker chip, action button. Cells are 14 px.                                                                                               |
| S4  | Catalog        | On mobile the stacked header was centred while every other page was left-aligned.                                                                                                                | It is left-aligned.                                                                                                                                                               |
| S5  | Work Queue     | Empty buckets stretched to the height of the populated bucket beside them, and zero counts used the amber alert badge.                                                                           | Populated buckets span the row, empty ones collapse, and zero counts are neutral.                                                                                                 |
| S6  | Listing detail | The source-readiness lines sat unstyled above the title. The breadcrumb said "Dashboard" though the nav says "Workbench".                                                                        | Readiness is a toned callout under the header, and the breadcrumb reads "Workbench".                                                                                              |
| S7  | Admin          | Every string was bilingual in both modes, and roles showed as raw keys (`operator`).                                                                                                             | The page, the members panel and the settings panel are localised, and roles use their display names. Three files come off the unlocalised ratchet in `lib/ui-vocabulary.test.ts`. |
| S8  | Batches        | The create form was unstyled: inline labels, raw field keys (`nameZh`, `seoTitleEn`) as checkbox labels, and an ISO expiry time.                                                                 | The form has a labelled grid, human field names in both languages, chip toggles, an HK-formatted expiry, a "New batch" and "Existing batches" structure, and a real empty state.  |
| S9  | Quality        | `US$0.00` wrapped mid-number, and "Refresh counts" was a native button.                                                                                                                          | Metric values never wrap, and the button is styled.                                                                                                                               |
| S10 | New listing    | The EN button read "選擇檔案 Select files", and the notes label repeated itself.                                                                                                                 | Both are localised.                                                                                                                                                               |
| S11 | Jobs, Admin    | The segmented filter's track was the page colour, so it read as loose text.                                                                                                                      | The track is visible and fits its options.                                                                                                                                        |
| S12 | Sign-in        | The tagline was meant to be 28 px but a broader rule shrank it to 14 px. The mark said "WK" while the app says "W". The eyebrow repeated the heading, and the method tabs sat above the heading. | The specificity is fixed, the mark matches the app, and the hierarchy is heading, then method, then form.                                                                         |

## Verification

- `pnpm typecheck` passes. Web unit tests: 231 files, 2,322 tests. Root
  `node --test` suites: 145 of 145.
- CI's Opak browser set ran against a dedicated `opak_fixes_*` database with
  `WUKONG_OPAK_E2E=1`. Separately, the workbench, listing-pilot, workbook and
  catalog-usability specs ran on the real stack. Everything passed except one
  spec: `bulk-update-pilot` › "reviewer completes attended Bulk Update…".
- That spec times out on a 5 s wait while the listing reloads. It also fails
  1 run in 2 on an unmodified `main` build in the same environment, so it is
  pre-existing load flakiness, not this change.
- Specs that selected batch checkboxes by raw key (`nameZh`) now use
  `contentFieldLabel()` and are scoped to the batch fieldset. The same labels
  appear on the Bulk Update export panel. The admin switch spec now accepts
  either single-language heading.
- Web fonts use `display: "optional"`. Swapping a face in late shifted the
  Catalog's restored scroll position by 8 px under load, and
  `opak-catalog-context` caught it.

## Not changed

- **U3** (EN titles shown in Chinese on Workbench and Catalog) and **U12** (Jobs
  rows identified by UUID). Both need read-model changes and stay deferred for
  the reasons recorded on 2026-10-05.
- **Dark mode.** The product has none. Adding it is a design decision, not a
  polish item.
- **`listing-view-models.ts` and `lib/listing-approval.ts`** remain on the
  unlocalised ratchet.

Nothing in this pass changes approval, eligibility, export or publish logic, or
the cautious domain wording.
