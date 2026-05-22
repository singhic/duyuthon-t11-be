alter table public.drug_interactions
  add column if not exists external_source_id text,
  add column if not exists raw_source jsonb not null default '{}'::jsonb;

create index if not exists drug_interactions_external_source_idx
  on public.drug_interactions (source, external_source_id);
