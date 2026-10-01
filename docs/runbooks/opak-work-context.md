# Opak work context, accounts and admin changes

This slice requires the earlier runtime, intake and current-content batch PRs. Production acceptance and the first real SHOPLINE write remain separate release gates.

## Daily work

Catalog search settles after 300 ms and resets the page in the same URL update. Zero-prefixed SKU text remains text. Filters, responsibility, page and import scope survive contextual listing returns and browser history. Selection and scroll are stored as IDs/digests in this browser session, scoped to the server-derived workspace, actor and role. A changed scope or revoked authorization clears them. A temporary same-scope server failure keeps the last successful read with an error; SQL/authorization faults never become a successful empty response.

Reference details open in a focus-trapping drawer, close with Escape and return focus to the originating action. Reference records remain non-exportable. Current draft titles follow the existing active-review ownership rule; manual/locked fields and deliberately cleared commercial values remain authoritative.

Returning to Catalog restores scroll after the current selection's assignment read has settled, including a failed read. A retired request cannot settle a newer selection. Leaving the route cancels queued restoration and retains the saved position for a later return. Restoration uses the canonical catalog query and server-derived scope; it is consumed once after scrolling.

Clicking a draft synchronously retires restoration on the departing catalog before saving its position. A late assignment response cannot consume that newly saved position while navigation is pending. The incoming catalog owns the later restoration.

Work responsibility is a separate operation from approval. Operators can claim unassigned work or hand it to a current reviewer; reviewer/admin/owner can assign work. The server rechecks current memberships, locks listings in stable order and compares assignment revisions. Every row has an immutable replay receipt and audit event. Reviewers still approve the current content and source under the existing freshness checks. Catalog responsibility filters query current assignments and memberships before pagination, including demoted/removed assignees as unassigned.

## Accounts and support

The account menu displays server-scoped identity, workspace and role. Logout forwards the existing Better Auth sign-out handler, then confirms the original session is absent using an uncached session read. If deletion cannot be verified, the client retains its work and reports failure. Successful logout clears scoped client work before navigating to sign-in. Operator access to admin returns the existing 403 with a return path and support action.

Workspace selection verifies the browser Origin against the configured Better Auth deployment origin and rechecks active server membership. Internal proxy Host headers cannot redefine that origin. A dirty admin form resolves Save/Discard/Stay before any workspace selection POST; failed Save and Stay retain the original server workspace.

An approved switch remains owned until the request finishes. Tabs, links, native Back and second switch choices wait during that request. Withdrawing an unapproved choice cancels admission; it cannot release an already accepted switch and let another request race it.

Support shows only real current workspace admin/owner contacts, or an explicit unconfigured state. Safe request IDs help correlate failures without customer contents, tokens, provider prompts or outputs.

## Admin safety and readiness

Brand, policy, connection and invitation forms register dirty state. Tab changes, internal links and native same-document Back offer Save/Discard/Stay; successful saves are awaited. Validation or CAS conflicts retain input. History traversal restores the current entry while confirmation is open and replays the intended traversal once after approval; it adds no sentinel history entries. Native unload protection remains subject to browser behavior.

Brand and policy saves use the current normalized-profile digest, with explicit compare/reload actions for conflicts. Sequential saves share the newly returned digest without replacing the second form's draft. Settings clients must reload to obtain the required digest.

When neither a native history index nor this session's scoped marker is available, the guard cannot infer direction or distance. It retains the draft and current URL at the reached entry and, after Save/Discard, opens that exact recorded destination without guessing a traversal. Stay preserves the form and history length; the original stack position cannot be recovered in this fallback. Browser acceptance explicitly exercises unknown forward and multi-entry destinations.

The native history guard subscribes through the root before-interactive popstate bridge so it runs before the router's Window listener. A later capture listener does not establish this ordering for a Window target. Only a mounted admin guard owns the callback; cleanup removes it.

Admin readiness is an observed, bounded workspace read. It distinguishes ready/blocked/unknown for reviewers, SHOPLINE, AI, worker and storage. Connection presence is not token health; fake AI is not paid-provider health; storage stays unknown without a trusted observation. It performs no provider probe or merchant write and returns no secrets.

## Verification and release

Use dedicated loopback databases only. The opt-in assignment/admin suites fail closed on an unexpected database identity.

```text
pnpm typecheck
pnpm exec turbo run test --concurrency=1 -- --maxWorkers=1
pnpm build
pnpm --filter @wukong/web test components/catalog-control-center.test.tsx lib/catalog-query-state.test.ts lib/catalog-session-state.test.ts components/catalog-detail-drawer.test.tsx lib/workbench-navigation.test.ts components/jobs-ledger-client.test.tsx
pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/listing-assignments.integration.test.ts --maxWorkers=1
pnpm exec vitest run --config vitest.integration.config.ts packages/db/src/repositories/opak-admin-readiness.integration.test.ts --maxWorkers=1
pnpm exec playwright test tests/e2e/opak-catalog-context.spec.ts tests/e2e/opak-account-assignment.spec.ts tests/e2e/opak-admin-dirty.spec.ts tests/e2e/opak-admin-workspace-switch.spec.ts --project=chromium --workers=1 --retries=0
```

Integration requires `WUKONG_OPAK_INTEGRATION=1`, explicit `TEST_DATABASE_URL` and `TEST_DATABASE_ADMIN_URL`, respectively `opak_fixes_assignment_20261001` and `opak_fixes_admin_20261001`. Browser requires `WUKONG_OPAK_E2E=1`, `PLAYWRIGHT_E2E=1`, a loopback base URL and an `opak_fixes_` database with fake AI/mock SHOPLINE and publishing disabled. CI provisions and runs these gates; discovered tests alone are not acceptance evidence.

Recorded local D acceptance: 3,865 package tests passed with one skip; root release/CI contracts 117/117, typecheck 14/14, build 8/8 and the authenticated four-spec browser suite 11/11. The browser gate includes real local Better Auth session invalidation, dirty workspace switches, native history and <=2px catalog return restoration. These results do not certify cloud sessions, production readiness or merchant writes.

Additive migration `0052_listing_assignments.sql` creates `listing_assignments` and immutable `listing_assignment_requests`, composite workspace/listing fences, an assignee index, forced RLS and non-bypass application grants. The existing auditor inventories both tables. There are no new production environment variables or paid-provider requirements.

Before rollout, apply the additive migration through the approved isolated staging procedure, verify app-role RLS and auditor inventory, then deploy the dependent web slice. On rollback, stop new assignment admission and revert the web slice. Retain assignment receipts, audit, current inputs, source bindings and cost reservations; do not drop tables or rewrite workflow states. An already accepted assignment remains independently reviewable and does not approve or publish a product.
