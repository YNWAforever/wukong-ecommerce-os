/**
 * The most listings one enrichment wave may claim.
 *
 * G12 asked for this cap to be enforced by the API rather than the UI. Half of
 * the API enforced it: `createBatch` rejected an out-of-range `waveSize`, and
 * the route schema repeated the same literal, but `advanceBatch` claimed using
 * the **stored** `batch.waveSize` with no bound at all. A row holding a larger
 * number -- through an earlier bug, a migration, or a direct write -- was
 * honoured, and one advance would dispatch that many AI calls.
 *
 * The lower bound needs no constant: `enrichment_batches.wave_size` carries
 * `CHECK (wave_size > 0)` (0005_enrichment_batches.sql:20), so Postgres already
 * refuses a zero or negative value however it is written. Only the ceiling was
 * unguarded, which is why the advance path clamps rather than rejects: clamping
 * can only ever dispatch fewer calls, never more, and it leaves a batch usable
 * instead of stranding it.
 *
 * It lives in its own leaf module, with no imports, so the route schema, the
 * service and a client form can all read one number. They were separate
 * literals, and moving one would have left the others enforcing the old bound
 * -- the same reason `bulk-approve-limit.ts` exists.
 */
export const MAX_ENRICHMENT_WAVE_SIZE = 5;
