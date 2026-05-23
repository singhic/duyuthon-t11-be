# 이약뭐지 운영자 프로덕션 준비 체크리스트

이 문서는 개발자가 아닌 운영자가 프로덕션 배포 전 직접 확인하거나 처리해야 하는 작업을 정리한 문서다. 특히 API 키, 개인정보, Google Cloud 비용, Supabase 보안 설정은 운영자가 책임지고 확인해야 한다.

## 1. 즉시 처리해야 할 보안 작업

### 1.1 `important.md`의 공공데이터포털 키 폐기

현재 저장소의 `important.md`에는 공공데이터포털 키가 평문으로 저장되어 있다. 이 키는 이미 노출된 것으로 간주해야 한다.

운영자가 해야 할 일:

- 공공데이터포털에서 기존 키 폐기 또는 재발급
- 새 키를 저장소 파일에 다시 쓰지 않기
- 새 키는 Supabase Secret 또는 서버 환경변수에만 저장
- `.env` 파일을 사용할 경우 `.gitignore`에 포함
- GitHub 같은 원격 저장소에 이미 올라갔다면 키를 반드시 폐기

권장:

```text
DATA_GO_KR_SERVICE_KEY=새로_발급한_키
```

이 값은 코드 저장소가 아니라 배포 환경의 Secret으로 관리해야 한다.

### 1.2 Google Gemini API 키 노출 금지

Gemini API 키는 프론트엔드, 모바일 앱, 공개 저장소에 들어가면 안 된다.

운영자가 해야 할 일:

- Gemini API 키를 Supabase Secret 또는 서버 환경변수에 저장
- 클라이언트 코드에서 Gemini API를 직접 호출하지 않도록 확인
- Google Cloud Console에서 API 키 제한 설정
- 가능하면 키 대신 서비스 계정/IAM 기반 구조 검토
- 예산 알림 설정
- 일일 사용량 제한 설정

### 1.3 Google OCR 키 노출 금지

Google Cloud Vision OCR도 서버에서만 호출해야 한다.

운영자가 해야 할 일:

- Google Vision API 사용 설정
- OCR 호출용 서비스 계정 생성
- Vision API에 필요한 최소 권한만 부여
- 서비스 계정 키 파일을 저장소에 넣지 않기
- Supabase Edge Function에서 사용할 경우 Secret으로 저장
- Google Cloud 예산 알림과 쿼터 설정

## 2. Google Cloud 운영 설정

### 2.1 프로젝트 분리

개발/테스트/운영 환경을 하나의 Google Cloud 프로젝트에서 섞지 않는 것이 좋다.

권장 구조:

```text
iykmj-dev
iykmj-prod
```

운영자가 해야 할 일:

- 개발용 Google Cloud 프로젝트 생성
- 운영용 Google Cloud 프로젝트 생성
- 각 프로젝트마다 별도 API 키 또는 서비스 계정 사용
- 운영 키를 개발자 로컬 환경에 공유하지 않기

### 2.2 예산 알림 설정

Gemini와 OCR은 호출량이 늘면 비용이 빠르게 증가할 수 있다.

운영자가 해야 할 일:

- Google Cloud Billing에서 월 예산 설정
- 50%, 80%, 100% 사용 시 알림 설정
- 비정상 사용량이 발생했을 때 연락받을 이메일 등록
- Gemini와 Vision API 각각의 사용량 대시보드 확인

권장 초기 예산:

```text
개발 환경: 낮은 금액
운영 초기: 예상 사용자 수 기준으로 제한
해커톤/시연 환경: 반드시 낮은 쿼터 설정
```

### 2.3 API 쿼터 제한

운영자가 해야 할 일:

- Gemini API 일일 요청 제한 설정
- Vision API 일일 요청 제한 설정
- 분당 요청 제한 설정
- 예상 트래픽보다 약간 높은 수준으로만 허용
- 갑작스러운 비용 증가 방지를 위해 과도하게 높게 잡지 않기

### 2.4 키 회전 정책

운영자가 해야 할 일:

- API 키 회전 주기 정하기
- 담당자 변경 시 키 재발급
- 키 유출 의심 시 즉시 폐기
- 폐기/재발급 절차 문서화

권장:

```text
정기 회전: 3개월 또는 6개월
유출 의심: 즉시 폐기
담당자 변경: 즉시 재발급
```

