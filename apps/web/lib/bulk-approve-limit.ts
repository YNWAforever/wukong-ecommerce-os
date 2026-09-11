/**
 * The most listings one bulk-approve request accepts.
 *
 * 50 is a starting bound, not a load-bearing one -- see the design spec's open
 * questions. Chosen to keep a worst-case sequential loop comfortably
 * sub-second; a client selecting more than this chunks into multiple requests
 * rather than the server accepting an unbounded list.
 *
 * It lives in its own leaf module, with no imports, so the queue UI and the
 * schema that rejects an over-long list can both read it: a client component
 * cannot import the route, and the route must not pull in client code. They
 * were two separate literals, and moving one would have left the other
 * enforcing the old bound.
 */
export const MAX_BULK_APPROVE_ITEMS = 50;
