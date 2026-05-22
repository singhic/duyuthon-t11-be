# 이약뭐지 백엔드 정상 동작 점검 및 리팩터링 계획

작성일: 2026-05-22

업데이트: 2026-05-22 리팩터링 우선순위 1차 작업 적용 및 원격 테스트 완료

## 1. 현재 정상 동작 확인 결과

### 1.1 원격 Supabase 상태

원격 프로젝트:

```text
hygsrrmoawezonahnljn
```

확인 결과:

```text
supabase db lint --linked: 통과
Edge Functions: 모두 ACTIVE
```

현재 원격 Edge Functions:

```text
google-ocr
analyze-medication
confirm-medication
gemini-chat
check-interactions
sync-drug-master
medication-schedules
medication-logs-check
delete-scan-image
```

### 1.2 API 동작 테스트 결과

이미 확인한 성공 항목:

- 인증 없는 Edge Function 호출은 `401 Unauthorized`로 정상 차단
- Google OAuth 시작 URL은 Google 로그인 화면으로 정상 리다이렉트
- `sync-drug-master` 관리자 호출 성공
- `google-ocr` 서비스 계정 인증 방식으로 호출 성공
- `test_image.jpeg` 기반 OCR 호출 성공
- `analyze-medication` 호출 성공
- `gemini-chat` 호출 성공
- Gemini 안전 프롬프트 테스트 성공
- `medication-schedules` 생성 성공
- `medication-logs-check` 복용 완료 체크 성공
- `check-interactions` 버그 수정 후 호출 성공

최근 OCR 테스트:

```text
file: test_image.jpeg
ocrOk: true
confidence: 0.6132253799999999
ocrTextLength: 15
ocrPreview:
#8888
DRIVE
L
0
```

최근 Gemini 테스트:

```text
model: gemini-2.5-flash
chatOk: true
```

안전 프롬프트 테스트:

```text
탈옥/프롬프트 공개 요청: 거절
복약 외 고민 상담: 거절
위험 복약 질문: caution 및 전문가 상담 유도
AI 답변이 틀릴 수 있다는 disclaimer 포함
```

## 2. 현재 코드의 주요 리스크

현재 백엔드는 MVP 기준으로 동작한다. 다만 프로덕션 안정성과 유지보수성을 위해 아래 리팩터링이 필요하다.

### 2.1 Edge Functions 간 Supabase 접근 방식이 섞여 있음

현재 대부분의 함수는 `@supabase/supabase-js`를 사용한다.

예외:

```text
google-ocr
```

`google-ocr`는 배포 중 `esm.sh` 장애를 피하기 위해 Supabase REST/Storage API를 직접 호출하도록 수정했다.

문제:

- 함수마다 DB 접근 스타일이 다르다.
- 공통 인증/REST helper가 중복될 가능성이 높다.
- 배포 시 `esm.sh`가 흔들리면 supabase-js를 쓰는 다른 함수도 배포 실패할 수 있다.

권장 방향:

- `_shared/supabase.ts`를 둘로 나눈다.
- `supabase-js` 기반 helper와 REST 기반 helper를 분리한다.
- 장기적으로 모든 Edge Function을 REST helper 기반으로 통일하거나, import map/vendor 방식으로 `supabase-js` 의존성을 안정화한다.

우선순위:

```text
높음
```

### 2.2 Google 서비스 계정 access token을 매 OCR 요청마다 새로 발급함

현재 `runGoogleOcr`는 요청마다:

```text
서비스 계정 JSON 파싱
JWT 서명
OAuth token 요청
Vision API 호출
```

문제:

- OCR 요청마다 토큰 발급 네트워크 호출이 추가된다.
- 지연 시간이 늘어난다.
- Google OAuth token endpoint에 불필요한 요청이 쌓인다.

권장 방향:

- module-level token cache 추가
- `access_token`과 `expires_at`을 메모리에 저장
- 만료 5분 전까진 재사용

예상 효과:

- OCR latency 감소
- 외부 요청 수 감소

우선순위:

```text
높음
```

### 2.3 OCR 실패 시 `ocr_jobs`와 `scan_sessions` 상태가 실패로 갱신되지 않을 수 있음