## 3. Supabase 운영 설정

### 3.1 프로젝트 환경 분리

Supabase도 개발/운영을 분리한다.

권장 구조:

```text
iykmj-dev
iykmj-prod
```

운영자가 해야 할 일:

- 개발용 Supabase 프로젝트 생성
- 운영용 Supabase 프로젝트 생성
- 운영 DB에 테스트 데이터를 섞지 않기
- 운영 service role key를 개발자에게 무분별하게 공유하지 않기

### 3.2 RLS 확인

운영 배포 전 모든 민감 테이블의 RLS가 켜져 있어야 한다.

반드시 확인할 테이블:

- `user_profiles`
- `scan_sessions`
- `ocr_jobs`
- `scan_detected_medications`
- `user_medications`
- `medication_schedules`
- `medication_logs`
- `chat_sessions`
- `chat_messages`
- `consents`
- `caregiver_links`
- `api_usage_logs`
- `audit_logs`

운영자가 확인할 것:

- 로그인하지 않은 사용자가 민감 데이터를 읽을 수 없는가
- A 사용자가 B 사용자의 복약 정보를 읽을 수 없는가
- 보호자는 동의된 환자 데이터만 읽을 수 있는가
- service role key가 클라이언트에 노출되지 않았는가

### 3.3 Storage 설정

처방전과 약봉투 이미지는 민감정보다.

운영자가 해야 할 일:

- `prescription-temp` 버킷을 private으로 생성
- 공개 URL 사용 금지
- signed upload URL 사용
- 사용자별 경로 분리
- OCR 완료 후 이미지 삭제 정책 확인
- 실패한 OCR 이미지도 일정 시간 후 삭제되도록 설정

권장 경로:

```text
{user_id}/{scan_id}/original.jpg
```

주의:

- 이미지 원본을 장기 보관하는 정책은 법무/개인정보 검토 전까지 피한다.
- 시연용 이미지도 실제 처방전이면 민감정보로 취급한다.

### 3.4 Secret 관리

Supabase에 저장해야 할 Secret 예시:

```text
GOOGLE_CLOUD_PROJECT_ID
GOOGLE_VISION_API_KEY 또는 GOOGLE_SERVICE_ACCOUNT_JSON
GEMINI_API_KEY
DATA_GO_KR_SERVICE_KEY
SUPABASE_SERVICE_ROLE_KEY
CRON_SECRET
```

운영자가 해야 할 일:

- Secret 값을 저장소에 커밋하지 않기
- 운영 Secret은 최소 인원만 접근 가능하게 관리
- 담당자 퇴사/변경 시 Secret 회전
- `CRON_SECRET`은 `maintenance-runner` scheduled job 호출용으로만 사용

## 4. 개인정보 및 법적 검토

이 서비스는 건강 정보와 처방 관련 정보를 다룬다. 일반 앱보다 개인정보 리스크가 높다.

운영자가 검토해야 할 문서:

- 개인정보 처리방침
- 민감정보 처리 동의
- AI 분석을 위한 외부 전송 동의
- 보호자 공유 동의
- 마케팅/광고 수신 동의
- 서비스 이용약관
- 의료 면책 고지

### 4.1 개인정보 처리방침에 포함할 내용

포함해야 할 항목:

- 어떤 정보를 수집하는가
- 처방전/약봉투 이미지 수집 여부
- OCR 원문 저장 여부
- 복약 이력 저장 여부
- Google OCR/Gemini 등 외부 API 사용 여부
- 데이터 보관 기간
- 이미지 삭제 정책
- 사용자의 삭제 요청 방법
- 보호자 공유 기능이 있다면 공유 범위와 철회 방법

### 4.2 민감정보 동의

복약 정보와 처방 관련 정보는 민감한 건강 정보로 취급해야 한다.

운영자가 해야 할 일:

- 회원가입 또는 첫 분석 전 별도 동의 받기
- 일반 개인정보 동의와 분리해서 받기
- 동의 버전과 시각 저장
- 철회 기능 제공

### 4.3 외부 AI 처리 동의

Google OCR과 Gemini로 데이터를 보내는 구조이므로 사용자에게 알려야 한다.

운영자가 해야 할 일:

- 어떤 데이터가 Google API로 전송되는지 명시
- 전송 목적 명시
- 보관 여부 명시
- 동의하지 않으면 기능 사용이 제한될 수 있음을 안내

