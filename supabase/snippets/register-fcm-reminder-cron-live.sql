-- Register the 30-minute FCM reminder cron in live-send mode.
-- Run only after controlled real-send succeeds.

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
        'dryRun', false,
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
