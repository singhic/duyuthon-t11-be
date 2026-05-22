create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  birth_year integer check (birth_year is null or (birth_year between 1900 and extract(year from now())::integer)),
  role text not null default 'patient' check (role in ('patient', 'caregiver', 'admin')),
  phone text,
  accessibility_preference jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.medications (
  id uuid primary key default gen_random_uuid(),
  item_seq text unique,
  item_name text not null,
  entp_name text,
  edi_code text,
  atc_code text,
  bar_codes text[] not null default '{}',
  efficacy text,
  dosage text,
  precautions text,
  side_effects text,
  storage_method text,
  source text not null default 'data.go.kr',
  raw_source jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  code text,
  name text not null,
  normalized_name text generated always as (lower(regexp_replace(name, '\s+', '', 'g'))) stored,
  created_at timestamptz not null default now(),
  unique (code),
  unique (normalized_name)
);

create table public.medication_ingredients (
  medication_id uuid not null references public.medications(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete restrict,
  amount text,
  unit text,
  primary key (medication_id, ingredient_id)
);

create table public.pharmacies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  address text,
  lat numeric,
  lng numeric,
  source text,
  created_at timestamptz not null default now()
);

create table public.scan_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  image_path text,
  status text not null default 'uploaded' check (status in ('uploaded', 'ocr_processing', 'matching', 'completed', 'failed', 'deleted')),
  ocr_text text,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  pharmacy_id uuid references public.pharmacies(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  image_deleted_at timestamptz
);

create table public.ocr_jobs (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scan_sessions(id) on delete cascade,
  provider text not null default 'google_vision' check (provider in ('google_vision')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'succeeded', 'failed')),
  request_id text,
  input_image_path text,
  result_json jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz
);

