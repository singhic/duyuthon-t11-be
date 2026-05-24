# 이약뭐지 현재 구현 냉정 평가

작성일: 2026-05-23  
운영 재검증: 2026-05-24 15:16 KST
기준 프로젝트: `hygsrrmoawezonahnljn`  
평가 기준: 원격 Supabase Edge Function 배포 상태, `result/` 테스트 로그, 현재 백엔드 코드, `introduce.md`의 MVP 목표

## 1. 결론

현재 백엔드는 MVP 사용자 흐름을 검증할 수 있는 수준까지는 올라왔다.

가능한 흐름:

```text
로그인
→ 이미지 업로드
→ OCR
→ 약품 후보 분석
→ 공공 의약품 DB 기반 약 정보 저장
→ 현재 복용약 등록
→ 복약 일정 생성
→ 오늘 체크리스트 조회
→ 복용 완료 기록
→ 리포트 조회
→ 챗봇 질문
→ 상호작용 근거 부족 시 차단
```

하지만 “프로덕션 공개 가능”이라고 말하기에는 아직 이르다. 기능은 꽤 갖춰졌고 scheduled job도 등록되었지만, 실제 OCR 품질 검증, 전체 의약품/DUR 데이터 커버리지 완료, 실제 FCM 단말 검증, 의료/법무 검토가 부족하다.

즉 현재 상태는 다음에 가깝다.

```text
백엔드 MVP 기능 검증 완료
운영 자동화 일부 동작 확인
프로덕션 공개 준비는 미완료
```

2026-05-24 운영 스냅샷 기준:

| 구분 | 현재 상태 |
|---|---|
| Migration | local/remote 일치 |
| Edge Functions | 핵심 함수 원격 ACTIVE |
| Scheduled jobs | `maintenance-runner` 호출 cron 4개 active |
| Reminder cron | 15분마다 `dryRun=true`, 최근 pg_net 응답 200 |
| Redaction | OCR 원문/결과/채팅 및 만료 scan 이미지 정리 구현, daily cron은 `dryRun=true` |
| Medications | 848건, `item_seq` 848건 |
| 약품 주요 누락 | 효능/복용법/주의사항/보관법 각 4건 |
| DUR | `sync_dur_known_medications` cursor 52/848 진행 |
| Drug interactions | 총 19건, DUR source 18건 |
| FCM token | 0건, 실발송 전환 금지 |
| Gemini safety regression | `safetyIntent` 적용 후 8-case PASS |

## 2. 잘 구현된 부분

### 2.1 Supabase DB 구조

현재 DB 구조는 MVP 기능을 담기에 충분하다.

좋은 점:

- 사용자 프로필, 스캔 세션, OCR job, 약품 마스터, 성분, 사용자 복용약, 일정, 복용 로그, 채팅, 보호자 링크, API 사용 로그가 분리되어 있다.
- `medications`, `ingredients`, `medication_ingredients` 구조가 약품-성분 관계를 표현한다.
- `drug_interactions`가 성분 pair 기준으로 설계되어 DUR 병용금기 데이터를 넣기 적절하다.
- `scan_sessions`와 `scan_detected_medications`가 OCR 원문과 약품 후보 분석 결과를 분리한다.
- RLS 기반으로 사용자별 데이터 분리가 가능하다.
- `api_usage_logs`가 있어 Google OCR, Gemini, data.go.kr 호출 추적이 가능하다.
- 민감정보 삭제를 위한 컬럼과 `redact-expired-sensitive-data` 함수가 존재한다.
- 만료된 scan session에 원본 이미지가 남은 경우 `prescription-temp` Storage object를 TTL 기준으로 정리하는 fallback이 구현되어 있다. 단, row 자체 삭제가 아니라 `image_path=null`, `image_deleted_at` 기록 방식이며 운영 실삭제는 승인 전까지 `dryRun=true`로 유지한다.

냉정한 판단:

```text
DB 구조는 지금 고정해도 된다.
단, 운영 자동화와 데이터 품질 확보는 DB 구조가 아니라 운영 파이프라인 문제다.
```

### 2.2 Edge Function 배포 상태

현재 주요 Edge Function은 원격에서 `ACTIVE` 상태다.

핵심 함수:

- `google-ocr`
- `analyze-medication`
- `confirm-medication`
- `suggest-medication-schedules`
- `medication-schedules`
- `medication-checklist`
- `medication-logs-check`
- `medication-report`
- `gemini-chat`
- `check-interactions`
- `sync-drug-master`
- `sync-dur-interactions`
- `send-medication-reminders`
- `notification-tokens`
- `redact-expired-sensitive-data`
- `caregiver-*`

