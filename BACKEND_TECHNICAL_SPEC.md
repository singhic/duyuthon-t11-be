# 이약뭐지 백엔드 기술명세서

작성일: 2026-05-25  
대상 시스템: Supabase PostgreSQL, Storage, Edge Functions  
원격 프로젝트: `hygsrrmoawezonahnljn`  
Base URL: `https://hygsrrmoawezonahnljn.supabase.co`

## 1. 개요

이약뭐지 백엔드는 처방전 OCR, 약품 매칭, 복용약 등록, 복약 일정/체크리스트, 약물 상호작용 확인, 챗봇 상담, 보호자 연동, 복약 리포트, FCM 복약 알림을 담당한다.

핵심 원칙:

- 사용자의 건강/복약 데이터는 Supabase Auth 사용자 기준으로 격리한다.
- 약품 마스터 데이터(`medications`)와 사용자 복용 데이터(`user_medications`)를 분리한다.
- 사용자 복용약 제거는 hard delete가 아니라 soft delete로 처리한다.
- OCR 원문, 이미지, 채팅 메시지 등 민감정보는 TTL 및 redaction job으로 정리한다.
- FCM 발송은 프론트가 아니라 백엔드 scheduled job이 수행한다.

## 2. 런타임 구성

### Supabase

- PostgreSQL major version: 15
- Edge Functions runtime: Deno
- Storage bucket:
  - `prescription-temp`: 처방전 임시 이미지 저장용 private bucket
- 주요 확장:
  - `pgcrypto`
  - `pg_trgm`
  - `pg_cron`
  - `pg_net`
  - `supabase_vault`

### 인증

대부분의 Edge Function은 `verify_jwt=true`이며 Supabase Auth access token이 필요하다.

예외:

- `maintenance-runner`
  - `verify_jwt=false`
  - 대신 `x-cron-secret` header와 Supabase Secret `CRON_SECRET`으로 보호한다.
  - Supabase Cron 전용 운영 wrapper다.

## 3. Secret 구성

클라이언트에 절대 노출하면 안 되는 Secret:

```text
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_SECRET_KEYS
GOOGLE_SERVICE_ACCOUNT_JSON
FCM_SERVICE_ACCOUNT_JSON
GOOGLE_VISION_API_KEY
GEMINI_API_KEY
DATA_GO_KR_SERVICE_KEY
CRON_SECRET
```

주요 Secret 역할:

| Secret | 용도 |
|---|---|
| `SUPABASE_URL` | Edge Function 내부 Supabase 접근 |
| `SUPABASE_ANON_KEY` | 사용자 JWT 검증/REST 호출 |
| `SUPABASE_SERVICE_ROLE_KEY` | 관리자성 DB 작업 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Vision OCR 등 Google API |
| `FCM_SERVICE_ACCOUNT_JSON` | FCM HTTP v1 발송 전용 |
| `FCM_PROJECT_ID` | Firebase 프로젝트 ID, 현재 `duyuthon-iyakmoji` |
| `GEMINI_API_KEY` | Gemini 챗봇 |
| `DATA_GO_KR_SERVICE_KEY` | 공공 의약품 API |
| `CRON_SECRET` | `maintenance-runner` 호출 보호 |

FCM은 OCR용 `GOOGLE_SERVICE_ACCOUNT_JSON`을 사용하지 않는다. FCM 발송은 `FCM_SERVICE_ACCOUNT_JSON`으로 분리한다.

## 4. 데이터 모델

주요 테이블:

| 테이블 | 설명 |
|---|---|
| `user_profiles` | 사용자 프로필 및 role |
| `scan_sessions` | 처방전 스캔 세션, OCR 결과, 이미지 TTL |
| `scan_detected_medications` | OCR/analyze 결과로 감지된 약품 후보 |
| `ocr_jobs` | OCR 처리 상태 및 실패 로그 |
| `pharmacies` | OCR에서 추출된 약국 후보 |
| `medications` | 공공 의약품 마스터 데이터 |
| `medication_aliases` | 약품명 별칭 및 영문 브랜드 매칭 |
| `user_medications` | 사용자의 현재/과거 복용약 |
| `medication_schedules` | 복약 일정 |
| `medication_logs` | 복약 체크/복용 이력 |
| `drug_interactions` | 약물 상호작용/DUR 데이터 |
| `notification_tokens` | FCM/APNS token 저장 |
| `medication_notification_deliveries` | 알림 발송 claim/result |
| `chat_sessions`, `chat_messages` | 복약 챗봇 대화 |
| `caregiver_relationships` | 보호자 연결 및 권한 |
| `sync_job_runs` | 운영 동기화 job 이력 |
| `api_usage_logs` | 외부 API 사용량/실패 기록 |

