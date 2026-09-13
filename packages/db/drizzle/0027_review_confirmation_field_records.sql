-- What each confirmed field was confirmed against.
--
-- The ledger recorded a field-granular confirmation at row granularity: eight
-- booleans said someone ticked eight boxes, and nothing said what was in front
-- of them for any one. The ingredients already existed -- the immutable
-- version, the imported row, field_evidence -- and this column binds a tick to
-- them as digests, derived server-side.
--
-- Nullable on purpose, and not back-filled: NULL means "confirmed before this
-- existed", which is true of every historical row. Recomputing digests now
-- would fabricate evidence for a review nobody performed at that time.
--
-- Strictly additive. review_confirmations already has row-level security and a
-- workspace policy, which this column inherits, so there are no policy changes
-- here. Re-running the file is a no-op.
ALTER TABLE review_confirmations
  ADD COLUMN IF NOT EXISTS field_records jsonb;

DO $field_records_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'review_confirmations'::regclass
      AND conname = 'review_confirmations_field_records_is_object'
  ) THEN
    ALTER TABLE review_confirmations
      ADD CONSTRAINT review_confirmations_field_records_is_object
      CHECK (
        field_records IS NULL
        OR jsonb_typeof(field_records) = 'object'
      );
  END IF;
END
$field_records_check$;
