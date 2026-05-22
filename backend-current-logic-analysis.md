# 이약뭐지 현재 백엔드 구현 로직 분석

작성일: 2026-05-22

기준 프로젝트:

```text
Supabase project ref: hygsrrmoawezonahnljn
Supabase URL: https://hygsrrmoawezonahnljn.supabase.co
```

## 1. 문서 범위

이 문서는 현재 Supabase DB와 Edge Functions에 구현되어 있고, 원격 배포까지 완료된 백엔드 기능을 코드 기준으로 분석한 문서다.

이번 문서에서 실제 단말 검증을 제외하는 항목:

```text
FCM 실제 단말 수신 확인
```

FCM은 앱 배포 이후 실제 registration token, Firebase 권한, 운영 스케줄러가 준비된 뒤 단말 수신까지 검증 가능하다. 현재 백엔드는 발송 대상 claim, FCM HTTP v1 호출, 발송 이력 기록, 실패 토큰 비활성화 구조까지 포함한다.

## 1.1 introduce.md 기준 방향 보정 결과

`introduce.md`의 Must 흐름은 “사진 한 장으로 약 정보를 바로 파악하고, 챗봇은 근거 있는 복약 질문에 답하는 것”이다. 이 기준에서 벗어나던 부분 3가지를 다음처럼 보정했다.

```text
1. 상호작용 응답에서 safe 표현 제거
   - "안전함"으로 오해될 수 있는 상태명을 쓰지 않는다.
   - 현재 DB 기준 경고 없음은 no_registered_warning으로 반환한다.

2. 사진 한 장 UX 보강
   - analyze-medication 응답에 resultMode, autoDisplayReady, recommendedAction을 추가했다.
   - 프론트는 ready이면 약품 정보 화면을 바로 표시하고, review_required/no_candidates이면 확인 또는 재촬영을 안내할 수 있다.

3. 약품 후보 잡음 제거
   - test_image_pill.jpg OCR 결과의 ru, D 같은 짧은 영문 조각을 후보에서 제외했다.
   - TYLENOL + ER처럼 인접한 영문 라인은 TYLENOL ER 후보로 결합해 더 구체적인 공식 의약품 DB 항목으로 매칭한다.
   - TYLENOL처럼 단독 브랜드명만 잡힌 경우에는 제품이 여러 개일 수 있어 자동 확정하지 않고 확인 필요 상태로 둔다.
```

`test_image_pill.jpg` 원격 통합 검증 결과:

```text
OCR confidence: 0.89902484
OCR text preview: ru | TYLENOL | ER | D
analyze candidates: TYLENOL ER
resultMode: ready
autoDisplayReady: true
matchQuality: high
matched medication: 타이레놀8시간이알서방정(아세트아미노펜)
source: data.go.kr
Gemini scan-context 질문: "이 약은 밥 먹고 먹어도 돼요?"
Gemini result: safetyLevel=info, needsDoctorOrPharmacist=true, AI 오류 가능성 disclaimer 포함
```

## 2. 전체 구조 요약

현재 백엔드는 다음 흐름을 제공한다.

```text
로그인
→ 이미지 업로드
→ scan_sessions 생성
→ Google OCR
→ OCR 결과 저장 및 이미지 삭제
→ 의약품 후보 분석
→ 사용자가 약 확인
→ 현재 복용약 등록
→ 복약 일정/로그 관리
→ 상호작용 검사
→ Gemini 챗봇 질의
→ 보호자 조회 권한
→ 복약 리포트
```

주요 기술:

```text
Supabase Auth
Supabase Postgres
Supabase Storage
Supabase Edge Functions
Google Vision OCR
Gemini
공공데이터포털 의약품 API
```

## 3. 공통 인증과 보안 구조

### 3.1 사용자 인증

대부분의 Edge Function은 `Authorization: Bearer {access_token}`을 요구한다.

인증 방식은 두 종류다.

```text
1. supabase-js 기반 requireUser
2. REST 기반 requireRestUser
```

`supabase-js` 기반 함수:

```text
analyze-medication
confirm-medication
gemini-chat
check-interactions
sync-drug-master
medication-schedules
medication-logs-check
suggest-medication-schedules
medication-checklist
delete-scan-image
```

REST 기반 함수:

```text
notification-tokens
caregiver-invite
caregiver-respond
caregiver-status
medication-report
send-medication-reminders
redact-expired-sensitive-data
sync-dur-interactions
```

