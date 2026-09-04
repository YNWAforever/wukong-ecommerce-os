# Domain Context

## Shopline delivery

Shopline delivery is the listing decision that determines whether a specific
listing version may be delivered through `shopline_api` or CSV. The decision
uses one workspace-scoped view of the listing, active version, review flags,
connection metadata, and current publish job.

The decision is bound to the exact active-version ID and content digest. The
worker re-evaluates the same decision after queueing. An unavailable Shopline
connection produces an explicit CSV fallback; delivery never switches methods
silently.

## Shopline bulk form

The Shopline bulk form is the 71-column round-trip artifact for a catalog that
already exists on Shopline: export, edit cells, re-import keyed by `Product ID
(DO NOT EDIT)`. It is a different artifact from the 15-column create CSV, which
pushes new products out and carries descriptions and images.

The bulk form is how Wukong reads existing platform listings in and writes
enrichment back. Reading it is a total function over a cell matrix that reports
issues instead of throwing. Writing it is a diff: only the eight enrichable
content columns may change, the ten `DO NOT EDIT` columns are echoed verbatim,
and stock delta columns are always reset to `+0` so a re-import never moves
inventory.

Export writes back only through a listing's `platform_products` link — the
join the importer records between a listing and the remote product it came
from. A listing with no such link has no known remote product ID, so there is
no bulk-form row to update; it is not a bulk-form case at all. Every
non-enriched column in an exported row is exactly what the last import saw,
not SHOPLINE's current state, so a merchant-side change since import is
silently reverted on re-upload unless the catalog is re-imported first.

`platform_products` is no longer an import-only mirror: it is the one place
any listing's known SHOPLINE remote-product link lives. A row's `origin` is
either `import` (written by the bulk-form importer) or `created` (written the
first time a `shopline_api` delivery successfully creates a remote product for
a listing that had no prior link). Either origin means the listing has a known
remote product, so a later `shopline_api` delivery calls `updateProduct`
against it instead of creating a duplicate. Only `import`-origin rows carry a
SKU, spec version, raw row, and content digest — a `created`-origin row has
none of that, since there was no imported sheet to derive it from.

## Bulk approve

Bulk approve lets a reviewer select several `in_review` listings with no open
blocking compliance flags and approve them in one action. It is not a new
kind of approval — each selected listing goes through the exact same
single-listing approval logic, once per listing, in its own transaction, so
one listing's stale flag cannot roll back another's legitimate approval.
There is no field-level or partial-within-a-listing approval anywhere in the
system; approval is still whole-listing, all-or-nothing.

## Workspace roles

A workspace membership has one of five ranked roles: `viewer` < `operator` <
`reviewer` < `admin` < `owner`, enforced by
`apps/web/lib/session-context.ts`'s `roleOrder` and, at the database layer,
by CHECK constraints on `memberships.role` and `workspace_invites.role`.
`owner` is a bootstrap-only role — it is assigned once per workspace outside
of any UI, and no route in the admin area can grant it, change a member into
it, or change an `owner` member's role away from it; it is simply not one of
the roles the invite and role-change routes accept.

The rule that a workspace can never end up with zero `admin`-or-`owner`
memberships, and that an admin can never change or remove their own
membership, is enforced in the `memberships` repository itself
(`packages/db/src/repositories/memberships.ts`'s `updateRole`/`remove`,
via `MembershipGuardViolation`) — not only at the
`apps/web/app/api/workspace/members/[userId]/route.ts` route layer — so the
guarantee holds for any caller of the repository, not just the current UI.

## Bulk Update export eligibility

Single-listing bulk-form delivery and multi-product export share the same
eligibility policy and workbook builder. They require an approved/published
active version, no open blocking flags, all eight field and seven negative
confirmations for that listing/version, an import-origin remote link, matching
confirmation/source metadata, explicit freshness attestation and the current
header contract. Create CSV/API delivery keeps its separate policy.

Export prepares request-local evidence and rechecks version, confirmation
revision, flags and source/link identity at the final audit/attempt boundary.
An all-excluded or all-no-op multi-export returns a manifest with rowCount 0
and exportAttemptId null; it creates no object or successful export event.
Single bulk_form requests must explicitly send freshnessAttested: true.

These checks do not establish a durable approved-source receipt or atomic
Postgres/object-store publication. Immutable source/approval binding, artifact
hash/readiness and retry identity remain continuation Task 3.
