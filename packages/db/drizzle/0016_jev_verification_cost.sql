-- The migration runner replays SQL files, so constraint additions are guarded.
ALTER TABLE ai_runs ALTER COLUMN estimated_cost_usd DROP NOT NULL;

DO $ai_runs_verification_cost$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_runs_nonverification_cost_required'
      AND conrelid = 'ai_runs'::regclass
  ) THEN
    ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_nonverification_cost_required
      CHECK (task = 'verify' OR estimated_cost_usd IS NOT NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_runs_nonnegative_known_cost'
      AND conrelid = 'ai_runs'::regclass
  ) THEN
    ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_nonnegative_known_cost
      CHECK (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0);
  END IF;
END
$ai_runs_verification_cost$;
