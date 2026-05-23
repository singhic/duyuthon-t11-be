# medication-logs-check

## Purpose

사용자가 복용 완료 버튼을 눌렀을 때 해당 일정의 복용 로그가 저장되는지 검증한다.

## Input

```json
{
  "userMedicationId": "temporary-user-medication-id",
  "scheduleId": "temporary-schedule-id",
  "plannedDate": "2026-05-23",
  "plannedTime": "14:24:38",
  "status": "taken"
}
```

## Output

```json
{
  "logId": "temporary-log-id",
  "status": "taken",
  "takenAt": "2026-05-23T14:19:45.307+09:00",
  "plannedDate": "2026-05-23",
  "plannedTime": "14:24:38"
}
```

## Result

PASS. 복용 완료 로그가 정상 저장됐다.