REST 기반 함수는 `SUPABASE_SERVICE_ROLE_KEY`로 DB를 호출하므로 RLS에만 의존하면 안 된다. 그래서 함수 코드 안에서 현재 사용자 ID와 대상 데이터 소유권을 직접 검증해야 한다.

이번 분석 중 `medication-report`에서 이 위험을 발견했고 수정했다.

### 3.2 RLS 정책

주요 민감 테이블은 RLS가 켜져 있다.

```text
user_profiles
scan_sessions
ocr_jobs
scan_detected_medications
user_medications
medication_schedules
medication_logs
chat_sessions
chat_messages
caregiver_links
consents
api_usage_logs
notification_tokens
medication_notification_deliveries
```

마스터 데이터는 읽기 중심으로 열려 있다.

```text
medications
ingredients
medication_ingredients
pharmacies
drug_interactions
```

판단:

- 사용자 건강 데이터는 기본적으로 본인 또는 승인된 보호자만 볼 수 있다.
- 단, service role을 쓰는 Edge Function은 RLS를 우회할 수 있으므로 함수 내부 검증이 핵심이다.
- 현재 발견된 service role 권한 검증 누락은 `medication-report`에서 수정했다.

## 4. DB 핵심 테이블

### 4.1 사용자/권한

```text
user_profiles
caregiver_links
consents
audit_logs
```

역할:

- `user_profiles`: 사용자 표시명, 역할, 접근성 설정
- `caregiver_links`: 환자-보호자 연결, 승인 상태, 권한 범위
- `consents`: 개인정보/민감정보/AI처리/보호자 공유 동의 기록
- `audit_logs`: 운영 감사 로그용 구조

현재 구현 수준:

- 보호자 연결 구조와 API는 있다.
- 세부 동의 화면, 초대 코드, 알림 발송은 프론트/운영 흐름이 필요하다.
- DB freeze 기준으로 `consents`에는 `policy_url`, `content_hash`, `ip`, `user_agent`를 추가했다.
- `audit_logs`에는 `metadata`, `request_id`, `severity`를 추가해 운영 감사 증빙을 남길 수 있게 했다.

### 4.2 약품 마스터

```text
medications
ingredients
medication_ingredients
drug_interactions
pharmacies
```

역할:

- `medications`: 의약품명, 업체명, 효능, 복용법, 주의사항, 보관법 등
- `ingredients`: 성분명
- `medication_ingredients`: 약품과 성분 연결
- `drug_interactions`: 성분 간 상호작용
- `pharmacies`: 약국 정보

현재 구현 수준:

- 공공데이터 동기화로 약품과 성분을 채울 수 있다.
- 약품 상세 필드는 `efficacy`, `dosage`, `precautions`, `storage_method`, `administration_timing`, `information_completeness`까지 확장되어 있다.
- `medication_aliases`는 `alias_type`, `requires_confirmation`, `priority`를 가진다.
- 넓은 브랜드명은 확인 필요, 구체 브랜드명은 자동 표시 가능하도록 DB에서 정책을 관리한다.
- 상호작용 DB는 구조와 샘플만 있다. 실제 운영 전 신뢰 가능한 상호작용 데이터 소스가 필요하다.
- `sync-dur-interactions` 함수로 식품의약품안전처 DUR 병용금기 API를 `drug_interactions`에 반영할 수 있다.
- 현재 원격 호출 검증에서는 공공 API가 `Unexpected errors` 비 JSON 응답을 반환했다. 함수는 이를 명확한 오류로 반환하도록 수정했으며, 운영자가 공공데이터포털 API 활용신청/키 권한을 확인해야 한다.

### 4.3 OCR/스캔

```text
scan_sessions
ocr_jobs
scan_detected_medications
ai_analysis_results
```

역할:

- `scan_sessions`: 사용자의 촬영/스캔 단위
- `ocr_jobs`: OCR 처리 상태와 원본 OCR 응답
- `scan_detected_medications`: OCR 결과에서 추출/매칭된 약품 후보
- `ai_analysis_results`: 향후 AI 분석 결과 저장용

현재 구현 수준:

- OCR 성공/실패 상태가 저장된다.
- OCR 원본 이미지는 처리 후 자동 삭제된다.
- OCR 저신뢰도/빈 텍스트 상태가 `review_status`, `failure_reason`, `recommended_action`으로 남는다.
- DB freeze 기준으로 `scan_sessions.expires_at`, `scan_sessions.ocr_text_deleted_at`, `ocr_jobs.expires_at`, `ocr_jobs.result_deleted_at`을 추가했다.
- 원본 이미지만 삭제하는 것이 아니라 OCR 원문/원본 OCR JSON도 운영 배치로 파기할 수 있는 기준이 생겼다.
- `redact-expired-sensitive-data` 함수로 만료된 OCR 원문, OCR 원본 JSON, 챗봇 메시지를 삭제/마스킹할 수 있다.

### 4.4 복약 관리

```text
user_medications
medication_schedules
medication_logs
notification_tokens
```

역할:

- `user_medications`: 사용자가 현재 복용 중인 약
- `medication_schedules`: 복용 시간/요일/용량
- `medication_logs`: 복용 완료/미복용/건너뜀 기록
- `notification_tokens`: 앱 푸시 토큰 저장
- `medication_notification_deliveries`: 알림 발송 이력과 중복 발송 방지

현재 구현 수준:

- 현재 복용약 등록, 일정 조회/생성/수정/비활성화, 복용 체크, 리포트 집계가 가능하다.
- FCM 실제 단말 수신 확인은 배포 이후 항목이지만, 발송 함수는 claim 기반 중복 방지와 결과 기록까지 구현되어 있다.
- `notification_tokens`는 현재 토큰 저장/조회까지 구현되어 있다.
- 한 사용자가 같은 약품을 active 상태로 중복 등록하지 못하도록 DB unique index를 추가했다.
- `medication_schedules`는 `start_date`, `end_date`, `active`를 가진다.
- `days_of_week`는 DB check constraint로 0~6 값만 허용한다.
- schedule 없는 복약 로그는 `(user_medication_id, planned_date)` 기준으로 하루 1개만 허용한다.
- `suggest-medication-schedules`로 OCR 원문 또는 공공 DB 복용법에서 복약 일정 후보를 만들 수 있다.
- `medication-checklist`로 날짜별 복약 체크리스트와 로그 상태를 조회할 수 있다.

## 5. OCR 로직

대상 함수:

```text
supabase/functions/google-ocr/index.ts
```

입력:

```json
{
  "scanId": "scan uuid"
}
```

처리 흐름:

```text
1. Authorization header 검증
2. Supabase Auth user 조회
3. 일일 OCR 사용량 제한 확인
4. scan_sessions에서 본인 scanId와 image_path 조회
5. ocr_jobs row 생성, status=processing
6. scan_sessions.status=ocr_processing
7. Storage prescription-temp에서 이미지 다운로드
8. 이미지를 base64로 변환
9. Google Vision OCR 호출
10. 원본 이미지 삭제
11. OCR 텍스트에서 약국명/전화번호 후보 추출
12. OCR confidence 기준으로 수동 확인 필요 여부 판단
13. ocr_jobs.status=succeeded 저장
14. scan_sessions에 ocr_text, confidence, review_status, failure_reason 저장
15. api_usage_logs에 성공 기록
16. 프론트에 OCR 결과 반환
```

저신뢰도 판단:

```text
ocrText가 비어 있음 → failureReason=empty_ocr_text
confidence < 0.65 → failureReason=low_ocr_confidence
그 외 → needsManualReview=false
```

실패 처리:

```text
ocr_jobs.status=failed
scan_sessions.status=failed
scan_sessions.review_status=needed
api_usage_logs.status=failed
이미지 삭제 best-effort 수행
```

보안 판단:

- scan 조회 시 `scanId`와 `user_id`를 같이 검증한다.
- Storage 다운로드/삭제는 service role로 수행하지만, 먼저 scan 소유권을 확인하므로 다른 사용자 이미지 접근은 차단된다.
- 원본 이미지는 OCR 후 삭제된다.

제한:

- OCR 품질은 실제 약봉투/처방전 테스트셋으로 더 검증해야 한다.
- 약국명/전화번호 추출은 정규식 기반이라 완벽하지 않다.

## 6. 약품 후보 분석 로직

대상 함수:

```text
supabase/functions/analyze-medication/index.ts
```

입력:

```json
{
  "scanId": "scan uuid"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. scan_sessions에서 본인 scanId와 ocr_text 조회
3. OCR 텍스트 정규화
4. 약품명처럼 보이는 후보 추출
5. find_medication_candidates_bulk RPC로 후보 일괄 매칭
6. 후보별 best match 계산
7. scan_detected_medications 기존 row 삭제
8. 새 후보 row 저장
9. scan_sessions.status=completed, completed_at 저장
10. candidates, detectedMedications, matchQuality 반환
```

