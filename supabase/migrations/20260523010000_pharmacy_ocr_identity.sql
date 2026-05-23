alter table public.pharmacies
  add column if not exists normalized_name text
    generated always as (nullif(lower(regexp_replace(coalesce(name, ''), '\s+', '', 'g')), '')) stored,
  add column if not exists normalized_phone text
    generated always as (nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')) stored,
  add column if not exists raw_source jsonb not null default '{}'::jsonb,
  add column if not exists source_updated_at timestamptz;

with ranked as (
  select
    id,
    first_value(id) over (
      partition by normalized_name, normalized_phone
      order by created_at asc, id asc
    ) as keep_id,
    row_number() over (
      partition by normalized_name, normalized_phone
      order by created_at asc, id asc
    ) as row_number
  from public.pharmacies
  where normalized_name is not null or normalized_phone is not null
),
duplicates as (
  select id, keep_id
  from ranked
  where row_number > 1
)
update public.scan_sessions ss
set pharmacy_id = d.keep_id
from duplicates d
where ss.pharmacy_id = d.id;

with ranked as (
  select
    id,
    row_number() over (
      partition by normalized_name, normalized_phone
      order by created_at asc, id asc
    ) as row_number
  from public.pharmacies
  where normalized_name is not null or normalized_phone is not null
)
delete from public.pharmacies p
using ranked r
where p.id = r.id
  and r.row_number > 1;

create unique index if not exists pharmacies_ocr_identity_unique_idx
  on public.pharmacies (normalized_name, normalized_phone) nulls not distinct
  where normalized_name is not null or normalized_phone is not null;

create index if not exists pharmacies_normalized_phone_idx
  on public.pharmacies (normalized_phone)
  where normalized_phone is not null;
