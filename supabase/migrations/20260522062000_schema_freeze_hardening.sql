alter table public.scan_sessions
  add column if not exists expires_at timestamptz not null default (now() + interval '30 days'),
  add column if not exists ocr_text_deleted_at timestamptz;

alter table public.ocr_jobs
  add column if not exists expires_at timestamptz not null default (now() + interval '30 days'),
  add column if not exists result_deleted_at timestamptz;

alter table public.chat_sessions
  add column if not exists expires_at timestamptz not null default (now() + interval '180 days');

alter table public.chat_messages
  add column if not exists redacted_at timestamptz;

alter table public.medication_schedules
  add column if not exists start_date date,
  add column if not exists end_date date,
  add column if not exists active boolean not null default true;

update public.medication_schedules
set start_date = coalesce(start_date, created_at::date, current_date)
where start_date is null;

alter table public.medication_schedules
  alter column start_date set default current_date,
  alter column start_date set not null;

alter table public.medication_schedules
  drop constraint if exists medication_schedules_date_range_check,
  add constraint medication_schedules_date_range_check
    check (end_date is null or end_date >= start_date),
  drop constraint if exists medication_schedules_days_of_week_check,
  add constraint medication_schedules_days_of_week_check
    check (
      cardinality(days_of_week) between 1 and 7
      and days_of_week <@ array[0,1,2,3,4,5,6]
    );

alter table public.scan_detected_medications
  drop constraint if exists scan_detected_medications_match_method_check,
  add constraint scan_detected_medications_match_method_check
    check (match_method in ('exact', 'fuzzy', 'alias', 'edi_code', 'barcode', 'manual_review', 'none'));

alter table public.medication_aliases
  add column if not exists alias_type text not null default 'operator'
    check (alias_type in ('operator', 'brand', 'broad_brand', 'specific_brand', 'ocr_variant', 'barcode_label')),
  add column if not exists requires_confirmation boolean not null default true,
  add column if not exists priority integer not null default 100
    check (priority between 1 and 1000);

update public.medication_aliases
set alias_type = 'broad_brand',
    requires_confirmation = true,
    priority = 200
where normalized_alias in ('tylenol', 'aspirin');

update public.medication_aliases
set alias_type = 'specific_brand',
    requires_confirmation = false,
    priority = 20
where normalized_alias in ('tylenoler');

alter table public.consents
  add column if not exists policy_url text,
  add column if not exists content_hash text,
  add column if not exists ip text,
  add column if not exists user_agent text;

alter table public.audit_logs
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists request_id text,
  add column if not exists severity text not null default 'info'
    check (severity in ('debug', 'info', 'warning', 'error', 'critical'));

with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, medication_id
      order by created_at asc, id asc
    ) as keep_rank
  from public.user_medications
  where active = true
)
update public.user_medications um
set active = false,
    end_date = coalesce(um.end_date, current_date),
    updated_at = now()
from ranked r
where um.id = r.id
  and r.keep_rank > 1;

create unique index if not exists user_medications_one_active_medication_idx
  on public.user_medications (user_id, medication_id)
  where active = true;

with ranked as (
  select
    id,
    row_number() over (
      partition by user_medication_id, planned_date
      order by updated_at desc, created_at desc, id desc
    ) as keep_rank
  from public.medication_logs
  where schedule_id is null
)
delete from public.medication_logs ml
using ranked r
where ml.id = r.id
  and r.keep_rank > 1;

create unique index if not exists medication_logs_unscheduled_daily_unique_idx
  on public.medication_logs (user_medication_id, planned_date)
  where schedule_id is null;

create index if not exists scan_sessions_expires_at_idx
  on public.scan_sessions (expires_at)
  where ocr_text_deleted_at is null;

create index if not exists ocr_jobs_expires_at_idx
  on public.ocr_jobs (expires_at)
  where result_deleted_at is null;

create index if not exists chat_sessions_expires_at_idx
  on public.chat_sessions (expires_at);

create index if not exists medication_schedules_due_idx
  on public.medication_schedules (active, start_date, end_date, take_time);

create index if not exists medication_aliases_priority_idx
  on public.medication_aliases (normalized_alias, priority);

drop function if exists public.find_medication_candidates(text, integer);
drop function if exists public.find_medication_candidates_bulk(text[], integer);