좋은 점:

- 원격 함수 배포와 실제 호출 테스트가 완료됐다.
- `sync-dur-interactions`는 최신 DUR 명세 기준 endpoint로 수정됐고 원격 `ACTIVE` 상태다.
- `gemini-chat`은 상호작용 질문에서 근거 부족 시 Gemini 추론을 막고, `safetyIntent` guard로 용량 변경/중단/음주/임신/응급/프롬프트 공격을 deterministic하게 차단한다.

### 2.3 OCR 흐름

현재 `google-ocr`은 다음을 처리한다.

- `jpg`, `jpeg`, `png`만 허용
- Google OCR 호출
- OCR 원문 저장
- confidence 저장
- 저신뢰도/빈 텍스트 판단
- OCR 후 이미지 삭제
- 약국명/전화번호/주소 후보 추출
- `pharmacies` 저장 및 `scan_sessions.pharmacy_id` 연결

좋은 점:

- OCR 실패/저신뢰도 상태가 명확하다.
- 프론트가 `needsManualReview`, `failureReason`, `recommendedAction`으로 화면 분기를 할 수 있다.
- 약국 연락처는 공공 약국 DB 없이도 OCR 기반으로 최소 안내가 가능하다.

부족한 점:

- 실제 처방전 이미지 테스트에서 confidence가 `0.6132`로 낮았다.
- 약국 정보 추출은 OCR 텍스트 품질에 의존한다.
- 처방전, 약봉투, 알약 포장별 OCR 테스트셋이 아직 작다.
- OCR 결과에서 약 이름과 복약 지시를 구조화하는 품질 검증이 부족하다.

판단:

```text
OCR 함수는 동작한다.
하지만 실제 사용자 사진에서 안정적으로 약 이름/약국 정보를 잡는지는 아직 증명되지 않았다.
```

### 2.4 약 정보 적재

약 정보는 두 경로로 적재된다.

```text
sync-drug-master
→ 운영자/배치 기반 약품 마스터 적재

analyze-medication
→ OCR 후보가 내부 DB에 없을 때 공공 의약품 API cache-aside 조회 후 저장
```

좋은 점:

- 사전 적재와 실시간 보강이 모두 있다.
- `medications`에 효능, 복용법, 주의사항, 보관법, 식전/식후 추정 정보가 들어간다.
- 공공 API 실패 시 분석 전체가 죽지 않고 `publicLookup.status`로 상태를 반환한다.
- OCR confidence가 낮으면 무리한 공공 API 조회를 막는다.

부족한 점:

- 공공 의약품 API에서 내려오는 문장이 사용자 친화적이지 않을 수 있다.
- 약품명 fuzzy matching은 실제 처방전 OCR 노이즈가 쌓일수록 더 튜닝이 필요하다.
- 전체 의약품 마스터가 완전 적재된 상태인지 아직 확정되지 않았다.
- 성분 파싱 품질이 약품별로 다를 수 있다.

판단:

```text
약 정보 적재 구조는 좋다.
다만 데이터 품질 검증과 전체 적재 운영이 남았다.
```

### 2.5 DUR 상호작용 적재

현재 `sync-dur-interactions`는 다음 모드를 지원한다.

```text
page mode
itemSeq 단건 mode
syncKnownMedications=true batch mode
```

최신 명세 기준 endpoint:

```text
https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getUsjntTabooInfoList03
```

검증 결과:

```json
{
  "mode": "known_medications",
  "medicationBatchCount": 2,
  "medicationTotalCount": 848,
  "apiRequestCount": 2,
  "apiItemCount": 20,
  "insertedOrUpdatedCount": 20,
  "skippedCount": 0
}
```

좋은 점:

- 구버전 endpoint 문제를 잡고 수정했다.
- 이미 적재된 `medications.item_seq`를 기준으로 DUR도 따라 적재할 수 있다.
- `drug_interactions`에 실제 데이터가 들어가는 것을 확인했다.
- batch 크기와 offset을 조절할 수 있어 운영 확장이 가능하다.

부족한 점:

- 아직 전체 848개 약품에 대해 DUR batch를 모두 돌린 것은 아니다.
- 정기 스케줄러는 등록되었지만 전체 순회 완료 전이다.
- `medicationLimit=20`에서 `IDLE_TIMEOUT` 실패 이력이 있어 현재는 `medicationLimit=10`으로 운영한다.
- `sync_job_runs`로 offset과 실패 원인을 추적한다.