후보 추출 기준:

```text
2~80자 라인
정, 캡슐, 시럽, 액, 주, 연고, 크림, 겔, 패취, 산, 과립, 점안액, 흡입제 등 약품형 키워드
최대 30개 후보
```

매칭 품질:

```text
exact: 약품명 또는 EDI 코드가 정확히 일치
high: similarity >= 0.82
medium: similarity >= 0.65
low: match는 있으나 0.65 미만
none: 공식 DB 매칭 없음
```

보안 판단:

- scan 조회 시 `user_id = 현재 사용자` 조건을 걸어 타인 OCR 분석을 차단한다.

제한:

- OCR 텍스트가 길거나 비정형이면 후보 추출 정확도가 떨어질 수 있다.
- 약품 마스터 DB가 충분히 채워져 있어야 매칭 품질이 올라간다.

## 7. 약품 확인/현재 복용약 등록 로직

대상 함수:

```text
supabase/functions/confirm-medication/index.ts
```

입력:

```json
{
  "detectedMedicationId": "detected uuid",
  "startDate": "2026-05-22",
  "endDate": null,
  "customName": "아침 혈압약"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. scan_detected_medications와 연결 scan_sessions 조회
3. detected row가 현재 사용자 scan에 속하는지 검증
4. medication_id가 있는지 확인
5. 동일 user_id + medication_id + source_scan_id + active=true 기존 row 확인
6. 기존 row가 있으면 alreadyExists=true로 반환
7. 없으면 user_medications에 등록
8. scan_detected_medications.needs_confirmation=false
9. userMedication 반환
```

이번 분석 중 수정한 오류:

```text
문제:
같은 detectedMedicationId를 반복 호출하면 현재 복용약이 중복 등록될 수 있었다.

수정:
user_medications_active_scan_unique_idx 추가
함수에서 기존 row 확인 후 반환
DB unique 충돌 발생 시 기존 row 재조회 후 반환
```

원격 검증 결과:

```text
첫 호출 alreadyExists=false
두 번째 호출 alreadyExists=true
두 호출의 userMedication.id 동일
```

## 8. 이미지 삭제 로직

대상 함수:

```text
supabase/functions/delete-scan-image/index.ts
```

입력:

```json
{
  "scanId": "scan uuid"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. scan_sessions에서 본인 scanId 조회
3. image_path가 있으면 Storage에서 삭제
4. scan_sessions.image_path=null
5. scan_sessions.image_deleted_at 저장
6. deleted=true 반환
```

이번 분석 중 수정한 오류:

```text
문제:
이미지 삭제 함수가 scan_sessions.status를 deleted로 바꾸고 있었다.
분석 완료 후 프론트가 이 함수를 호출하면 completed 상태가 deleted로 바뀌는 문제가 생길 수 있었다.

수정:
status는 건드리지 않고 image_path와 image_deleted_at만 수정하도록 변경.
```

원격 검증 결과:

```text
delete-scan-image 호출 후 scan_sessions.status=completed 유지
```

## 9. Gemini 챗봇 로직

대상 함수:

```text
supabase/functions/gemini-chat/index.ts
supabase/functions/_shared/gemini.ts
```

입력:

```json
{
  "question": "이 약 밥 먹고 먹어도 돼요?",
  "scanId": "optional scan uuid",
  "chatSessionId": "optional chat session uuid"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. question 필수 검증
3. 일일 Gemini 사용량 제한 확인
4. chatSessionId가 있으면 본인 세션인지 검증
5. 없으면 새 chat_sessions 생성
6. 사용자 질문을 chat_messages에 저장
7. 현재 복용약 active 목록 조회
8. scanId가 있으면 scan OCR 상태와 감지 약품 조회
9. 안전 정책과 DB 컨텍스트를 Gemini에 전달
10. Gemini JSON 응답 검증
11. assistant 메시지를 chat_messages에 저장
12. api_usage_logs에 token_count 저장
13. answer, safetyLevel, disclaimer 반환
```

프롬프트 안전 정책:

```text
공식 DB/현재 복용약/OCR 컨텍스트 안에서만 답변
탈옥/프롬프트 공개/지침 우회 거절
처방 변경, 복용 중단, 용량 증감 지시 금지
절대 안전 단정 금지
근거 부족 시 모른다고 말하고 의사/약사 확인 유도
AI 답변이 틀릴 수 있다는 문구 포함
```