중요 제약:

- active 복용약 중복 방지 unique index가 있다.
- `medication_schedules`는 `active`, `start_date`, `end_date`, `days_of_week` 검증을 가진다.
- `medication_notification_deliveries`는 `notification_token_id + schedule_id + planned_date + planned_time` 조합으로 중복 발송을 막는다.
- 복용약 제거 시 `medication_logs`, `scan_sessions`, `scan_detected_medications`, `medications`는 삭제하지 않는다.

## 5. Edge Functions

### OCR 및 약품 분석

| Function | Auth | 설명 |
|---|---:|---|
| `google-ocr` | JWT | Storage 이미지 OCR, OCR 결과 저장, 성공 시 원본 이미지 삭제 시도 |
| `analyze-medication` | JWT | OCR text에서 약품 후보 추출, 내부 DB/공공 API/fuzzy 매칭 |
| `delete-scan-image` | JWT | 처방전 원본 이미지 명시 삭제 |

기본 흐름:

1. 프론트가 `prescription-temp`에 JPEG/PNG 업로드
2. `scan_sessions` 생성
3. `google-ocr` 호출
4. `analyze-medication` 호출
5. 사용자가 약품 후보 확인 후 `confirm-medication` 호출

OCR 제한:

- 지원 형식: `jpg`, `jpeg`, `png`
- WebP/HEIC는 프론트에서 변환 후 업로드한다.
- 저신뢰도/빈 OCR 결과는 manual review 플래그와 recommended action으로 전달한다.

### 복용약 등록/관리

| Function | Auth | 설명 |
|---|---:|---|
| `confirm-medication` | JWT | OCR 감지 약품을 사용자 복용약으로 확정하거나 기존 복용약 이름 수정 |
| `user-medications` | JWT | 현재 복용약 조회 및 약 전체 제거 |
| `medication-schedules` | JWT | 복약 일정 생성/조회/수정/비활성화 |
| `medication-checklist` | JWT | 날짜별 복약 체크리스트 조회 |
| `medication-logs-check` | JWT | 복용 완료/스킵 로그 생성 |
| `suggest-medication-schedules` | JWT | OCR/공공 DB 복용법 기반 일정 후보 제안 |

`confirm-medication` 모드:

- OCR confirm mode:
  - 입력: `detectedMedicationId`
  - 의미: `scan_detected_medications.id`
  - 주의: `medications.id`나 `medication_id`를 보내면 안 된다.
- Rename mode:
  - 입력: `userMedicationId`, `customName`
  - 기존 복용약 표시명을 수정한다.

`user-medications`:

- `GET /functions/v1/user-medications`
  - query: `active=true|false|all`
  - 기본값: `active=true`
  - `medications` 상세 정보를 join해서 반환한다.
- `DELETE /functions/v1/user-medications`
  - body: `{ "userMedicationId": "uuid" }`
  - soft delete:
    - `user_medications.active=false`
    - `end_date=Asia/Seoul 오늘`
    - 관련 `medication_schedules.active=false`
    - 관련 `medication_schedules.notification_enabled=false`
    - pending delivery는 `status='skipped'`
  - 이미 inactive면 idempotent 성공으로 반환한다.

### 상호작용 및 챗봇

| Function | Auth | 설명 |
|---|---:|---|
| `check-interactions` | JWT | 현재 active 복용약과 대상 약품 간 상호작용 검사 |
| `gemini-chat` | JWT | 복약 안전 중심 챗봇 |

상호작용 응답은 안전 단정을 피한다. 등록된 경고가 없을 때도 `safe`가 아니라 `no_registered_warning` 계열 의미로 처리한다.

