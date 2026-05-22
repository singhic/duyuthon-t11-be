create table if not exists public.medication_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  notification_token_id uuid not null references public.notification_tokens(id) on delete cascade,
  schedule_id uuid not null references public.medication_schedules(id) on delete cascade,
  user_medication_id uuid not null references public.user_medications(id) on delete cascade,
  planned_date date not null,
  planned_time time not null,
  provider text not null default 'fcm' check (provider in ('fcm', 'apns')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  provider_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (notification_token_id, schedule_id, planned_date, planned_time)
);

drop trigger if exists set_medication_notification_deliveries_updated_at
  on public.medication_notification_deliveries;

create trigger set_medication_notification_deliveries_updated_at
  before update on public.medication_notification_deliveries
  for each row execute function public.set_updated_at();

alter table public.medication_notification_deliveries enable row level security;

create policy "notification deliveries select own" on public.medication_notification_deliveries
  for select using (user_id = auth.uid() or public.is_admin());

create policy "notification deliveries admin insert" on public.medication_notification_deliveries
  for insert with check (public.is_admin());

create policy "notification deliveries admin update" on public.medication_notification_deliveries
  for update using (public.is_admin()) with check (public.is_admin());

create index if not exists medication_notification_deliveries_user_date_idx
  on public.medication_notification_deliveries (user_id, planned_date, planned_time);

create index if not exists medication_notification_deliveries_status_idx
  on public.medication_notification_deliveries (status, updated_at);

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
  with token_days as (
    select
      nt.*,
      gs.local_date::date as local_date
    from public.notification_tokens nt
    cross join lateral generate_series(
      (p_window_start at time zone nt.timezone)::date,
      (p_window_end at time zone nt.timezone)::date,
      interval '1 day'
    ) as gs(local_date)
    where nt.enabled = true
  )
  select
    um.user_id,
    td.id as token_id,
    td.token,
    td.provider,
    td.platform,
    ms.id as schedule_id,
    um.id as user_medication_id,
    um.medication_id,
    coalesce(um.custom_name, m.item_name) as medication_name,
    ms.take_time,
    td.local_date as planned_date,
    ms.take_time as planned_time,
    ms.dose_amount,
    ms.dose_unit
  from public.medication_schedules ms
  join public.user_medications um on um.id = ms.user_medication_id
  join public.medications m on m.id = um.medication_id
  join token_days td on td.user_id = um.user_id
  left join public.medication_logs ml
    on ml.user_medication_id = um.id
   and ml.schedule_id = ms.id
   and ml.planned_date = td.local_date
   and ml.status in ('taken', 'skipped')
  left join public.medication_notification_deliveries mnd
    on mnd.notification_token_id = td.id
   and mnd.schedule_id = ms.id
   and mnd.planned_date = td.local_date
   and mnd.planned_time = ms.take_time
   and mnd.status = 'sent'
  where um.active = true
    and ms.active = true
    and ms.notification_enabled = true
    and (p_target_user_id is null or um.user_id = p_target_user_id)
    and td.local_date >= coalesce(um.start_date, date '1900-01-01')
    and (um.end_date is null or td.local_date <= um.end_date)
    and td.local_date >= ms.start_date
    and (ms.end_date is null or td.local_date <= ms.end_date)
    and extract(dow from td.local_date)::integer = any(ms.days_of_week)
    and ((td.local_date + ms.take_time) at time zone td.timezone) >= p_window_start
    and ((td.local_date + ms.take_time) at time zone td.timezone) < p_window_end
    and ml.id is null
    and mnd.id is null;
$$;

create or replace function public.claim_due_medication_notifications(
  p_window_start timestamptz default now(),
  p_window_end timestamptz default now() + interval '15 minutes',
  p_target_user_id uuid default null,
  p_claim_ttl interval default interval '30 minutes'
)
returns table (
  delivery_id uuid,
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
volatile
security definer
set search_path = public
as $$
  with due as (
    select *
    from public.due_medication_notifications(p_window_start, p_window_end, p_target_user_id)
  ),
  claimed as (
    insert into public.medication_notification_deliveries (
      user_id,
      notification_token_id,
      schedule_id,
      user_medication_id,
      planned_date,
      planned_time,
      provider,
      status,
      error,
      provider_message_id,
      sent_at
    )
    select
      due.user_id,
      due.token_id,
      due.schedule_id,
      due.user_medication_id,
      due.planned_date,
      due.planned_time,
      due.provider,
      'pending',
      null,
      null,
      null
    from due
    on conflict (notification_token_id, schedule_id, planned_date, planned_time)
    do update set
      status = 'pending',
      error = null,
      provider_message_id = null,
      sent_at = null,
      updated_at = now()
    where public.medication_notification_deliveries.status = 'failed'
       or (
         public.medication_notification_deliveries.status = 'pending'
         and public.medication_notification_deliveries.updated_at < now() - p_claim_ttl
       )
    returning *
  )
  select
    claimed.id as delivery_id,
    due.user_id,
    due.token_id,
    due.token,
    due.provider,
    due.platform,
    due.schedule_id,
    due.user_medication_id,
    due.medication_id,
    due.medication_name,
    due.take_time,
    due.planned_date,
    due.planned_time,
    due.dose_amount,
    due.dose_unit
  from claimed
  join due
    on due.token_id = claimed.notification_token_id
   and due.schedule_id = claimed.schedule_id
   and due.planned_date = claimed.planned_date
   and due.planned_time = claimed.planned_time;
$$;