판단:

```text
DUR 적재 함수는 이제 방향이 맞다.
하지만 자동 운영 파이프라인은 아직 수동 batch 수준이다.
```

### 2.6 챗봇 안전성

현재 `gemini-chat`은 다음을 한다.

- 현재 복용약과 scan 약품 정보를 컨텍스트로 구성
- 공식 DB 밖 내용 단정 금지 프롬프트 적용
- 탈옥/프롬프트 공개/무관한 고민 상담 거절
- AI 답변이 틀릴 수 있다는 disclaimer 강제
- 상호작용 질문 감지
- 근거 부족 시 Gemini 호출 없이 deterministic safety guard 응답

검증된 안전 가드 응답:

```text
상호작용을 판단하려면 공식 DB에 매칭된 약이 2개 이상 필요합니다.
현재 정보만으로는 함께 복용 가능 여부를 답할 수 없습니다.
AI 답변은 틀릴 수 있으니, 정확한 복약 가능 여부는 의사 또는 약사에게 확인하세요.
```

좋은 점:

- “정보 없음”을 “안전함”으로 말하지 않는다.
- `isConfirmedSafe=false`를 유지한다.
- 상호작용 질문에서 근거가 부족하면 Gemini 추론을 차단한다.
- 프롬프트와 코드 가드가 동시에 존재한다.

부족한 점:

- 상호작용 질문 감지는 정규식 기반이라 더 많은 표현을 놓칠 수 있다.
- Gemini가 받은 공공 DB 원문을 사용자 친화적으로 요약하는 품질은 아직 대규모 검증이 필요하다.
- 의료 전문가 리뷰를 거친 답변 템플릿이 부족하다.
- 챗봇 regression test suite가 없다.

판단:

```text
현재 챗봇은 MVP 기준 안전 장치가 꽤 좋다.
하지만 의료 서비스로 공개하려면 질문 테스트셋과 전문가 리뷰가 필요하다.
```

### 2.7 복약 일정, 체크리스트, 로그

현재 가능한 흐름:

```text
confirm-medication
→ suggest-medication-schedules
→ medication-schedules 생성
→ medication-checklist 조회
→ medication-logs-check 기록
→ medication-report 집계
```

좋은 점:

- 사용자 확인 후 현재 복용약 등록이라는 안전한 순서를 따른다.
- 복약 일정 생성과 복용 완료 체크가 분리되어 있다.
- 당일 체크리스트와 리포트 집계가 가능하다.
- 중복 로그 방지 구조가 있다.

부족한 점:

- 실제 푸시 발송은 아직 production 검증이 아니다.
- 복용법 원문에서 일정 후보를 추출하는 로직은 약품별 튜닝이 필요하다.
- 프론트 UX 없이 실제 사용자가 일정 수정/삭제/스킵하는 흐름은 검증되지 않았다.

판단:

```text
복약 관리 백엔드 기본기는 있다.
실제 알림과 사용자 UX 검증이 남았다.
```

### 2.8 FCM 알림

현재 구현:

- `notification-tokens`
- `send-medication-reminders`
- dry-run 대상 조회
- delivery 중복 방지 구조
- invalid token 비활성화 로직

좋은 점:

- 서버 쪽 알림 대상 계산과 중복 방지 구조가 있다.
- dry-run으로 운영 전 대상 검증이 가능하다.

부족한 점:

- 실제 앱 단말 FCM token 수신이 아직 검증되지 않았다.
- 실제 `dryRun=false` 발송 테스트가 프로덕션 단말에서 완료되지 않았다.
- 알림 스케줄러는 등록되어 있고 15분마다 `dryRun=true`로 200 응답을 반환한다.

판단:

```text
FCM 백엔드 준비는 되어 있지만, 실제 알림 기능 완성이라고 보기는 어렵다.
앱 단말 검증 전까지는 dry-run 수준이다.
```

### 2.9 보호자 기능

현재 구현:

- `caregiver-invite`
- `caregiver-respond`
- `caregiver-status`
- 승인/거절 테스트 통과

좋은 점:

- 보호자 링크의 최소 흐름이 있다.
- 보호자 기능을 쓰기 위한 DB와 API 기반이 있다.

부족한 점:

- 실제 보호자가 무엇을 읽을 수 있는지 프론트 정책이 확정되어야 한다.
- 보호자 알림은 아직 붙지 않았다.
- 동의 철회/재초대/만료 정책이 더 필요하다.

