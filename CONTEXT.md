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

## Bulk approve

Bulk approve lets a reviewer select several `in_review` listings with no open
blocking compliance flags and approve them in one action. It is not a new
kind of approval — each selected listing goes through the exact same
single-listing approval logic, once per listing, in its own transaction, so
one listing's stale flag cannot roll back another's legitimate approval.
There is no field-level or partial-within-a-listing approval anywhere in the
system; approval is still whole-listing, all-or-nothing.
