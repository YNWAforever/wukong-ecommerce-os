-- A terminal immutable parent cannot retain a live step lease, even after cancellation or a source edit.
CREATE OR REPLACE FUNCTION finish_listing_operation_steps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.input_revision IS NOT NULL AND (
    NEW.execution_state IN ('succeeded','failed','superseded','cancelled') OR NEW.status <> 'started'
  ) THEN
    UPDATE listing_pipeline_steps SET state='failed',lease_token=gen_random_uuid(),updated_at=now()
    WHERE workspace_id=NEW.workspace_id AND pipeline_run_id=NEW.id AND state='running';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS listing_terminal_steps_guard ON listing_pipeline_runs;
CREATE TRIGGER listing_terminal_steps_guard AFTER UPDATE OF execution_state,status ON listing_pipeline_runs
FOR EACH ROW EXECUTE FUNCTION finish_listing_operation_steps();
