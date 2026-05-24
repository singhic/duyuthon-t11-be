create index if not exists scan_sessions_expired_images_idx
  on public.scan_sessions (expires_at)
  where image_path is not null
    and image_deleted_at is null;
