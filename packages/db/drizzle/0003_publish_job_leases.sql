alter table publish_jobs add column if not exists lease_token uuid;
alter table publish_jobs add column if not exists lease_expires_at timestamptz;
alter table publish_jobs add column if not exists attempt_count integer not null default 0;

alter table publish_jobs
  drop constraint if exists publish_jobs_status_check;
alter table publish_jobs
  add constraint publish_jobs_status_check
  check (status in ('pending_enqueue', 'queued', 'running', 'published', 'failed'));

create index if not exists publish_jobs_workspace_lease_idx
  on publish_jobs (workspace_id, status, lease_expires_at);
