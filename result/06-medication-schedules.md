# medication-schedules

## Purpose

복약 일정 생성, 조회, 수정 기능을 검증한다.

## Input

```json
{
  "create": {
    "userMedicationId": "temporary-user-medication-id",
    "takeTime": "14:24:38",
    "timingRule": "after_meal",
    "doseAmount": 1,
    "doseUnit": "정",
    "daysOfWeek": [6],
    "startDate": "2026-05-23",
    "notificationEnabled": true
  },
  "getQuery": "userMedicationId=<id>&active=true",
  "patch": {
    "scheduleId": "temporary-schedule-id",
    "doseAmount": 2,
    "doseUnit": "정"
  }
}
```

## Output

```json
{
  "createdScheduleId": "temporary-schedule-id",
  "listCount": 1,
  "patchedDoseAmount": 2,
  "patchedDoseUnit": "정",
  "active": true,
  "takeTime": "14:24:38"
}
```

## Result

PASS. 일정 생성, 조회, 수정이 정상 동작했다.
