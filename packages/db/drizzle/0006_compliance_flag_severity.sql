-- The check constraint on compliance_flags.severity has only ever allowed
-- 'info' | 'warning' | 'error' (0000_initial.sql), but every piece of domain
-- code (packages/core/src/compliance.ts, review.ts) uses 'blocking' | 'warning'
-- literally, and never 'info' or 'error'. Any listing whose AI-generated
-- content ever tripped a compliance pattern crashed when the pipeline tried
-- to persist the resulting flag — the INSERT violated this constraint.
-- Found by an integration test that inserts exactly what the real pipeline
-- inserts, against a real database.
ALTER TABLE compliance_flags DROP CONSTRAINT IF EXISTS compliance_flags_severity_check;
ALTER TABLE compliance_flags ADD CONSTRAINT compliance_flags_severity_check
  CHECK (severity IN ('blocking', 'warning'));
