# Edge Function Test Results

테스트 일시: 2026-05-23 05:20:02 UTC  
프로젝트: `hygsrrmoawezonahnljn`  
방식: 원격 Supabase에 임시 `patient`, `caregiver`, `admin` 사용자를 생성해 실제 Edge Function을 순차 호출했다. 테스트 종료 후 임시 auth user는 삭제했다.

주의: 원시 PowerShell 출력에서 `input` 필드는 PowerShell 예약 변수 충돌로 `Current:null`로 찍혔다. 각 MD 파일의 Input은 실제 호출 파라미터 기준으로 다시 정리했다.

## Summary

| Function | Result |
|---|---|
| `sync-drug-master` | PASS |
| `google-ocr` | PASS |
| `analyze-medication` | PASS |
| `confirm-medication` | PASS |
| `suggest-medication-schedules` | PASS |
| `medication-schedules` | PASS |
| `notification-tokens` | PASS |
| `send-medication-reminders` | PASS dry-run |
| `medication-checklist` | PASS |
| `medication-logs-check` | PASS |
| `medication-report` | PASS |
| `check-interactions` | PASS |
| `gemini-chat` | PASS |
| `caregiver-invite` | PASS |
| `caregiver-respond` | PASS |
| `caregiver-status` | PASS |
| `delete-scan-image` | PASS |
| `redact-expired-sensitive-data` | PASS dry-run |
| `sync-dur-interactions` | PASS after endpoint fix to `DURPrdlstInfoService03/getUsjntTabooInfoList03` |
| `gemini-chat interaction safety guard` | PASS |
| `sync-dur-interactions known medications batch` | PASS |

## User Flow Verdict

회원가입/로그인 후 이미지 업로드, OCR 호출, 약품 분석, 현재 복용약 등록, 일정 생성, 알림 대상 계산, 체크리스트 조회, 복용 완료 체크, 리포트 집계, 챗봇 질문 흐름은 원격 기준으로 동작했다.

실제 처방전 이미지 `images/prescription_1.jpeg`는 OCR 자체는 성공했지만 confidence가 `0.6132`로 낮아 수동 확인 상태가 됐다. downstream 테스트는 안정성을 위해 통제된 OCR 텍스트 scan으로 진행했다.

## Retest Updates

- `sync-dur-interactions` 초기 실패 원인은 구버전 DUR endpoint 사용이었다. 최신 명세 기준 `DURPrdlstInfoService03/getUsjntTabooInfoList03`로 수정 후 원격 호출이 성공했다.
- `sync-dur-interactions`에 `syncKnownMedications=true` batch 모드를 추가했다. 이미 적재된 `medications.item_seq`를 기준으로 DUR 병용금기 정보를 따라 적재한다.
- `gemini-chat`은 상호작용 질문에서 공식 DB 근거가 부족하면 Gemini 추론 없이 “답할 수 없음/전문가 확인”으로 차단한다.
