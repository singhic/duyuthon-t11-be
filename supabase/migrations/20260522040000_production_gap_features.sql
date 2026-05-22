alter table public.scan_sessions
  add column if not exists review_status text not null default 'not_needed'
    check (review_status in ('not_needed', 'needed', 'completed')),
  add column if not exists failure_reason text,
  add column if not exists recommended_action text,
  add column if not exists pharmacy_contact jsonb,
  add column if not exists ocr_quality jsonb not null default '{}'::jsonb;

alter table public.ocr_jobs
  add column if not exists failure_reason text;

alter table public.caregiver_links
  add column if not exists invited_by_user_id uuid references auth.users(id) on delete set null;

alter table public.scan_detected_medications
  add column if not exists match_quality text not null default 'unknown'
    check (match_quality in ('high', 'medium', 'low', 'none', 'unknown'));

alter table public.medications
  add column if not exists administration_timing text
    check (administration_timing is null or administration_timing in ('before_meal', 'after_meal', 'with_meal', 'bedtime', 'custom', 'unknown')),
  add column if not exists information_completeness jsonb not null default '{}'::jsonb;

create table if not exists public.notification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null,
  provider text not null default 'fcm' check (provider in ('fcm', 'apns')),
  device_id text,
  platform text check (platform is null or platform in ('ios', 'android', 'web')),
  timezone text not null default 'Asia/Seoul',
  enabled boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, token)
);

create trigger set_notification_tokens_updated_at before update on public.notification_tokens
  for each row execute function public.set_updated_at();

alter table public.notification_tokens enable row level security;

create policy "notification tokens select own" on public.notification_tokens
  for select using (user_id = auth.uid() or public.is_admin());
create policy "notification tokens insert own" on public.notification_tokens
  for insert with check (user_id = auth.uid());
create policy "notification tokens update own" on public.notification_tokens
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "notification tokens delete own" on public.notification_tokens
  for delete using (user_id = auth.uid());

create or replace function public.normalize_drug_interaction_pair()
returns trigger
language plpgsql
as $$
declare
  temp_id uuid;
begin
  if new.ingredient_a_id > new.ingredient_b_id then
    temp_id := new.ingredient_a_id;
    new.ingredient_a_id := new.ingredient_b_id;
    new.ingredient_b_id := temp_id;
  end if;
  return new;
end;
$$;

drop trigger if exists normalize_drug_interaction_pair_before_write on public.drug_interactions;
create trigger normalize_drug_interaction_pair_before_write
  before insert or update on public.drug_interactions
  for each row execute function public.normalize_drug_interaction_pair();

create or replace function public.check_interactions_for_medications(
  current_medication_ids uuid[],
  new_medication_id uuid
)
returns table (
  id uuid,
  ingredient_a_id uuid,
  ingredient_b_id uuid,
  severity text,
  description text,
  recommendation text,
  source text,
  source_url text,
  updated_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with current_ingredients as (
    select distinct ingredient_id
    from public.medication_ingredients
    where medication_id = any(current_medication_ids)
  ),
  new_ingredients as (
    select distinct ingredient_id
    from public.medication_ingredients
    where medication_id = new_medication_id
  ),
  pairs as (
    select
      least(c.ingredient_id, n.ingredient_id) as ingredient_a_id,
      greatest(c.ingredient_id, n.ingredient_id) as ingredient_b_id
    from current_ingredients c
    cross join new_ingredients n
    where c.ingredient_id <> n.ingredient_id
  )
  select
    di.id,
    di.ingredient_a_id,
    di.ingredient_b_id,
    di.severity,
    di.description,
    di.recommendation,
    di.source,
    di.source_url,
    di.updated_at
  from public.drug_interactions di
  join pairs p
    on p.ingredient_a_id = di.ingredient_a_id
   and p.ingredient_b_id = di.ingredient_b_id;
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
  select
    um.user_id,
    nt.id as token_id,
    nt.token,
    nt.provider,
    nt.platform,
    ms.id as schedule_id,
    um.id as user_medication_id,
    um.medication_id,
    coalesce(um.custom_name, m.item_name) as medication_name,
    ms.take_time,
    (p_window_start at time zone nt.timezone)::date as planned_date,
    ms.take_time as planned_time,
    ms.dose_amount,
    ms.dose_unit
  from public.medication_schedules ms
  join public.user_medications um on um.id = ms.user_medication_id
  join public.medications m on m.id = um.medication_id
  join public.notification_tokens nt on nt.user_id = um.user_id and nt.enabled = true
  left join public.medication_logs ml
    on ml.user_medication_id = um.id
   and ml.schedule_id = ms.id
   and ml.planned_date = (p_window_start at time zone nt.timezone)::date
   and ml.status in ('taken', 'skipped')
  where um.active = true
    and ms.notification_enabled = true
    and (p_target_user_id is null or um.user_id = p_target_user_id)
    and extract(dow from (p_window_start at time zone nt.timezone))::integer = any(ms.days_of_week)
    and ((p_window_start at time zone nt.timezone)::time <= ms.take_time)
    and (ms.take_time < (p_window_end at time zone nt.timezone)::time)
    and ml.id is null;
$$;

create or replace function public.get_medication_adherence_report(
  p_patient_user_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  report_date date,
  planned_count integer,
  taken_count integer,
  missed_count integer,
  skipped_count integer,
  adherence_rate numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with logs as (
    select
      ml.planned_date,
      count(*)::integer as planned_count,
      count(*) filter (where ml.status = 'taken')::integer as taken_count,
      count(*) filter (where ml.status = 'missed')::integer as missed_count,
      count(*) filter (where ml.status = 'skipped')::integer as skipped_count
    from public.medication_logs ml
    join public.user_medications um on um.id = ml.user_medication_id
    where um.user_id = p_patient_user_id
      and ml.planned_date between p_start_date and p_end_date
      and public.can_view_patient_data(p_patient_user_id, 'medication_status')
    group by ml.planned_date
  )
  select
    d::date as report_date,
    coalesce(l.planned_count, 0) as planned_count,
    coalesce(l.taken_count, 0) as taken_count,
    coalesce(l.missed_count, 0) as missed_count,
    coalesce(l.skipped_count, 0) as skipped_count,
    case
      when coalesce(l.planned_count, 0) = 0 then 0
      else round((coalesce(l.taken_count, 0)::numeric / l.planned_count::numeric) * 100, 2)
    end as adherence_rate
  from generate_series(p_start_date, p_end_date, interval '1 day') d
  left join logs l on l.planned_date = d::date
  order by d::date;
$$;

insert into public.ingredients (name)
values ('와파린'), ('아스피린')
on conflict (normalized_name) do nothing;

insert into public.drug_interactions (
  ingredient_a_id,
  ingredient_b_id,
  severity,
  description,
  recommendation,
  source
)
select
  least(a.id, b.id),
  greatest(a.id, b.id),
  'major',
  '항응고제와 아스피린 계열 성분은 출혈 위험을 높일 수 있습니다.',
  '함께 복용 중이거나 새로 복용하려는 경우 의사 또는 약사에게 반드시 확인하세요.',
  'sample_for_mvp_validation'
from public.ingredients a
join public.ingredients b on a.normalized_name = '와파린' and b.normalized_name = '아스피린'
on conflict (ingredient_a_id, ingredient_b_id) do nothing;
