# Supabase Cron FCM 복약 알림 검증

현재 운영 cron은 `maintenance-runner`를 30분마다 호출하며 초기 상태는 `dryRun=true`다.

## 등록 상태 확인

```sql
select
  jobid,
  jobname,
  schedule,
  active,
  command
from cron.job
where jobname = 'send-medication-reminders-every-30-min';
```

기대값:

- `schedule = '*/30 * * * *'`
- `active = true`
- command 안의 `dryRun`이 초기에는 `true`

## 최근 실행 로그

`cron.job_run_details`에는 `jobname` 컬럼이 없으므로 `cron.job`과 join해서 조회한다.

```sql
select
  d.jobid,
  j.jobname,
  d.status,
  d.return_message,
  d.start_time at time zone 'Asia/Seoul' as start_time_kst,
  d.end_time at time zone 'Asia/Seoul' as end_time_kst,
  extract(epoch from (d.end_time - d.start_time)) as duration_sec
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname = 'send-medication-reminders-every-30-min'
order by d.start_time desc
limit 12;
```

기대값:

- SQL 문법 에러 없음
- `status = 'succeeded'`
- `return_message`가 `1 row` 계열이면 `net.http_post` 요청 생성 성공

## HTTP 응답 확인

```sql
select
  id,
  status_code,
  error_msg,
  timed_out,
  content,
  created at time zone 'Asia/Seoul' as created_at_kst
from net._http_response
order by created desc
limit 10;
```

기대값:

- `status_code = 200`
- `content` 안에 `"job":"send_medication_reminders"`와 `"dryRun":true`
- `401`이면 Vault의 `maintenance_runner_cron_secret`과 Edge Secret `CRON_SECRET` 불일치

## 중복 발송 방지 확인

```sql
select
  notification_token_id,
  schedule_id,
  planned_date,
  planned_time,
  count(*) as delivery_count,
  string_agg(distinct status, ',') as statuses
from public.medication_notification_deliveries
where created_at > now() - interval '7 days'
group by notification_token_id, schedule_id, planned_date, planned_time
having count(*) > 1
order by delivery_count desc;
```

기대값: 결과가 없으면 정상이다.
