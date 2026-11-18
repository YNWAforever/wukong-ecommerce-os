# Locale-aware dashboard product titles

Finish deferred audit finding U3: an operator using English should see the
English product name in Workbench and Catalog, and switching to Traditional
Chinese should immediately show that name when available.

## Approach

Return an additive, optional `titles` object (`en` and `zh-Hant`, nullable) beside
the existing `title`. Select the current locale in the client, then the other
language, then the existing title. Ignore blank/whitespace-only translations.
Old responses remain readable; URLs, filenames and untitled/export fallbacks
retain their existing behavior. No content is translated or written.

A locale parameter on each API would require refetching and incorporating locale
into request/cache state. Returning both names keeps language changes immediate
and preserves query/cursor identity. A broader title/read-model rewrite would
expand this task unnecessarily. This is the implementation choice made under the
request to select and ship one improvement.

## Constraints and acceptance

- Catalog platform/draft names keep current operator-owned/locked input precedence.
- Catalog empty-query reads still select page identities before hydrating at most
  one page of listing titles; search continues matching either language.
- Workbench adds only the second active-version title to its existing snapshot;
  classifications, counts, ordering, source labels and workspace scoping stay intact.
- Workbook reference products carry both imported names. Website titles, workbook
  filenames and scan URLs are single-source names and need no translation.
- Locale switching updates visible titles without another API read and without
  clearing Catalog selection, detail state or pagination.
- Real PostgreSQL tests cover search/non-search hydration and workspace boundaries;
  component tests cover both locales, missing translations and legacy responses.
- No dependency, schema migration, production data operation or manual deployment.

## Validation

Run focused regression tests red then green, the affected repository integration
suites against a newly created disposable Postgres container with a non-superuser
runtime role, full unit tests, typecheck and web production build. Review the
final diff independently before opening a PR. Report exact verification limits.
