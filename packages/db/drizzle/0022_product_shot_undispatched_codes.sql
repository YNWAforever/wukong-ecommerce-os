-- Codes for an attempt that never reached a provider.
--
-- 0021 pinned error_code to six values, every one of which describes something
-- that happened DURING or AFTER a provider call. An attempt that was never
-- dispatched had no code it was allowed to carry, so the only way to end one
-- was to say nothing at all -- which is how a product shot could sit `queued`
-- for ever with no terminal state and no audit event.
--
-- Strictly additive: the new set is a superset of the old one, so no existing
-- row can be invalidated, and NULL (a queued attempt) stays permitted. Every
-- migration in this directory re-runs on each `migrate()`, so the drop is
-- IF EXISTS and the pair is idempotent: 0021 recreates nothing on a re-run
-- (CREATE TABLE IF NOT EXISTS), and 0022 always runs after it.
--
-- Deployment order: this migration must be applied BEFORE the Worker that
-- writes the new codes. A Worker ahead of it raises check_violation on exactly
-- the path meant to stop an attempt disappearing.
ALTER TABLE product_shot_attempts
  DROP CONSTRAINT IF EXISTS product_shot_attempts_error_code_check;

ALTER TABLE product_shot_attempts
  ADD CONSTRAINT product_shot_attempts_error_code_check
  CHECK (error_code IN (
    -- Reached the provider, or was already in flight.
    'rejected',
    'rate_limited',
    'invalid_output',
    'outcome_unknown',
    'processing_failed',
    'lease_expired',
    -- Never dispatched, so never charged.
    'provider_disabled',
    'budget_exhausted',
    'never_dispatched'
  ));
