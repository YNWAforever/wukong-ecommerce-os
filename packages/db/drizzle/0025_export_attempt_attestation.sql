-- What the operator attested, kept beside the attempt it authorised.
--
-- The export gate used to receive one boolean, which the only UI that calls it
-- hardcoded to true. A human was asked -- the panel disables its button until
-- the box is ticked -- but the attestation was made and enforced entirely in
-- the browser, so nothing recorded who attested, when, or what it covered, and
-- no UAT stage could cite it.
--
-- Nullable on purpose: NULL means "recorded before this column existed", which
-- is true of every historical row. A default of '[]' would invent an empty
-- attestation for exports that never had one, and the route's set-equality
-- check makes an empty array otherwise unreachable.
--
-- Strictly additive. The table already has ENABLE/FORCE row-level security and
-- a workspace policy (0014_export_attempts.sql:15-17), which this column
-- inherits, so there are no policy changes here. Re-running the file is a
-- no-op.
ALTER TABLE export_attempts
  ADD COLUMN IF NOT EXISTS source_attestation jsonb;

DO $attestation_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'export_attempts'::regclass
      AND conname = 'export_attempts_source_attestation_is_array'
  ) THEN
    ALTER TABLE export_attempts
      ADD CONSTRAINT export_attempts_source_attestation_is_array
      CHECK (
        source_attestation IS NULL
        OR jsonb_typeof(source_attestation) = 'array'
      );
  END IF;
END
$attestation_check$;