판단:

```text
보호자 기능은 MVP 이후 확장 기반이다.
지금 핵심 사용자 흐름에는 넣지 않는 것이 안전하다.
```

## 3. 가장 큰 리스크

### 3.1 OCR 품질 리스크

현재 가장 큰 제품 리스크다.

이 서비스의 핵심은 “사진 한 장”인데 실제 테스트 이미지에서 OCR confidence가 낮았다. 백엔드가 잘 동작해도 OCR이 약명을 못 잡으면 사용자 가치는 급격히 떨어진다.

필요한 것:

- 실제 처방전 30장 이상
- 약봉투 30장 이상
- 알약 포장/상자 30장 이상
- 흐림/어두움/기울어짐/부분 가림 케이스
- OCR 결과와 정답 약품명 비교

### 3.2 데이터 커버리지 리스크

약 정보와 DUR 모두 적재 구조는 생겼지만 전체 데이터가 충분히 찼는지는 별도 문제다.

필요한 것:

- 주요 약품 마스터 batch 적재
- `medications.item_seq` 기준 DUR batch 전체 실행
- 실패 offset 재시도
- 적재율 리포트

### 3.3 의료 오안내 리스크

상호작용 safety guard는 좋아졌지만, 챗봇은 여전히 AI다.

필요한 것:

- 금지 답변 테스트셋
- 약사/전문가 리뷰
- “모름” 답변이 충분히 자주 나오는지 검증
- 복용량 변경/중단/대체 권고 차단 검증

### 3.4 운영 자동화 리스크

scheduled job은 실제 운영 DB에 등록되어 있다. 다만 모든 job의 장기 성공 이력과 장애 알림은 아직 충분하지 않다.

필요한 것:

- `sync-drug-master` 정기 실행 이력 추적
- `sync-dur-interactions syncKnownMedications=true` 전체 순회 완료
- `send-medication-reminders`는 프론트 token 전까지 `dryRun=true` 유지
- `redact-expired-sensitive-data`는 운영자 승인 전까지 `dryRun=true` 유지
- 실패 알림

### 3.5 실제 프론트 통합 리스크

백엔드가 맞아도 프론트가 다음을 잘못하면 위험하다.

- `no_registered_warning`을 “안전”으로 표시
- `needsManualReview=true`인데 자동 등록
- `null` 복용법을 프론트에서 추측
- Gemini disclaimer 숨김
- OCR 후 `analyze-medication` 호출 누락

프론트 구현 전 연동 가이드를 반드시 따라야 한다.

## 4. 현재 상태 등급

| 영역 | 평가 | 이유 |
|---|---|---|
| DB 구조 | 좋음 | MVP 기능을 담기에 충분하고 RLS 기반 분리 가능 |
| OCR API | 보통 | 함수는 동작하나 실제 이미지 품질 검증 부족 |
| 약품 분석 | 좋음 | 내부 DB + 공공 API cache-aside 구조 확보 |
| DUR 상호작용 | 보통 이상 | 최신 endpoint 수정 및 batch 적재 가능, cursor 52/848 진행 중 |
| 챗봇 안전성 | 좋음 | `safetyIntent` 적용 후 8-case regression PASS |
| 복약 일정/로그 | 좋음 | 기본 플로우 원격 통과 |
| FCM | 보통 이하 | dry-run 수준, 실제 단말 검증 필요 |
| 보호자 | 보통 | 최소 기능만 있음 |
| 운영 자동화 | 보통 | scheduled job 등록 및 reminder dry-run 200 확인, 전체 운영 이력은 더 필요 |
| 프로덕션 준비 | 부족 | QA, 법무, 모니터링, 실제 OCR 데이터 필요 |

## 5. 최종 평가

현재 구현은 “기능을 세운 백엔드 MVP”로는 잘 되어 있다.

하지만 “사용자에게 의료/복약 안전 기능으로 공개”하려면 아직 다음이 부족하다.

```text
실제 OCR 품질 검증
약품/DUR 데이터 전체 적재
정기 동기화 전체 순회와 실패 알림
실제 FCM 단말 테스트
챗봇 금지 답변 regression 지속 운영
의료 전문가/법무 검토
운영 모니터링과 실패 알림
```

가장 중요한 원칙은 유지되어야 한다.

```text
모르면 답하지 않는다.
DB에 경고가 없다는 말은 안전하다는 뜻이 아니다.
사용자가 확인하지 않은 약은 자동 등록하지 않는다.
AI 답변은 항상 참고용이다.
```