`gemini-chat`는 다음을 차단/주의 처리한다.

- 용량 증감, 복용 중단, 처방 변경
- 음주/임신/응급 증상
- 프롬프트 우회, 시스템 프롬프트 공개 요청
- 복약과 무관한 법률/금융/정치/일반 상담

### 알림

| Function | Auth | 설명 |
|---|---:|---|
| `notification-tokens` | JWT | 사용자 FCM/APNS token 저장/조회 |
| `send-medication-reminders` | JWT + admin | 복약 알림 대상 계산 및 FCM 발송 |
| `maintenance-runner` | `x-cron-secret` | Cron에서 호출하는 운영 wrapper |

`notification-tokens`:

- `GET`: 현재 사용자 token 목록 조회
- `POST`: token upsert

POST body:

```json
{
  "token": "fcm registration token",
  "provider": "fcm",
  "platform": "web",
  "timezone": "Asia/Seoul",
  "enabled": true
}
```

`send-medication-reminders`:

- 기본 `dryRun=true`
- `dryRun=true`: 대상 계산만 수행, FCM 발송/claim 없음
- `dryRun=false`: `claim_due_medication_notifications` RPC로 먼저 claim 후 FCM 발송
- FCM 성공/실패는 `medication_notification_deliveries`에 기록
- invalid token 계열 오류는 token을 자동 비활성화한다.
  - `UNREGISTERED`
  - `NotRegistered`
  - `INVALID_ARGUMENT`
  - `SENDER_ID_MISMATCH`

`maintenance-runner` reminder job body:

```json
{
  "job": "send_medication_reminders",
  "windowMinutes": 30,
  "dryRun": true,
  "includeReminders": false
}
```

### 보호자 및 리포트

| Function | Auth | 설명 |
|---|---:|---|
| `caregiver-invite` | JWT | 보호자 초대 |
| `caregiver-respond` | JWT | 보호자 초대 수락/거절 |
| `caregiver-status` | JWT | 보호자 연결 상태 조회 |
| `medication-report` | JWT | 기간별 복약 리포트 조회 |

보호자 접근은 승인된 relationship과 permission scope에 따라 제한한다.

### 운영/동기화

| Function | Auth | 설명 |
|---|---:|---|
| `sync-drug-master` | JWT + admin | 공공 의약품 마스터 동기화 |
| `sync-dur-interactions` | JWT + admin | 식약처 DUR 병용금기 동기화 |
| `redact-expired-sensitive-data` | JWT + admin | 만료 민감정보 정리 |
| `maintenance-runner` | `x-cron-secret` | Cron wrapper |

`maintenance-runner` 지원 job:

- `sync_drug_master_page`
- `sync_drug_master_item_seq`
- `sync_dur_known_medications`
- `send_medication_reminders`
- `redact_expired_sensitive_data`
- `operation_snapshot`

## 6. RPC 및 서버 함수

주요 RPC:

| RPC | 설명 |
|---|---|
| `find_medication_candidates_bulk` | OCR 후보 대량 매칭 |
| `check_interactions_for_medications` | 약물 상호작용 검사 |
| `due_medication_notifications` | 발송 대상 알림 dry-run 계산 |
| `claim_due_medication_notifications` | 발송 대상 claim 및 delivery row 생성 |
| `get_medication_adherence_report` | 복약 리포트 집계 |

`due_medication_notifications`는 다음 조건을 만족하는 일정만 반환한다.

- token enabled
- user medication active
- schedule active
- schedule notification enabled
- 날짜가 user medication/schedule 기간 안에 있음
- `days_of_week`와 planned date 일치
- window start/end 범위에 포함
- 이미 taken/skipped 로그가 없음
- 이미 sent delivery가 없음

## 7. Supabase Cron

현재 reminder cron:

| Job | Schedule | Mode |
|---|---|---|
| `send-medication-reminders-every-30-min` | `*/30 * * * *` | `dryRun=true` |

운영 SQL은 schema migration이 아니라 snippet으로 관리한다.