create table public.scan_detected_medications (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scan_sessions(id) on delete cascade,
  medication_id uuid references public.medications(id) on delete set null,
  detected_name text not null,
  matched_name text,
  confidence numeric not null default 0 check (confidence >= 0 and confidence <= 1),
  match_method text not null default 'fuzzy' check (match_method in ('exact', 'fuzzy', 'edi_code', 'barcode', 'manual_review', 'none')),
  dosage_instruction jsonb not null default '{}'::jsonb,
  warning_message text,
  needs_confirmation boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.user_medications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  medication_id uuid not null references public.medications(id) on delete restrict,
  source_scan_id uuid references public.scan_sessions(id) on delete set null,
  custom_name text,
  start_date date,
  end_date date,
  source text not null default 'scan' check (source in ('scan', 'caregiver', 'admin', 'manual_confirmed')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.medication_schedules (
  id uuid primary key default gen_random_uuid(),
  user_medication_id uuid not null references public.user_medications(id) on delete cascade,
  take_time time not null,
  timing_rule text check (timing_rule in ('before_meal', 'after_meal', 'with_meal', 'bedtime', 'custom')),
  dose_amount numeric,
  dose_unit text,
  days_of_week integer[] not null default '{0,1,2,3,4,5,6}',
  notification_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.medication_logs (
  id uuid primary key default gen_random_uuid(),
  user_medication_id uuid not null references public.user_medications(id) on delete cascade,
  schedule_id uuid references public.medication_schedules(id) on delete set null,
  planned_date date not null,
  planned_time time,
  taken_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'taken', 'missed', 'skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_medication_id, schedule_id, planned_date)
);

create table public.drug_interactions (
  id uuid primary key default gen_random_uuid(),
  ingredient_a_id uuid not null references public.ingredients(id) on delete cascade,
  ingredient_b_id uuid not null references public.ingredients(id) on delete cascade,
  severity text not null default 'unknown' check (severity in ('contraindicated', 'major', 'moderate', 'minor', 'unknown')),
  description text not null,
  recommendation text,
  source text,
  source_url text,
  updated_at timestamptz not null default now(),
  check (ingredient_a_id <> ingredient_b_id),
  unique (ingredient_a_id, ingredient_b_id)
);

create table public.ai_analysis_results (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scan_sessions(id) on delete cascade,
  model_name text not null,
  prompt_version text not null,
  input_snapshot jsonb not null default '{}'::jsonb,
  output_json jsonb not null default '{}'::jsonb,
  safety_blocked boolean not null default false,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  created_at timestamptz not null default now()
);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scan_id uuid references public.scan_sessions(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_session_id uuid not null references public.chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  model_name text,
  citations jsonb not null default '{}'::jsonb,
  safety_level text check (safety_level in ('info', 'caution', 'urgent')),
  needs_doctor_or_pharmacist boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.caregiver_links (
  id uuid primary key default gen_random_uuid(),
  patient_user_id uuid not null references auth.users(id) on delete cascade,
  caregiver_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'invited' check (status in ('invited', 'accepted', 'revoked')),
  permission_scope jsonb not null default '{}'::jsonb,
  consented_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (patient_user_id, caregiver_user_id)
);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('privacy', 'sensitive_health_data', 'ai_processing', 'caregiver_share', 'marketing')),
  version text not null,
  accepted_at timestamptz not null default now(),
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id uuid,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create table public.api_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  provider text not null check (provider in ('google_vision', 'gemini', 'data_go_kr')),
  endpoint text not null,
  request_count integer not null default 1,
  token_count integer,
  image_count integer,
  cost_estimate numeric,
  status text not null default 'succeeded' check (status in ('succeeded', 'failed')),
  created_at timestamptz not null default now()
);

create index medications_item_name_trgm_idx on public.medications using gin (item_name gin_trgm_ops);
create index medications_edi_code_idx on public.medications (edi_code);
create index medications_atc_code_idx on public.medications (atc_code);
create index scan_sessions_user_id_idx on public.scan_sessions (user_id, created_at desc);
create index scan_detected_scan_id_idx on public.scan_detected_medications (scan_id);
create index user_medications_user_id_idx on public.user_medications (user_id, active);
create index medication_logs_medication_date_idx on public.medication_logs (user_medication_id, planned_date desc);
create index chat_sessions_user_id_idx on public.chat_sessions (user_id, created_at desc);
create index chat_messages_session_id_idx on public.chat_messages (chat_session_id, created_at);
create index caregiver_patient_idx on public.caregiver_links (patient_user_id, status);
create index caregiver_caregiver_idx on public.caregiver_links (caregiver_user_id, status);
create index consents_user_type_idx on public.consents (user_id, type, accepted_at desc);
create index api_usage_user_created_idx on public.api_usage_logs (user_id, created_at desc);

create trigger set_user_profiles_updated_at before update on public.user_profiles
  for each row execute function public.set_updated_at();
create trigger set_medications_updated_at before update on public.medications
  for each row execute function public.set_updated_at();
create trigger set_user_medications_updated_at before update on public.user_medications
  for each row execute function public.set_updated_at();
create trigger set_medication_schedules_updated_at before update on public.medication_schedules
  for each row execute function public.set_updated_at();
create trigger set_medication_logs_updated_at before update on public.medication_logs
  for each row execute function public.set_updated_at();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_profiles
    where user_id = auth.uid()
      and role = 'admin'
  );
$$;

create or replace function public.can_view_patient_data(patient_id uuid, permission_key text default 'medication_status')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select patient_id = auth.uid()
    or public.is_admin()
    or exists (
      select 1
      from public.caregiver_links
      where patient_user_id = patient_id
        and caregiver_user_id = auth.uid()
        and status = 'accepted'
        and revoked_at is null
        and coalesce((permission_scope ->> permission_key)::boolean, false)
    );
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
    m.id,
    m.item_seq,
    m.item_name,
    m.entp_name,
    m.edi_code,
    similarity(m.item_name, search_text) as similarity_score
  from public.medications m
  where search_text is not null
    and length(trim(search_text)) > 1
    and (
      m.item_name % search_text
      or m.item_name ilike '%' || search_text || '%'
      or m.edi_code = search_text
      or search_text = any(m.bar_codes)
    )
  order by
    case
      when m.item_name = search_text then 1
      when m.edi_code = search_text then 2
      when search_text = any(m.bar_codes) then 3
      else 4
    end,
    similarity(m.item_name, search_text) desc
  limit greatest(1, least(max_results, 20));
$$;

alter table public.user_profiles enable row level security;
alter table public.medications enable row level security;
alter table public.ingredients enable row level security;
alter table public.medication_ingredients enable row level security;
alter table public.pharmacies enable row level security;
alter table public.scan_sessions enable row level security;
alter table public.ocr_jobs enable row level security;
alter table public.scan_detected_medications enable row level security;
alter table public.user_medications enable row level security;
alter table public.medication_schedules enable row level security;
alter table public.medication_logs enable row level security;
alter table public.drug_interactions enable row level security;
alter table public.ai_analysis_results enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.caregiver_links enable row level security;
alter table public.consents enable row level security;
alter table public.audit_logs enable row level security;
alter table public.api_usage_logs enable row level security;

create policy "profiles select own or admin" on public.user_profiles
  for select using (user_id = auth.uid() or public.is_admin());
create policy "profiles insert own" on public.user_profiles
  for insert with check (user_id = auth.uid() and role in ('patient', 'caregiver'));
create policy "profiles update own" on public.user_profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid() and role in ('patient', 'caregiver'));

create policy "medication master readable" on public.medications
  for select using (auth.role() in ('authenticated', 'anon'));
create policy "ingredients readable" on public.ingredients
  for select using (auth.role() in ('authenticated', 'anon'));
