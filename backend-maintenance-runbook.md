# 이약뭐지 백엔드 운영 배치 Runbook

작성일: 2026-05-24

## 1. Cron 인증

`maintenance-runner`는 사용자 JWT를 받지 않는다. Supabase Scheduled Function 또는 외부 cron은 반드시 다음 header를 보낸다.

```text
x-cron-secret: <CRON_SECRET>
```

필요 Secret:

```bash
supabase secrets set CRON_SECRET=<long-random-secret>
```

`supabase/config.toml` 기준:

```toml
[functions.maintenance-runner]
verify_jwt = false
```

## 2. Scheduled Job Body

약품 마스터 page 적재:

```json
{
  "job": "sync_drug_master_page",
  "pageNo": 1,
  "numOfRows": 100
}
```

DUR known medications batch:

```json
{
  "job": "sync_dur_known_medications",
  "medicationLimit": 20,
  "maxDurRowsPerMedication": 100
}
```

`medicationOffset`을 생략하면 `sync_job_runs`의 마지막 성공 `next_cursor_offset`부터 이어서 실행한다. 전체를 끝까지 돌면 다음 cursor는 `0`으로 돌아가 다음 주기를 시작한다.

복약 알림 발송:

```json
{
  "job": "send_medication_reminders",
  "dryRun": true,
  "windowMinutes": 15
}
```

프론트 FCM token 저장과 controlled 실발송 테스트가 끝나기 전까지 scheduled job은 `dryRun=true`로 둔다.

민감정보 삭제:

```json
{
  "job": "redact_expired_sensitive_data",
  "dryRun": true
}
```

운영자가 삭제 대상 수를 확인하기 전까지 scheduled job은 `dryRun=true`로 둔다.

운영 스냅샷:

```json
{
  "job": "operation_snapshot"
}
```

`operation_snapshot`은 `maintenance-runner` 전용 운영 조회 job이다. 실발송/실삭제/동기화는 수행하지 않고 `sync_job_runs`, 약품 수, DUR count, FCM token/delivery count, reminder dry-run, redaction dry-run 결과만 반환한다.

## 3. 운영 확인 SQL

오늘 OCR 호출 수:

```sql
select count(*) as today_ocr_calls
from public.api_usage_logs
where provider = 'google_vision'
  and created_at >= date_trunc('day', now());
```

OCR 실패/저신뢰도 비율:

```sql
select
  count(*) filter (where status = 'failed') as failed_count,
  count(*) filter (where confidence is not null and confidence < 0.75) as low_confidence_count,
  count(*) as total_count
from public.scan_sessions
where created_at >= date_trunc('day', now());
```

약품 DB 총 개수와 주요 정보 누락률:

```sql
select
  count(*) as medication_count,
  count(*) filter (where efficacy is null) as missing_efficacy,
  count(*) filter (where dosage is null) as missing_dosage,
  count(*) filter (where precautions is null) as missing_precautions,
  count(*) filter (where storage_method is null) as missing_storage_method
from public.medications;
```

DUR interaction 총 개수:

```sql
select
  source,
  count(*) as interaction_count,
  max(updated_at) as last_updated_at
from public.drug_interactions
group by source
order by interaction_count desc;
```

최근 sync job 성공/실패:

```sql
select
  job_name,
  status,
  started_at,
  finished_at,
  cursor_offset,
  next_cursor_offset,
  batch_size,
  request_count,
  inserted_or_updated_count,
  skipped_count,
  error_message
from public.sync_job_runs
order by started_at desc
limit 30;
```

Gemini safety level 비율:

```sql
select
  safety_level,
  needs_doctor_or_pharmacist,
  count(*) as message_count
from public.chat_messages
where role = 'assistant'
  and created_at >= date_trunc('day', now())
group by safety_level, needs_doctor_or_pharmacist
order by message_count desc;
```

FCM 발송 성공/실패:

```sql
select
  status,
  count(*) as delivery_count,
  max(updated_at) as last_updated_at
from public.medication_notification_deliveries
where created_at >= date_trunc('day', now())
group by status
order by status;
```

FCM token 저장 현황:

```sql
select
  provider,
  platform,
  enabled,
  count(*) as token_count,
  max(last_seen_at) as last_seen_at
from public.notification_tokens
group by provider, platform, enabled
order by provider, platform, enabled desc;
```

invalid token 후보:

```sql
select id, user_id, provider, platform, enabled, last_seen_at
from public.notification_tokens
where enabled = false
order by last_seen_at desc
limit 50;
```

민감정보 삭제 대상:

```sql
select
  (select count(*) from public.scan_sessions where expires_at <= now() and ocr_text_deleted_at is null and ocr_text is not null) as scan_ocr_text_count,
  (select count(*) from public.ocr_jobs where expires_at <= now() and result_deleted_at is null) as ocr_result_count,
  (
    select count(*)
    from public.chat_messages cm
    join public.chat_sessions cs on cs.id = cm.chat_session_id
    where cs.expires_at <= now()
      and cm.redacted_at is null
  ) as chat_message_count;
```

최근 민감정보 삭제 감사 로그:

```sql
select created_at, metadata
from public.audit_logs
where action = 'redact_expired_sensitive_data'
order by created_at desc
limit 20;
```

## 4. 완료 기준

- `maintenance-runner`는 잘못된 `x-cron-secret`으로 호출하면 실패한다.
- `sync_job_runs`에 `succeeded`와 `failed` 실행 이력이 남는다.
- DUR batch는 offset 없이 호출해도 마지막 성공 위치부터 이어진다.
- 알림 job은 프론트 FCM token 저장 전에는 `dryRun=true`로만 확인한다.
- 민감정보 삭제 job은 운영 등록 전 `dryRun=true`로 대상 수를 먼저 확인한다.

## 5. 실발송 전환 기준

복약 알림을 `dryRun=false`로 바꾸는 조건:

- 프론트에서 `notification-tokens`에 실제 사용자 FCM token을 1개 이상 저장했다.
- 해당 사용자에게 15분 이내 활성 복약 일정이 있다.
- `maintenance-runner` 또는 admin 함수로 `targetUserId`, `includeReminders=true`, `dryRun=true` 호출 시 `pendingCount > 0`이 확인된다.
- 같은 조건의 controlled `dryRun=false` 1회 호출에서 `sentCount > 0`이고 `medication_notification_deliveries.status = 'sent'`가 남는다.
- 이후 scheduled job body를 `dryRun=false`로 변경한다.

민감정보 삭제를 `dryRun=false`로 바꾸는 조건:

- 위 “민감정보 삭제 대상” SQL 또는 dry-run 응답에서 삭제 대상 수를 운영자가 확인했다.
- 삭제 대상이 보존 정책과 맞는다.
- 첫 실삭제 후 `audit_logs.action = 'redact_expired_sensitive_data'` 기록을 확인한다.

## 6. 운영 스냅샷

확인 시각: 2026-05-24 12:35 KST

검증 경로:

- `maintenance-runner`에 `operation_snapshot` job 추가 및 원격 배포
- cron secret 없는 호출: `401`
- vault의 `maintenance_runner_cron_secret`을 사용한 pg_net 호출: `200`

현재 숫자:

| 항목 | 값 |
|---|---:|
| medications total | 847 |
| medications with item_seq | 847 |
| missing efficacy | 4 |
| missing dosage | 4 |
| missing precautions | 4 |
| missing storage_method | 4 |
| drug_interactions total | 19 |
| mfds_dur_usjnt_taboo interactions | 18 |
| notification_tokens total | 0 |
| enabled notification_tokens | 0 |
| delivery pending/sent/failed/skipped | 0 / 0 / 0 / 0 |
| reminder dry-run pendingCount | 0 |
| redaction scan OCR targets | 0 |
| redaction OCR job targets | 0 |
| redaction chat message targets | 0 |

최근 `sync_job_runs` 핵심 이력:

| job | status | cursor | next | batch | requests | upserts | error |
|---|---|---:|---:|---:|---:|---:|---|
| sync_dur_known_medications | succeeded | 42 | 52 | 10 | 10 | 1 |  |
| sync_dur_known_medications | succeeded | 32 | 42 | 10 | 10 | 104 |  |
| sync_dur_known_medications | succeeded | 22 | 32 | 10 | 10 | 57 |  |
| sync_dur_known_medications | failed | 22 | 22 | 20 | 0 | 0 | Function failed with IDLE_TIMEOUT before handler could finish |
| sync_dur_known_medications | succeeded | 2 | 22 | 20 | 20 | 15 |  |
| sync_drug_master_page | succeeded | 20 | 21 | 20 | 1 | 73 |  |

판정:

- DUR은 전체 847개 중 offset 52까지 진행된 상태다. 전체 순회 완료가 아니므로 운영 적재는 계속 진행해야 한다.
- `medicationLimit=20`에서 `IDLE_TIMEOUT`이 발생한 이력이 있어 scheduled job의 `medicationLimit=10` 설정은 유지한다.
- reminder cron은 pg_net 이력에서 15분마다 `200`, `dryRun=true`, `pendingCount=0`으로 동작 중이다.
- redaction daily cron은 등록되어 있으나 스냅샷 시각 기준 scheduled 실행 시간이 아직 지나지 않았다. 수동 dry-run 결과 삭제 대상은 0건이다.
- FCM token이 0개이므로 실제 발송 전환 금지 상태다.