create or replace function public.find_medication_candidates_bulk(search_texts text[], max_results integer default 1)
returns table (
  search_text text,
  id uuid,
  item_seq text,
  item_name text,
  entp_name text,
  edi_code text,
  similarity_score real,
  match_rank integer,
  match_source text,
  alias_requires_confirmation boolean,
  alias_type text
)
language sql
stable
as $$
  with inputs as (
    select distinct trim(value) as search_text
    from unnest(search_texts) as value
    where value is not null
      and length(trim(value)) > 1
  ),
  scored as (
    select
      i.search_text,
      m.id,
      m.item_seq,
      m.item_name,
      m.entp_name,
      m.edi_code,
      greatest(
        similarity(m.item_name, i.search_text),
        coalesce(max(similarity(ma.alias, i.search_text)), 0)
      )::real as similarity_score,
      min(
        case
          when lower(m.item_name) = lower(i.search_text) then 1
          when lower(ma.alias) = lower(i.search_text) then coalesce(ma.priority, 100)
          when m.edi_code = i.search_text then 2
          when i.search_text = any(m.bar_codes) then 3
          when ma.alias ilike '%' || i.search_text || '%' then coalesce(ma.priority, 100) + 10
          when i.search_text ilike '%' || ma.alias || '%' then coalesce(ma.priority, 100) + 20
          else 1000
        end
      ) as priority,
      bool_or(lower(ma.alias) = lower(i.search_text)) as has_exact_alias,
      bool_or(ma.alias ilike '%' || i.search_text || '%' or i.search_text ilike '%' || ma.alias || '%') as has_alias_match,
      bool_or(coalesce(ma.requires_confirmation, true)) filter (
        where lower(ma.alias) = lower(i.search_text)
          or ma.alias ilike '%' || i.search_text || '%'
          or i.search_text ilike '%' || ma.alias || '%'
      ) as alias_requires_confirmation,
      (
        array_agg(ma.alias_type order by coalesce(ma.priority, 100), ma.alias)
        filter (
          where lower(ma.alias) = lower(i.search_text)
            or ma.alias ilike '%' || i.search_text || '%'
            or i.search_text ilike '%' || ma.alias || '%'
        )
      )[1] as alias_type
    from inputs i
    join public.medications m
      on m.item_name % i.search_text
      or m.item_name ilike '%' || i.search_text || '%'
      or m.edi_code = i.search_text
      or i.search_text = any(m.bar_codes)
      or exists (
        select 1
        from public.medication_aliases ma2
        where ma2.medication_id = m.id
          and (
            ma2.alias % i.search_text
            or lower(ma2.alias) = lower(i.search_text)
            or ma2.alias ilike '%' || i.search_text || '%'
            or i.search_text ilike '%' || ma2.alias || '%'
          )
      )
    left join public.medication_aliases ma on ma.medication_id = m.id
    group by i.search_text, m.id, m.item_seq, m.item_name, m.entp_name, m.edi_code
  ),
  ranked as (
    select
      scored.*,
      row_number() over (
        partition by search_text
        order by priority, similarity_score desc, item_name
      )::integer as match_rank
    from scored
  )
  select
    ranked.search_text,
    ranked.id,
    ranked.item_seq,
    ranked.item_name,
    ranked.entp_name,
    ranked.edi_code,
    ranked.similarity_score,
    ranked.match_rank,
    case
      when lower(ranked.item_name) = lower(ranked.search_text) then 'exact'
      when ranked.edi_code = ranked.search_text then 'edi_code'
      when ranked.has_exact_alias or ranked.has_alias_match then 'alias'
      else 'fuzzy'
    end as match_source,
    coalesce(ranked.alias_requires_confirmation, false) as alias_requires_confirmation,
    ranked.alias_type
  from ranked
  where match_rank <= greatest(1, least(max_results, 20))
  order by search_text, match_rank;
$$;

create or replace function public.find_medication_candidates(search_text text, max_results integer default 5)
returns table (
  id uuid,
  item_seq text,
  item_name text,
  entp_name text,
  edi_code text,
  similarity_score real
)
language sql
stable
as $$
  select
    b.id,
    b.item_seq,
    b.item_name,
    b.entp_name,
    b.edi_code,
    b.similarity_score
  from public.find_medication_candidates_bulk(array[search_text], max_results) b;
$$;

create or replace function public.due_medication_notifications(
  p_window_start timestamptz default now(),
  p_window_end timestamptz default now() + interval '15 minutes',
  p_target_user_id uuid default null
)
returns table (
  user_id uuid,
  token_id uuid,
  token text,
  provider text,
  platform text,
  schedule_id uuid,
  user_medication_id uuid,
  medication_id uuid,
  medication_name text,
  take_time time,
  planned_date date,
  planned_time time,
  dose_amount numeric,
  dose_unit text
)
language sql
stable
security definer
set search_path = public
as $$
  with token_window as (
    select
      nt.*,
      (p_window_start at time zone nt.timezone)::date as local_date,
      (p_window_start at time zone nt.timezone)::time as local_start_time,
      (p_window_end at time zone nt.timezone)::time as local_end_time
    from public.notification_tokens nt
    where nt.enabled = true
  )
  select
    um.user_id,
    tw.id as token_id,
    tw.token,
    tw.provider,
    tw.platform,
    ms.id as schedule_id,
    um.id as user_medication_id,
    um.medication_id,
    coalesce(um.custom_name, m.item_name) as medication_name,
    ms.take_time,
    tw.local_date as planned_date,
    ms.take_time as planned_time,
    ms.dose_amount,
    ms.dose_unit
  from public.medication_schedules ms
  join public.user_medications um on um.id = ms.user_medication_id
  join public.medications m on m.id = um.medication_id
  join token_window tw on tw.user_id = um.user_id
  left join public.medication_logs ml
    on ml.user_medication_id = um.id
   and ml.schedule_id = ms.id
   and ml.planned_date = tw.local_date
   and ml.status in ('taken', 'skipped')
  where um.active = true
    and ms.active = true
    and ms.notification_enabled = true
    and (p_target_user_id is null or um.user_id = p_target_user_id)
    and tw.local_date >= coalesce(um.start_date, date '1900-01-01')
    and (um.end_date is null or tw.local_date <= um.end_date)
    and tw.local_date >= ms.start_date
    and (ms.end_date is null or tw.local_date <= ms.end_date)
    and extract(dow from tw.local_date)::integer = any(ms.days_of_week)
    and tw.local_start_time <= ms.take_time
    and ms.take_time < tw.local_end_time
    and ml.id is null;
$$;