- `supabase/snippets/register-fcm-reminder-cron-dry-run.sql`
- `supabase/snippets/register-fcm-reminder-cron-live.sql`

Cron은 `maintenance-runner`를 호출한다. `send-medication-reminders`를 직접 호출하지 않는다.

Cron request header:

```text
Content-Type: application/json
x-cron-secret: <vault maintenance_runner_cron_secret>
```

Vault secret:

```text
maintenance_runner_cron_secret
```

## 8. FCM 현재 상태

서버 설정:

- `FCM_PROJECT_ID=duyuthon-iyakmoji`
- `FCM_SERVICE_ACCOUNT_JSON` 등록됨
- `send-medication-reminders`, `maintenance-runner`는 FCM 전용 service account를 사용하도록 배포됨

최근 수동 테스트 결과:

- 저장된 활성 FCM token 6개에 실제 `테스트` 푸시 발송 시도
- 성공 0개
- 실패 6개
  - `SENDER_ID_MISMATCH`: 3개
  - `UNREGISTERED`: 3개

해석:

- 서버 service account/project 설정은 `duyuthon-iyakmoji`로 맞춰졌다.
- 현재 DB의 기존 token은 현재 Firebase sender/project와 맞지 않거나 이미 폐기된 token이다.
- 프론트에서 service worker/site data를 정리하고 현재 Firebase config로 token을 다시 발급/저장해야 한다.

## 9. 보안 정책

- 모든 사용자 데이터 테이블은 RLS를 전제로 한다.
- Edge Function은 사용자 JWT 또는 service role client로 권한을 명확히 분리한다.
- 관리자성 함수는 `user_profiles.role='admin'` 확인 후 수행한다.
- `maintenance-runner`는 JWT 대신 `CRON_SECRET`으로만 호출한다.
- 처방전 이미지와 OCR 원문은 민감정보로 취급한다.
- 서비스 계정 JSON과 API key는 문서, 로그, 프론트 env, Git에 남기지 않는다.

서비스 계정 키가 노출된 경우:

1. GCP에서 해당 key 삭제
2. 새 key 발급
3. Supabase Secret 갱신
4. 관련 함수 재배포 또는 런타임 secret 반영 확인

## 10. 운영 검증

기본 검증:

```bash
supabase db lint --linked
supabase functions list
supabase secrets list
```

Cron 상태:

```sql
select
  jobid,
  jobname,
  schedule,
  active
from cron.job
order by jobid;
```

Cron 실행 로그:

```sql
select
  d.jobid,
  j.jobname,
  d.status,
  d.return_message,
  d.start_time at time zone 'Asia/Seoul' as start_time_kst,
  d.end_time at time zone 'Asia/Seoul' as end_time_kst
from cron.job_run_details d
left join cron.job j on j.jobid = d.jobid
order by d.start_time desc
limit 20;
```

FCM HTTP 응답:

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

## 11. 배포

DB:

```bash
supabase db push
```

주요 함수:

```bash
supabase functions deploy google-ocr
supabase functions deploy analyze-medication
supabase functions deploy confirm-medication
supabase functions deploy user-medications
supabase functions deploy medication-schedules
supabase functions deploy medication-checklist
supabase functions deploy notification-tokens
supabase functions deploy send-medication-reminders
supabase functions deploy maintenance-runner
supabase functions deploy gemini-chat
supabase functions deploy check-interactions
```

FCM 관련 shared code 변경 시 최소 재배포:

```bash
supabase functions deploy send-medication-reminders
supabase functions deploy maintenance-runner
```

## 12. 프론트 연동 주의사항

- FCM token 저장은 `notification-tokens`만 호출한다.
- 정기 발송은 Supabase Cron이 처리한다.
- 복용약 확정 후 일정은 별도 `medication-schedules` POST로 생성한다.
- `confirm-medication`의 `detectedMedicationId`는 `scan_detected_medications.id`다.
- 새 복용약 등록 직후 `schedules: []`는 정상일 수 있다.
- `notificationEnabled=false`는 알림만 끄는 값이고, usable schedule은 `active=true`여야 한다.
- 제거 API는 `user-medications DELETE`를 사용한다. `confirm-medication`으로 제거하지 않는다.
