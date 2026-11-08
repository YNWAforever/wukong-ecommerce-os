-- Cover the two composite tenant foreign keys that the Studio tables introduced
-- without a leading index. The release gate's foreign-key inventory asserts that
-- every workspace-scoped FK is backed by an index so tenant deletes/cascades do
-- not force a sequential scan.

CREATE INDEX IF NOT EXISTS studio_outputs_workspace_run_idx
  ON studio_outputs (workspace_id, run_id);

CREATE INDEX IF NOT EXISTS studio_runs_workspace_trigger_message_idx
  ON studio_runs (workspace_id, trigger_message_id);
