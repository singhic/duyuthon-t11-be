create unique index if not exists user_medications_active_scan_unique_idx
  on public.user_medications (user_id, medication_id, source_scan_id)
  where active = true and source_scan_id is not null;