현재 `google-ocr` 흐름:

```text
ocr_jobs 생성(status=processing)
scan_sessions status=ocr_processing
Google OCR 호출
성공 시 status 갱신
```

문제:

- OCR 호출 중 실패하면 `ocr_jobs.status = processing` 상태로 남을 수 있다.
- `scan_sessions.status = ocr_processing` 상태로 멈출 수 있다.
- 운영자가 실패율을 정확히 보기 어렵다.

권장 방향:

- OCR job 생성 이후 구간을 별도 `try/catch`로 감싼다.
- 실패 시:

```text
ocr_jobs.status = failed
ocr_jobs.error_message 저장
scan_sessions.status = failed
scan_sessions.error_message 저장
api_usage_logs.status = failed 저장
```

우선순위:

```text
높음
```

### 2.4 Gemini 실패 시 실패 사용량 로그와 assistant 실패 메시지가 남지 않음

현재 `gemini-chat`는:

```text
사용자 메시지 저장
Gemini 호출
성공 시 assistant 메시지 저장
성공 시 api_usage_logs 저장
```

문제:

- Gemini 실패 시 user message만 남고 assistant 메시지가 없다.
- 실패 사용량 로그가 남지 않는다.
- quota, safety block, model error를 운영 지표로 보기 어렵다.

권장 방향:

- Gemini 호출 실패 시에도 `api_usage_logs.status = failed` 저장
- 필요하면 `chat_messages`에 assistant role로 안전 실패 메시지 저장
- `error_code`, `provider_error` 컬럼 추가 여부 검토

우선순위:

```text
높음
```

### 2.5 `analyze-medication`의 후보 매칭이 N+1 RPC 구조

현재 OCR 후보마다:

```text
find_medication_candidates RPC 호출
```

문제:

- 후보가 최대 30개면 RPC도 최대 30번 발생한다.
- OCR 결과가 길수록 latency가 늘어난다.
- 사용자 체감 속도가 떨어질 수 있다.

권장 방향:

- DB 함수 `find_medication_candidates_bulk(text[])` 추가
- 후보 배열을 한 번에 넘기고 한 번의 RPC로 결과 받기
- 후보별 top match를 DB에서 `distinct on` 또는 window function으로 정리

우선순위:

```text
높음
```

### 2.6 `sync-drug-master`가 항목별 순차 upsert 구조

현재 의약품 동기화는 각 item마다:

```text
medications upsert
medication_ingredients delete
ingredients upsert
medication_ingredients upsert
```

문제:

- `numOfRows`가 커지면 매우 느려진다.
- 중간 실패 시 일부만 반영될 수 있다.
- 삭제 후 삽입 방식이라 실패 타이밍에 성분 관계가 비어 보일 수 있다.

권장 방향:

- 초기 MVP에서는 `numOfRows`를 작게 유지한다.
- 리팩터링 시 batch upsert 사용
- DB transaction 또는 RPC로 원자적 처리
- 동기화 job 테이블 추가 검토

우선순위:

```text
중간
```

### 2.7 `check-interactions`의 상호작용 pair 조회가 커질 수 있음

현재 구조:

```text
현재 복용약 성분 x 새 약 성분 pair 생성
or(and(...), and(...)) 필터 생성
```

문제:

- 성분 수가 많아지면 URL/쿼리가 길어진다.
- pair 정렬은 조회 시에만 수행되며, DB 저장 시 정규화가 강제되어 있지 않다.
- `ingredient_a_id`, `ingredient_b_id`의 순서가 반대로 저장되면 누락될 수 있다.

권장 방향:

- DB insert 시 `ingredient_a_id < ingredient_b_id` 정규화 강제
- `check_interactions_for_medications(current_medication_ids uuid[], new_medication_id uuid)` RPC 추가
- pair 생성과 조회를 DB에서 처리

우선순위:

```text
중간
```

### 2.8 OCR 원본 응답을 그대로 `ocr_jobs.result_json`에 저장

문제:

- Google Vision 응답이 커질 수 있다.
- DB 저장 비용과 조회 비용 증가
- 민감 OCR 정보가 과도하게 보관될 수 있다.

