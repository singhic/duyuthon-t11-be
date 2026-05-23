create table if not exists public.sync_job_runs (
  id uuid primary key default gen_random_uuid(),
  job_name text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cursor_offset integer,
  next_cursor_offset integer,
  batch_size integer,
  request_count integer not null default 0 check (request_count >= 0),
  inserted_or_updated_count integer not null default 0 check (inserted_or_updated_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  error_message text,
  raw_result jsonb not null default '{}'::jsonb,
  check (cursor_offset is null or cursor_offset >= 0),
  check (next_cursor_offset is null or next_cursor_offset >= 0),
  check (batch_size is null or batch_size > 0),
  check (
    status = 'running'
    or finished_at is not null
  )
);

alter table public.sync_job_runs enable row level security;

create policy "sync job runs admin select" on public.sync_job_runs
  for select using (public.is_admin());

create index if not exists sync_job_runs_job_status_started_idx
  on public.sync_job_runs (job_name, status, started_at desc);

create index if not exists sync_job_runs_finished_idx
  on public.sync_job_runs (finished_at desc);
