-- Register the 30-minute FCM reminder cron in dry-run mode.
-- This is an operations snippet, not a schema migration.
-- Prerequisite:
--   - Supabase Secret CRON_SECRET is set for Edge Functions.
--   - Vault secret `maintenance_runner_cron_secret` contains the same value.
--   - pg_cron, pg_net, and supabase_vault are enabled.

select cron.unschedule('send-medication-reminders-every-30-min')
where exists (
  select 1
  from cron.job
  where jobname = 'send-medication-reminders-every-30-min'
);

select cron.unschedule('iykmj_reminders_dry_run_15m')
where exists (
  select 1
  from cron.job
  where jobname = 'iykmj_reminders_dry_run_15m'
);

select cron.schedule(
  'send-medication-reminders-every-30-min',
  '*/30 * * * *',
  $$
    select net.http_post(
      url := 'https://hygsrrmoawezonahnljn.supabase.co/functions/v1/maintenance-runner',
      body := jsonb_build_object(
        'job', 'send_medication_reminders',
        'windowMinutes', 30,
        'dryRun', true,
        'includeReminders', false
      ),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'maintenance_runner_cron_secret'
        )
      ),
      timeout_milliseconds := 30000
    );
  $$
);