create policy "medication ingredients readable" on public.medication_ingredients
  for select using (auth.role() in ('authenticated', 'anon'));
create policy "pharmacies readable" on public.pharmacies
  for select using (auth.role() in ('authenticated', 'anon'));
create policy "drug interactions readable" on public.drug_interactions
  for select using (auth.role() in ('authenticated', 'anon'));

create policy "scan select own or caregiver" on public.scan_sessions
  for select using (public.can_view_patient_data(user_id, 'scan_results'));
create policy "scan insert own" on public.scan_sessions
  for insert with check (user_id = auth.uid());

create policy "ocr jobs select via scan" on public.ocr_jobs
  for select using (
    exists (
      select 1 from public.scan_sessions s
      where s.id = scan_id and public.can_view_patient_data(s.user_id, 'scan_results')
    )
  );

create policy "detected meds select via scan" on public.scan_detected_medications
  for select using (
    exists (
      select 1 from public.scan_sessions s
      where s.id = scan_id and public.can_view_patient_data(s.user_id, 'scan_results')
    )
  );

create policy "user medications select own or caregiver" on public.user_medications
  for select using (public.can_view_patient_data(user_id, 'medication_status'));
create policy "user medications insert own" on public.user_medications
  for insert with check (user_id = auth.uid());
create policy "user medications update own" on public.user_medications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "schedules select via medication" on public.medication_schedules
  for select using (
    exists (
      select 1 from public.user_medications um
      where um.id = user_medication_id
        and public.can_view_patient_data(um.user_id, 'medication_status')
    )
  );
create policy "schedules insert own medication" on public.medication_schedules
  for insert with check (
    exists (
      select 1 from public.user_medications um
      where um.id = user_medication_id and um.user_id = auth.uid()
    )
  );
create policy "schedules update own medication" on public.medication_schedules
  for update using (
    exists (
      select 1 from public.user_medications um
      where um.id = user_medication_id and um.user_id = auth.uid()
    )
  );

create policy "logs select via medication" on public.medication_logs
  for select using (
    exists (
      select 1 from public.user_medications um
      where um.id = user_medication_id
        and public.can_view_patient_data(um.user_id, 'medication_status')
    )
  );
create policy "logs insert own medication" on public.medication_logs
  for insert with check (
    exists (
      select 1 from public.user_medications um
      where um.id = user_medication_id and um.user_id = auth.uid()
    )
  );
create policy "logs update own medication" on public.medication_logs
  for update using (
    exists (
      select 1 from public.user_medications um
      where um.id = user_medication_id and um.user_id = auth.uid()
    )
  );

create policy "ai analysis select via scan" on public.ai_analysis_results
  for select using (
    exists (
      select 1 from public.scan_sessions s
      where s.id = scan_id and public.can_view_patient_data(s.user_id, 'scan_results')
    )
  );

create policy "chat sessions select own" on public.chat_sessions
  for select using (user_id = auth.uid());
create policy "chat sessions insert own" on public.chat_sessions
  for insert with check (user_id = auth.uid());

create policy "chat messages select own session" on public.chat_messages
  for select using (
    exists (
      select 1 from public.chat_sessions cs
      where cs.id = chat_session_id and cs.user_id = auth.uid()
    )
  );
create policy "chat messages insert own session" on public.chat_messages
  for insert with check (
    exists (
      select 1 from public.chat_sessions cs
      where cs.id = chat_session_id and cs.user_id = auth.uid()
    )
  );

create policy "caregiver links select participants" on public.caregiver_links
  for select using (patient_user_id = auth.uid() or caregiver_user_id = auth.uid() or public.is_admin());
create policy "caregiver links insert patient or caregiver" on public.caregiver_links
  for insert with check (
    caregiver_user_id = auth.uid()
    and status = 'invited'
    and consented_at is null
    and revoked_at is null
  );
create policy "caregiver links update patient" on public.caregiver_links
  for update using (patient_user_id = auth.uid()) with check (patient_user_id = auth.uid());

create policy "consents select own" on public.consents
  for select using (user_id = auth.uid() or public.is_admin());
create policy "consents insert own" on public.consents
  for insert with check (user_id = auth.uid());
create policy "consents update own" on public.consents
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "audit logs admin select" on public.audit_logs
  for select using (public.is_admin());

create policy "api usage select own or admin" on public.api_usage_logs
  for select using (user_id = auth.uid() or public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'prescription-temp',
  'prescription-temp',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "prescription temp read own path" on storage.objects
  for select using (
    bucket_id = 'prescription-temp'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "prescription temp insert own path" on storage.objects
  for insert with check (
    bucket_id = 'prescription-temp'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "prescription temp update own path" on storage.objects
  for update using (
    bucket_id = 'prescription-temp'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "prescription temp delete own path" on storage.objects
  for delete using (
    bucket_id = 'prescription-temp'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