실패 처리:

```text
Gemini 실패 시 api_usage_logs.status=failed
assistant 실패 메시지 저장 best-effort
사용자에게 error response 반환
```

제한:

- Gemini는 공공 DB 필드가 충분해야 정확한 답변을 한다.
- 상호작용 DB가 빈약하면 “안전함”이 아니라 “자동 확인된 위험 없음” 수준으로만 답해야 한다.

## 10. 의약품 마스터 동기화 로직

대상 함수:

```text
supabase/functions/sync-drug-master/index.ts
```

입력:

```json
{
  "pageNo": 1,
  "numOfRows": 100,
  "itemName": "타이레놀"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. user_profiles.role=admin 검증
3. DATA_GO_KR_SERVICE_KEY 로드
4. 공공데이터포털 의약품 API 호출
5. ITEM_SEQ, ITEM_NAME 기준 약품 upsert
6. 효능, 복용법, 주의사항, 보관법 저장
7. 복용법 텍스트에서 식전/식후/취침 등 administration_timing 추정
8. MAIN_ITEM_INGR에서 성분 파싱
9. ingredients upsert
10. medication_ingredients 재연결
11. api_usage_logs 기록
12. medicationCount, ingredientCount 반환
```

보안 판단:

- admin만 호출 가능하다.
- 일반 사용자가 마스터 DB를 변경할 수 없다.

제한:

- 현재는 항목별 순차 upsert다.
- 대량 동기화는 batch job 또는 DB transaction 구조가 필요하다.
- 공공데이터 API 응답 필드는 실제 응답에 따라 추가 보정이 필요할 수 있다.

## 11. 복약 일정 관리 로직

대상 함수:

```text
supabase/functions/medication-schedules/index.ts
```

입력:

```json
{
  "userMedicationId": "user medication uuid",
  "takeTime": "09:00:00",
  "timingRule": "after_meal",
  "doseAmount": 1,
  "doseUnit": "정",
  "daysOfWeek": [0, 1, 2, 3, 4, 5, 6],
  "notificationEnabled": true
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. userMedicationId와 takeTime 필수 검증
3. user_medications가 현재 사용자 소유인지 확인
4. POST이면 medication_schedules row 생성
5. GET이면 현재 사용자 일정 목록 반환
6. PATCH이면 소유권 확인 후 일정 수정
7. DELETE이면 hard delete 대신 active=false, notification_enabled=false로 비활성화
8. schedule 반환
```

보안 판단:

- 타인의 `userMedicationId`로 일정을 만들 수 없다.

제한:

- 실제 푸시 알림의 단말 수신 여부는 앱 배포 후 FCM registration token으로 검증해야 한다.

## 12. 복용 체크 로직

대상 함수:

```text
supabase/functions/medication-logs-check/index.ts
```

입력:

```json
{
  "userMedicationId": "user medication uuid",
  "scheduleId": "optional schedule uuid",
  "plannedDate": "2026-05-22",
  "plannedTime": "09:00:00",
  "status": "taken"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. userMedicationId와 plannedDate 필수 검증
3. user_medications가 현재 사용자 소유인지 확인
4. scheduleId가 있으면 해당 schedule이 userMedicationId에 속하는지 확인
5. scheduleId가 없으면 같은 userMedicationId + plannedDate + schedule_id=null 기존 로그 확인
6. 기존 로그가 있으면 update
7. 없으면 upsert/insert
8. log 반환
```

이번 분석 중 수정한 오류:

```text
문제 1:
scheduleId가 다른 약의 schedule이어도 로그에 연결될 수 있었다.

수정 1:
scheduleId가 들어오면 medication_schedules.user_medication_id가 요청의 userMedicationId와 같은지 검증.

문제 2:
Postgres unique constraint는 null을 중복으로 본다.
따라서 scheduleId 없이 같은 날짜를 여러 번 체크하면 중복 로그가 생길 수 있었다.

수정 2:
scheduleId가 없을 때는 기존 null schedule log를 먼저 조회하고 update.
```

원격 검증 결과:

```text
scheduleId 없는 같은 날짜 로그 2회 호출 후 row 수=1
최종 status=skipped로 업데이트 확인
```

## 13. 상호작용 검사 로직

대상 함수:

```text
supabase/functions/check-interactions/index.ts
```

입력:

