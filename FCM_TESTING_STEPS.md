# FCM Token 저장 및 Controlled Real-send 테스트

이 문서는 프론트 FCM token 저장부터 수동 실발송 1회까지의 검증 절차다. 실제 secret 값은 문서에 기록하지 않는다.

## 1. 전제

- 프론트 Firebase project id: `duyuthon-iyakmoji`
- Supabase `FCM_PROJECT_ID`: `duyuthon-iyakmoji`
- Supabase `CRON_SECRET`과 Vault `maintenance_runner_cron_secret`은 같은 값
- `maintenance-runner`는 `verify_jwt=false`, `x-cron-secret` header로 보호
- 현재 자동 cron은 `dryRun=true`
- 실발송 전 `FCM_SERVICE_ACCOUNT_JSON` 서비스 계정이 `duyuthon-iyakmoji` 프로젝트의 FCM 발송 권한을 가져야 함

## 2. FCM Token 저장 확인

프론트에서 알림 권한을 허용하고 FCM token을 저장한다.

```ts
await supabase.functions.invoke("notification-tokens", {
  body: {
    token: "<FCM_TOKEN>",
    provider: "fcm",
    platform: "web",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul",
    enabled: true,
  },
});
```

DB 확인:

```sql
select
  id,
  user_id,
  provider,
  platform,
  timezone,
  enabled,
  last_seen_at,
  created_at
from public.notification_tokens
where user_id = '<TEST_USER_ID>'
order by created_at desc
limit 5;
```

## 3. 수동 Dry-run

Supabase SQL Editor에서 Vault secret을 사용해 호출한다. 이 방식은 secret 값을 콘솔이나 문서에 노출하지 않는다.

```sql
select net.http_post(
  url := 'https://hygsrrmoawezonahnljn.supabase.co/functions/v1/maintenance-runner',
  body := jsonb_build_object(
    'job', 'send_medication_reminders',
    'windowMinutes', 30,
    'targetUserId', '<TEST_USER_ID>',
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
```

응답 확인:

```sql
select id, status_code, error_msg, timed_out, content
from net._http_response
order by created desc
limit 5;
```

기대값:

- `status_code = 200`
- `content` 안의 `result.dryRun = true`
- 테스트 일정이 30분 window 안에 있으면 `pendingCount > 0`

## 4. Controlled Real-send 1회

아래 SQL은 실제 푸시를 전송한다. 테스트 사용자 1명에 대해서만 실행한다.

```sql
select net.http_post(
  url := 'https://hygsrrmoawezonahnljn.supabase.co/functions/v1/maintenance-runner',
  body := jsonb_build_object(
    'job', 'send_medication_reminders',
    'windowMinutes', 30,
    'targetUserId', '<TEST_USER_ID>',
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
```

delivery 확인:

```sql
select
  id,
  notification_token_id,
  schedule_id,
  user_medication_id,
  planned_date,
  planned_time,
  status,
  provider_message_id,
  error,
  sent_at,
  created_at at time zone 'Asia/Seoul' as created_at_kst
from public.medication_notification_deliveries
where notification_token_id in (
  select id
  from public.notification_tokens
  where user_id = '<TEST_USER_ID>'
)
order by created_at desc
limit 10;
```

기대값:

- 성공 시 `status = 'sent'`, `provider_message_id` 존재
- 실패 시 `status = 'failed'`, `error`에 FCM 오류 기록
- invalid token 계열 오류면 `notification_tokens.enabled=false`로 비활성화

## 5. Cron 실발송 전환 조건

- 실제 기기/브라우저에서 푸시 수신 확인
- `medication_notification_deliveries.status='sent'` 확인
- 같은 사용자/일정으로 중복 발송이 없는지 확인
- 위 조건 통과 후 `supabase/snippets/register-fcm-reminder-cron-live.sql`을 운영자가 실행