권장 방향:

- 프로덕션에서는 raw 전체 저장 여부를 설정값으로 분리
- 기본 저장값은 요약 정보만 저장
- 디버그 모드에서만 full raw 저장
- OCR 원문 보관 기간 정책 추가

우선순위:

```text
중간
```

### 2.9 이미지 자동 삭제가 함수 성공 흐름에 강제되어 있지 않음

현재 삭제는 프론트가 `delete-scan-image`를 호출해야 한다.

문제:

- 프론트에서 호출을 누락하면 이미지가 남을 수 있다.
- 실패한 OCR 이미지도 남을 수 있다.

권장 방향:

- OCR/분석 완료 후 서버에서 자동 삭제 옵션 추가
- scheduled cleanup function 추가
- 예: `prescription-temp`에서 1시간 이상 지난 object 삭제

우선순위:

```text
높음
```

### 2.10 `confirm-medication` 중복 등록 가능성

현재 같은 `detectedMedicationId`를 여러 번 호출하면 중복 `user_medications`가 생길 수 있다.

권장 방향:

- `user_medications`에 중복 방지 unique index 검토
- 예: active 상태에서 `(user_id, medication_id, source_scan_id)` 중복 방지
- 또는 `confirm-medication`에서 기존 row 확인 후 반환

우선순위:

```text
중간
```

## 3. 권장 리팩터링 순서

### Phase 1. 운영 안정성 우선

목표:

- 실패 상태가 DB에 정확히 남도록 한다.
- 이미지가 남지 않도록 한다.
- 외부 API latency와 장애를 줄인다.

작업:

1. `google.ts`에 Google access token cache 추가
2. `google-ocr` 실패 시 `ocr_jobs`, `scan_sessions`, `api_usage_logs` 실패 기록
3. `gemini-chat` 실패 시 `api_usage_logs` 실패 기록
4. OCR 완료 후 이미지 자동 삭제 옵션 추가
5. scheduled cleanup function 추가

### Phase 2. 성능 개선

목표:

- OCR 분석과 상호작용 검사 latency를 줄인다.

작업:

1. `find_medication_candidates_bulk` RPC 추가
2. `analyze-medication`에서 후보별 RPC 호출 제거
3. `check_interactions_for_medications` RPC 추가
4. `check-interactions`의 긴 OR 필터 제거

### Phase 3. 코드 구조 정리

목표:

- 배포 안정성과 유지보수성을 높인다.

작업:

1. `_shared/rest-supabase.ts` 추가
2. `google-ocr`에만 있는 REST helper를 공통화
3. `supabase-js` 의존성 사용 함수들을 REST helper로 점진 전환하거나 vendor/import map 전략 수립
4. 공통 에러 응답 포맷 정리
5. 함수별 입력 validation helper 추가

### Phase 4. 데이터 운영 개선

목표:

- 의약품 마스터 동기화와 OCR raw 보관 정책을 프로덕션답게 만든다.

작업:

1. 의약품 동기화 job 테이블 추가
2. `sync-drug-master` batch 처리
3. 동기화 실패/성공 로그 저장
4. OCR raw 저장 정책 분리
5. 오래된 OCR 원문/이미지 삭제 정책 자동화

## 4. 지금 당장 수정하지 않아도 되는 것

아래 항목은 현재 MVP 테스트에 직접 장애를 만들지 않는다.

- 보호자 기능 세부 API
- 광고/로컬 광고 기능
- FCM/APNs 푸시 알림
- 약품 상호작용 DB 고도화
- 의약품 전체 마스터 대량 동기화 자동화

단, 실제 사용자 테스트 전에 이미지 자동 삭제와 실패 로그는 먼저 처리하는 편이 좋다.

## 5. 최종 판단

현재 코드는 MVP API 테스트 기준으로 정상 동작한다.

하지만 프로덕션 안정성 기준으로는 다음 5개가 가장 먼저 필요하다.

```text
1. Google access token cache
2. OCR/Gemini 실패 로그 저장
3. OCR 이미지 자동 삭제/cleanup
4. analyze-medication bulk matching
5. Supabase REST helper 공통화 또는 supabase-js vendor 전략
```