```json
{
  "medicationId": "new medication uuid"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. 현재 사용자의 active user_medications 조회
3. 현재 복용약이 없으면 no_registered_warning + comparedMedicationCount=0 반환
4. 현재 복용약들의 성분 조회
5. 새 medicationId의 성분 조회
6. 성분 pair가 없으면 unknown 반환
7. check_interactions_for_medications RPC 호출
8. drug_interactions 결과를 severity rank로 정리
9. overallSeverity 계산
10. interactions와 message 반환
```

severity 의미:

```text
danger: contraindicated 또는 major 상호작용 존재
no_registered_warning: 현재 DB 기준 등록된 상호작용 경고 없음 또는 비교 대상 복용약 없음
caution: moderate/minor/unknown 상호작용 후보 존재
unknown: 성분 정보 부족으로 비교 불가
```

중요한 판단:

```text
isConfirmedSafe는 현재 항상 false
```

이유:

- 자동 검사 결과만으로 안전을 단정할 수 없기 때문이다.
- 상호작용 DB가 완전하지 않으면 “등록된 위험 없음”과 “안전함”은 다르다.
- 현재 복용약이 0개인 사용자는 `comparedMedicationCount = 0`으로 반환해 “성분 정보 부족”과 구분한다.

제한:

- 실제 운영 전에는 신뢰 가능한 상호작용 데이터셋이 필요하다.
- 현재 샘플 데이터는 MVP 검증용이다.

## 14. 알림 토큰 저장 로직

대상 함수:

```text
supabase/functions/notification-tokens/index.ts
```

입력:

```json
{
  "token": "fcm registration token",
  "provider": "fcm",
  "deviceId": "device id",
  "platform": "android",
  "timezone": "Asia/Seoul",
  "enabled": true
}
```

처리 흐름:

```text
GET:
1. 로그인 사용자 확인
2. notification_tokens에서 현재 사용자 token 목록 조회
3. token 배열 반환

POST:
1. 로그인 사용자 확인
2. token 필수 검증
3. provider+token 기준 upsert
4. user_id는 항상 현재 사용자로 저장
5. 저장된 token metadata 반환
```

보안 판단:

- service role로 DB를 호출하지만, user_id는 요청 body가 아니라 인증된 사용자 ID로 강제한다.
- GET도 현재 user_id 필터를 직접 적용한다.

현재 범위:

- 토큰 저장/조회, 알림 대상 조회, claim 기반 중복 방지, FCM HTTP v1 발송 결과 기록까지 구현되어 있다.
- 실제 단말 수신 확인은 배포 이후 검증 항목이다.

## 15. 보호자 연동 로직

대상 함수:

```text
supabase/functions/caregiver-invite/index.ts
supabase/functions/caregiver-respond/index.ts
supabase/functions/caregiver-status/index.ts
```

### 15.1 보호자 초대/요청

입력:

```json
{
  "patientUserId": "patient uuid",
  "caregiverUserId": "caregiver uuid",
  "permissionScope": {
    "medication_status": true,
    "scan_results": false,
    "reports": true
  }
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. patientUserId 기본값은 현재 사용자
3. caregiverUserId 기본값은 현재 사용자
4. patientUserId와 caregiverUserId가 같으면 거부
5. 현재 사용자가 patient 또는 caregiver 둘 중 하나가 아니면 거부
6. caregiver_links upsert
7. status=invited
8. invited_by_user_id=현재 사용자
9. caregiverLink 반환
```

### 15.2 보호자 승인/철회

입력:

```json
{
  "caregiverLinkId": "link uuid",
  "action": "accepted"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. caregiver_links row 조회
3. 현재 사용자가 patient 또는 caregiver인지 확인
4. caregiver가 요청한 링크는 patient만 승인 가능
5. patient가 초대한 링크는 caregiver가 수락 가능
6. accepted이면 consented_at 저장
7. revoked이면 revoked_at 저장
8. caregiverLink 반환
```

### 15.3 보호자 상태 조회

처리 흐름:

```text
1. 로그인 사용자 확인
2. caregiver_links에서 현재 사용자가 patient 또는 caregiver인 링크 조회
3. caregiverLinks, asPatient, asCaregiver로 나눠 반환
```

보안 판단:

- service role로 DB를 호출하지만 함수 안에서 참여자 여부를 직접 확인한다.
- 승인 전에는 `can_view_patient_data` 정책상 환자 복약 데이터 조회가 허용되지 않는다.

제한:

- 초대 코드/전화번호 기반 초대는 없다.
- 보호자 쓰기 권한은 없다.
- 보호자 미복용 알림은 아직 없다.