### 4.4 의료 면책 문구

앱의 모든 주요 결과 화면에 다음 취지의 문구가 필요하다.

예시:

```text
이 정보는 참고용이며, 정확한 복약 방법과 약물 상호작용은 의사 또는 약사에게 확인하세요.
복용 중단, 용량 변경, 대체 복용은 전문가 상담 없이 결정하지 마세요.
```

운영자가 해야 할 일:

- OCR 결과 화면에 표시
- 챗봇 답변에 포함
- 상호작용 경고 화면에 표시
- 긴급하거나 위험한 답변에는 더 강한 상담 안내 표시

## 5. 의약품 데이터 운영

### 5.1 공공데이터포털 API 관리

운영자가 해야 할 일:

- 현재 사용 승인 기간 확인
- 호출 제한 확인
- API 응답 필드 변경 여부 주기적 확인
- API 장애 시 fallback 정책 준비

현재 문서 기준으로 사용하는 API:

- 의약품 제품 허가 목록
- 의약품 제품 허가 상세정보
- 의약품 제품 주성분 상세정보

### 5.2 데이터 갱신 주기

권장:

```text
개발/시연: 필요할 때 수동 동기화
운영 초기: 하루 1회 또는 주 1회
안정화 후: 변경분 기준 동기화
```

운영자가 해야 할 일:

- 데이터 갱신 담당자 지정
- 동기화 실패 알림 설정
- 마지막 갱신 시각 확인 대시보드 준비

### 5.3 공식 출처 관리

의약품 정보는 출처가 중요하다.

운영자가 해야 할 일:

- 약품 정보 출처를 화면 또는 상세 페이지에 표시할지 결정
- 데이터 출처별 이용 조건 확인
- 상업 서비스 사용 가능 여부 확인
- 출처 표기 의무 확인

## 6. AI 안전 운영

### 6.1 Gemini 프롬프트 정책

운영자가 승인해야 할 정책:

- Gemini는 공식 DB에 없는 내용을 단정하지 않는다.
- 사용자가 복용 중단, 용량 변경, 대체 복용을 물으면 의사/약사 상담을 안내한다.
- 임산부, 영유아, 고령자, 중증질환자는 더 보수적으로 답변한다.
- 응급 증상은 즉시 의료기관 상담을 안내한다.
- 답변은 쉬운 한국어로 작성한다.

### 6.2 위험 질문 대응

고위험 질문 예시:

- "두 배로 먹어도 돼?"
- "약 끊어도 돼?"
- "부작용 같지만 참아도 돼?"
- "술이랑 같이 먹어도 돼?"
- "임신 중인데 먹어도 돼?"
- "아이에게 먹여도 돼?"

운영 정책:

- 단정 답변 금지
- 전문가 상담 안내
- 응급 증상은 즉시 병원/응급실 안내
- 챗봇 답변 로그를 남겨 사후 검토 가능하게 함

### 6.3 답변 품질 검토

운영자가 해야 할 일:

- 약사 또는 의료 전문가에게 샘플 답변 검토 요청
- 위험 질문 테스트셋 만들기
- OCR 오인식 테스트셋 만들기
- Gemini 답변이 면책 문구를 누락하지 않는지 확인

## 7. 보호자 기능 운영 정책

보호자 기능은 개인정보 리스크가 크므로 MVP 이후로 미루는 것을 권장한다.

구현한다면 운영자가 정해야 할 것:

- 보호자가 볼 수 있는 정보 범위
- 보호자가 약 등록/수정까지 가능한지
- 환자가 언제든 연결을 해지할 수 있는지
- 미복용 알림을 보호자에게 보낼 조건
- 보호자 접근 로그를 환자가 볼 수 있는지

권장 초기 권한:

```text
보호자: 복약 완료 여부 조회만 가능
보호자: 처방전 이미지 원본 조회 불가
보호자: 챗봇 대화 원문 조회 불가
보호자: 약 삭제/수정 불가
```

## 8. 광고/수익화 운영 정책

서비스 기획에는 광고 수익 모델이 포함되어 있다. 헬스케어 서비스에서 광고는 신뢰도에 영향을 줄 수 있다.

운영자가 정해야 할 원칙:

- 복약 정보 결과 화면에는 광고를 노출하지 않기
- 광고와 의학 정보를 UI상 명확히 분리
- 특정 약품 추천처럼 보이는 광고 금지
- 사용자의 복용약 정보를 광고 타겟팅에 사용할 경우 별도 동의 필요
- 마케팅 동의 없이 민감 건강정보 기반 광고 금지

권장:

```text
MVP에서는 광고 기능 제외
사용자 신뢰 확보 후 별도 정책과 동의 체계 마련
```

## 9. 운영 모니터링

운영자가 확인해야 할 지표:

- 일일 OCR 호출 수
- 일일 Gemini 호출 수
- OCR 실패율
- 낮은 confidence 비율
- Gemini safety blocked 비율
- 사용자별 과도한 호출 여부
- 이미지 삭제 실패 건수
- 약품 DB 마지막 동기화 시각
- API 비용 추정치
- 오류율

알림이 필요한 상황:

- Google API 비용 급증
- OCR 실패율 급증
- 이미지 삭제 실패
- Supabase RLS 오류
- service role key 노출 의심
- 공공데이터 API 동기화 실패

## 10. 배포 전 최종 확인표

운영자는 프로덕션 배포 전 다음 항목을 모두 확인해야 한다.

### 보안

- `important.md`의 기존 키를 폐기했는가
- 새 공공데이터포털 키를 Secret으로 옮겼는가
- Gemini 키가 클라이언트에 없는가
- Google OCR 키가 클라이언트에 없는가
- Supabase service role key가 클라이언트에 없는가
- 운영 Secret 접근 권한이 제한되어 있는가
- API 키 제한과 쿼터가 설정되어 있는가
- Google Cloud 예산 알림이 설정되어 있는가

### 개인정보

- 개인정보 처리방침이 준비되었는가
- 민감정보 처리 동의를 받는가
- AI 외부 처리 동의를 받는가
- 이미지 삭제 정책이 명시되어 있는가
- 사용자 데이터 삭제 요청 절차가 있는가
- 보호자 공유 동의와 철회 절차가 있는가

### Supabase

- 모든 민감 테이블의 RLS가 켜져 있는가
- A 사용자가 B 사용자 데이터를 읽을 수 없는가
- Storage 버킷이 private인가
- signed URL만 사용하는가
- OCR 완료 후 이미지 삭제가 동작하는가
- audit log가 저장되는가

### AI/OCR

- OCR confidence가 낮으면 자동 확정하지 않는가
- Gemini 응답이 JSON Schema로 검증되는가
- Gemini가 공식 DB 밖 내용을 단정하지 않는가
- 상호작용 판단을 Gemini 단독으로 하지 않는가
- 위험 질문에 전문가 상담 안내가 나오는가
- 면책 문구가 누락되지 않는가

### 운영

- 공공 의약품 DB 동기화 절차가 있는가
- API 사용량 모니터링이 가능한가
- 장애 발생 시 연락받을 사람이 정해져 있는가
- 키 유출 시 폐기/교체 절차가 준비되어 있는가
- 운영/개발 환경이 분리되어 있는가

## 11. 운영자가 개발팀에 요청해야 할 작업

운영자는 개발팀에게 다음 구현을 요청해야 한다.

- Supabase RLS 정책 SQL 작성
- Storage private bucket 정책 작성
- Google OCR Edge Function 구현
- Gemini Chat Edge Function 구현
- Gemini JSON Schema 검증 구현
- 이미지 OCR 완료 후 삭제 구현
- API 사용량 로그 구현
- 사용자별 rate limit 구현
- audit log 구현
- 동의 버전 저장 구현
- 관리자 전용 의약품 DB 동기화 함수 구현
- 위험 질문 테스트셋 작성
- OCR 오인식 테스트셋 작성

## 12. 권장 출시 범위

프로덕션 첫 출시에서는 다음만 포함하는 것이 안전하다.

포함:

- 사진 기반 OCR
- 약품명 후보 표시
- 사용자 확인 후 복용약 등록
- 공식 DB 기반 약품 정보 제공
- Gemini 기반 쉬운 설명
- 챗봇 추가 질문
- 기본 복약 일정/완료 체크

## 13. 추가 운영 고정 항목

### 13.1 민감정보 삭제 운영

처방전/약봉투 이미지뿐 아니라 OCR 원문, OCR 원본 JSON, 챗봇 질문/답변도 민감정보로 취급한다.

운영자가 해야 할 일:

- `redact-expired-sensitive-data`를 `dryRun=true`로 먼저 실행
- 삭제 대상 수가 비정상적으로 많지 않은지 확인
- 문제가 없으면 `dryRun=false`로 실행
- 실행 후 다음 컬럼이 채워졌는지 확인
  - `scan_sessions.ocr_text_deleted_at`
  - `ocr_jobs.result_deleted_at`
  - `chat_messages.redacted_at`
- 운영 자동화는 하루 1회 Supabase Scheduled Function 또는 외부 cron으로 처리

### 13.1.1 복약 알림 발송 운영

운영자가 해야 할 일:

- 앱에서 FCM registration token 저장이 시작된 뒤 `send-medication-reminders`를 scheduled job으로 주기 실행
- 실제 발송 전에는 `dryRun=true`와 `includeReminders=true`로 대상 계산만 확인
- 실제 발송은 `dryRun=false`로 전환
- 같은 `notification_token_id + schedule_id + planned_date + planned_time` 조합은 `medication_notification_deliveries`에 기록되어 중복 발송이 차단되는지 확인
- FCM invalid token 계열 오류가 난 토큰은 `notification_tokens.enabled=false`로 비활성화되는지 확인

### 13.2 약품/상호작용 데이터 운영

운영자가 해야 할 일:

- 약품 마스터 동기화는 `sync-drug-master`로 수행
- OCR 분석 중 내부 DB에 없는 약품 후보는 `analyze-medication`이 공공 의약품 API를 제한적으로 조회해 cache-aside 저장
- 공공 의약품 API 장애가 나도 프론트에는 내부 DB 기준 분석 결과가 반환되므로, `publicLookup.status`를 운영 로그에서 확인
- OCR 약국 정보는 OCR 텍스트 기반으로 `pharmacies`에 저장된다. 공공 약국 DB 검증/지도 연동은 후순위
- DUR 병용금기 동기화는 `sync-dur-interactions`로 수행
- `drug_interactions.source = 'mfds_dur_usjnt_taboo'` 데이터가 주기적으로 늘거나 갱신되는지 확인
- 동기화 실패 시 프론트에는 “상호작용 DB 기준 등록된 경고 없음”과 “안전함”을 혼동하지 않도록 유지
- `sync-dur-interactions`는 최신 명세 기준 `DURPrdlstInfoService03/getUsjntTabooInfoList03`를 사용한다.
- `sync-dur-interactions` 원격 재테스트에서 `apiItemCount=1`, `insertedOrUpdatedCount=1`로 성공했다.
- 운영자는 공공데이터포털에서 `DURPrdlstInfoService03/getUsjntTabooInfoList03` 활용신청, 승인 상태, 서비스키 권한을 확인해야 한다.
- 상호작용 질문은 `gemini-chat`이 먼저 내부 DB 근거를 확인한다. 공식 DB 매칭 약이 2개 미만이거나 성분 정보가 없으면 Gemini 추론을 사용하지 않고 “답할 수 없음/전문가 확인”으로 차단한다.

권장 운영 주기:

- `sync-drug-master`: 초기 적재 후 매일 또는 주 1회 주요 약품 page batch 실행
- `sync-dur-interactions`: `syncKnownMedications=true`로 매일 1회 또는 최소 주 1회 실행
- `sync-dur-interactions`는 `medications.item_seq`가 있는 기존 약품을 batch로 읽고, 각 약품의 `itemSeq` 기준 DUR 병용금기를 적재한다.
- batch는 `medicationLimit`과 `medicationOffset`으로 나눠 실행한다. 한 번에 너무 크게 돌리지 말고 20~50개 단위로 시작한다.
- `analyze-medication`: 사용자 OCR 흐름에서 내부 DB에 없는 약품 후보를 즉시 cache-aside 저장
- `gemini-chat`: 상호작용 DB에 근거가 없으면 안전하다고 답하지 않음

제외 또는 후순위:

- 보호자 원격 모니터링
- 건강정보 기반 광고
- 자동 약물 상호작용 단정
- 처방전 이미지 장기 보관
- 수동 약 검색
- 병원/약국 제휴 수익화

이 순서가 안전한 이유는 개인정보와 의료 오안내 리스크가 큰 기능을 초기 범위에서 줄이고, 핵심 가치인 “사진 한 장으로 쉬운 복약 정보 제공”에 집중할 수 있기 때문이다.