## 6. 2026-05-22 적용 완료된 리팩터링

### 6.1 Google access token cache

적용 파일:

```text
supabase/functions/_shared/google.ts
```

변경:

- `GOOGLE_SERVICE_ACCOUNT_JSON` 기반 access token을 module-level cache로 저장
- 만료 5분 전까지 재사용
- OCR 요청마다 Google OAuth token endpoint를 호출하지 않도록 개선

### 6.2 OCR 성공/실패 상태 정리

적용 파일:

```text
supabase/functions/google-ocr/index.ts
```

변경:

- OCR 성공 시 `prescription-temp` 원본 이미지 자동 삭제
- 삭제 성공 시 `scan_sessions.image_path = null`
- 삭제 성공 시 `scan_sessions.image_deleted_at` 기록
- OCR 실패 시 `ocr_jobs.status = failed`
- OCR 실패 시 `scan_sessions.status = failed`
- OCR 실패 시 `api_usage_logs.status = failed` 기록 시도
- 정리 작업 실패가 원래 오류를 덮지 않도록 best-effort 처리

### 6.3 Gemini 실패 로그 저장

적용 파일:

```text
supabase/functions/gemini-chat/index.ts
```

변경:

- Gemini 호출 실패 시 `api_usage_logs.status = failed` 기록
- Gemini 호출 실패 시 assistant 실패 메시지 저장 시도
- 실패 메시지에는 AI 답변이 틀릴 수 있고 전문가 확인이 필요하다는 안내 포함

### 6.4 약품 후보 bulk matching

적용 파일:

```text
supabase/migrations/20260522024500_bulk_medication_matching.sql
supabase/functions/analyze-medication/index.ts
```

변경:

- `find_medication_candidates_bulk(search_texts text[], max_results integer)` RPC 추가
- OCR 후보별 개별 RPC 호출 제거
- 후보 배열을 한 번에 DB로 보내 top match를 받도록 개선

## 7. 2026-05-22 리팩터링 후 원격 배포/테스트 결과

원격 DB:

```text
supabase db push: 성공
supabase db lint --linked: 성공, No schema errors found
```

참고:

```text
supabase migration list
```

위 명령은 한 번 `SUPABASE_DB_PASSWORD` 인증 오류가 발생했다. 그러나 `db push`와 `db lint --linked`는 같은 원격 프로젝트에 대해 성공했으므로, 실제 마이그레이션 적용과 스키마 검증은 완료된 상태다.

원격 Functions:

```text
google-ocr: ACTIVE, version 10
gemini-chat: ACTIVE, version 11
analyze-medication: ACTIVE, version 8
```

재테스트 결과:

```text
OCR: 성공
OCR imageDeleted: true
scan_sessions.image_path null 처리: 성공
scan_sessions.image_deleted_at 기록: 성공
analyze-medication bulk RPC 경로: 성공
Gemini 일반 질문: 성공
Gemini 탈옥 거절: 성공
복약 일정 생성: 성공
복약 로그 taken 저장: 성공
상호작용 검사: 성공
sync-drug-master 관리자 호출: 성공
```

OCR 테스트 세부:

```text
ocrConfidence: 0.6132253799999999
ocrTextLength: 15
analyzeCandidateCount: 1
detectedMedicationCount: 1
```

Gemini 테스트 세부:

```text
normalSafety: info
normalDisclaimerHasAiWarning: true
jailbreakRefused: true
```

복약 워크플로우 테스트 세부:

```text
scheduleCreated: true
logStatus: taken
interactionSeverity: unknown
```

관리자 동기화 테스트 세부:

```text
syncOk: true
medicationCount: 1
ingredientCount: 1
```

## 8. 남은 리팩터링 권장 항목

아래 항목은 이번 우선순위 작업에서는 제외했다.

```text
1. Supabase REST helper 공통화
2. supabase-js esm.sh 의존성 vendor/import map 안정화
3. check-interactions DB RPC화
4. sync-drug-master batch transaction 구조
5. 오래된 이미지 정리 scheduled function
6. OCR raw 저장 정책 분리
7. confirm-medication 중복 등록 방지
```
