# send-medication-reminders

## Purpose

복약 알림 발송 대상 조회를 검증한다. 실제 FCM 전송은 하지 않고 `dryRun=true`로 테스트했다.

## Input

```json
{
  "dryRun": true,
  "includeReminders": true,
  "windowStart": "2026-05-23T14:23:38+09:00",
  "windowEnd": "2026-05-23T14:25:38+09:00",
  "targetUserId": "temporary-patient-user-id"
}
```

## Output

```json
{
  "dryRun": true,
  "pendingCount": 1,
  "sentCount": 0,
  "failedCount": 0,
  "skippedCount": 0,
  "reminderCount": 1,
  "message": "FCM dry-run입니다. 실제 푸시는 전송하지 않고 발송 대상만 계산했습니다."
}
```

## Result

PASS. 지정된 시간창에서 복약 알림 대상 1건이 계산됐다.