## 16. 복약 리포트 로직

대상 함수:

```text
supabase/functions/medication-report/index.ts
```

입력:

```json
{
  "patientUserId": "optional patient uuid",
  "startDate": "2026-05-01",
  "endDate": "2026-05-22"
}
```

처리 흐름:

```text
1. 로그인 사용자 확인
2. startDate, endDate 필수 검증
3. 날짜 형식 YYYY-MM-DD 검증
4. endDate >= startDate 검증
5. 최대 조회 범위 120일 제한
6. patientUserId 기본값은 현재 사용자
7. 본인/관리자/승인된 보호자인지 함수 내부에서 명시 검증
8. medication_logs와 user_medications를 조인해 대상 환자 로그 조회
9. 날짜별 planned/taken/missed/skipped 집계
10. adherence_rate 계산
11. summary 문장 생성
12. daily, summary 반환
```

이번 분석 중 수정한 오류:

```text
문제:
REST 기반 함수가 service role로 RPC를 호출하면서 DB 내부 auth.uid() 권한 검증에 사용자 JWT가 전달되지 않았다.
이 구조는 권한 판단이 불명확해질 수 있다.

수정:
medication-report 함수 내부에서 현재 사용자와 patientUserId 관계를 직접 검증하도록 변경.
승인된 보호자 권한은 caregiver_links.status=accepted, revoked_at=null, permission_scope.reports=true로 확인.
리포트 집계도 함수 내부에서 직접 수행.
```

원격 검증 결과:

```text
본인 리포트 조회 성공
권한 없는 다른 사용자 리포트 조회 403 차단
```

## 17. DB RPC/함수

현재 사용 중인 주요 DB 함수:

```text
find_medication_candidates(search_text, max_results)
find_medication_candidates_bulk(search_texts, max_results)
check_interactions_for_medications(current_medication_ids, new_medication_id)
due_medication_notifications(...)
get_medication_adherence_report(...)
```

현재 실제 API에서 쓰는 함수:

```text
find_medication_candidates_bulk → analyze-medication
check_interactions_for_medications → check-interactions
due_medication_notifications → send-medication-reminders dryRun 대상 조회
claim_due_medication_notifications → send-medication-reminders 실제 발송 전 대상 claim
```

주의:

- `get_medication_adherence_report`는 DB에 남아 있지만, 현재 `medication-report` Edge Function은 권한 명확성을 위해 자체 집계를 사용한다.
- service role 기반 Edge Function에서 `auth.uid()`에 의존하는 DB 함수를 호출하면 권한 검증이 흐려질 수 있다.

## 18. 이번 분석 중 발견 및 수정한 문제

### 18.1 리포트 권한 검증 문제

문제:

```text
medication-report가 service role로 RPC를 호출하면서 사용자 JWT 기반 auth.uid() 검증에 의존하고 있었다.
```

수정:

```text
Edge Function 내부에서 본인/관리자/승인된 보호자 여부를 직접 검증.
RPC 의존 제거.
```

검증:

```text
권한 없는 다른 사용자 요청 → 403
본인 요청 → 정상
```

### 18.2 현재 복용약 중복 등록 문제

문제:

```text
confirm-medication 반복 호출 시 같은 scan 기반 약품이 중복 등록될 수 있었다.
```

수정:

```text
user_medications_active_scan_unique_idx 추가
함수에서 기존 row 확인
unique 충돌 시 기존 row 반환
```

검증:

```text
첫 호출 alreadyExists=false
두 번째 호출 alreadyExists=true
두 호출 userMedication.id 동일
```

### 18.3 복용 로그 중복/잘못된 schedule 연결 문제

문제:

```text
schedule_id가 null이면 PostgreSQL unique 제약이 중복을 막지 못할 수 있었다.
요청 scheduleId가 userMedicationId에 속하는지도 검증하지 않았다.
```

수정:

```text
scheduleId가 있으면 medication_schedules.user_medication_id 검증.
scheduleId가 없으면 기존 null schedule 로그를 먼저 조회하고 update.
```

검증:

```text
같은 날짜 scheduleId 없는 로그 2회 호출 → row 1개 유지
최종 status 업데이트 확인
```

### 18.4 이미지 삭제가 scan 상태를 훼손하는 문제

문제:

```text
delete-scan-image가 scan_sessions.status를 deleted로 변경했다.
분석 완료 scan에 호출하면 completed 상태가 사라질 수 있었다.
```

수정:

```text
image_path=null, image_deleted_at만 갱신.
status는 보존.
```

검증:

```text
completed scan에서 delete-scan-image 호출 후 status=completed 유지
```

## 19. 원격 배포 및 검증 결과

적용한 마이그레이션:

```text
20260522052000_idempotency_and_report_security.sql
```

재배포한 함수:

```text
confirm-medication
medication-logs-check
delete-scan-image
medication-report
```

검증 결과:

```text
supabase db push: 성공
supabase db lint --linked: 성공, No schema errors found
confirm-medication 재배포 성공
medication-logs-check 재배포 성공
delete-scan-image 재배포 성공
medication-report 재배포 성공
```

원격 smoke test 결과:

```json
{
  "confirmFirstAlreadyExists": false,
  "confirmSecondAlreadyExists": true,
  "sameUserMedicationId": true,
  "nullScheduleLogCount": 1,
  "nullScheduleFinalStatus": "skipped",
  "ownReportPlannedCount": 1,
  "unauthorizedReportResult": 403,
  "deleteScanImagePreservedStatus": "completed"
}
```

## 20. 현재 기준으로 남은 위험/부족한 점

### 20.1 OCR 품질

현재 Google OCR 호출과 상태 저장은 정상이다.

하지만 실제 약봉투/처방전 이미지 테스트셋이 부족하다. `test_image.jpeg`는 약 이미지가 아니므로 품질 검증에는 적합하지 않다.

필요 작업:

```text
실제 약봉투/처방전 20~50장 테스트셋 구축
저조도/흐림/기울어짐/작은 글씨 케이스 포함
OCR confidence와 실제 매칭 성공률 기록
```

### 20.2 의약품 마스터 DB 품질

구조는 준비되어 있지만 데이터 품질은 동기화량과 공공 API 필드 품질에 의존한다.

필요 작업:

```text
주요 상비약/만성질환 약 우선 동기화
효능/복용법/주의사항 필드 실측 검증
공공 API 누락 필드 보완 전략 수립
```

### 20.3 상호작용 DB

상호작용 검사 로직은 있으나 실제 상호작용 데이터가 부족하다.

필요 작업:

```text
신뢰 가능한 상호작용 데이터 소스 확보
성분명 정규화 강화
위험도 기준 검수
약사/전문가 리뷰
```

### 20.4 보호자 기능 UX

백엔드 연결/승인 구조는 있다.

부족한 점:

```text
초대 코드 또는 링크 기반 초대 없음
보호자 알림 없음
보호자 권한 변경 API 없음
동의 문구/정책 UI 필요
```

### 20.5 FCM 실제 단말 수신 확인

백엔드 발송 구조는 구현되어 있다. 실제 앱 단말에서 푸시가 수신되는지는 배포 이후 검증한다.

배포 이후 필요한 것:

```text
앱에서 실제 FCM registration token 발급
notification_tokens 저장
Firebase 권한 확인
scheduled job 구성
dryRun=false 실제 발송 검증
실패 토큰 비활성화 자동화 확인
```

### 20.6 운영 자동화

필요 작업:

```text
오래된 scan/ocr raw 정리 정책
오래된 이미지 정리 scheduled cleanup
공공데이터 동기화 batch job
실패율/사용량 모니터링
관리자 대시보드
```

## 21. 현재 판단

현재 백엔드는 MVP 사용자 테스트를 시작할 수 있는 수준까지 올라와 있다.

바로 가능한 기능:

```text
Google OAuth 로그인 연동
이미지 업로드
Google OCR
OCR 결과 저장 및 원본 이미지 삭제
약품 후보 매칭
사용자 확인 후 현재 복용약 등록
복약 일정 생성
복용 체크
상호작용 자동 검사
Gemini 챗봇
보호자 연결/승인/상태 조회
복약 리포트 조회
알림 토큰 저장
```

아직 운영 전 반드시 보강해야 하는 기능:

```text
실제 약봉투/처방전 OCR 품질 검증
의약품 마스터 데이터 충분한 적재
상호작용 DB 실데이터 확보
FCM 실제 단말 수신 검증
보호자 동의 UX와 정책 문구
의료/개인정보 법률 검토
```

최종 결론:

```text
현재 구현은 백엔드 MVP로는 동작한다.
다만 의료 안전 서비스로 프로덕션 공개 전에는 OCR 품질, 약품 DB, 상호작용 DB, 법적 고지, FCM 운영/단말 수신 검증이 반드시 필요하다.
```
