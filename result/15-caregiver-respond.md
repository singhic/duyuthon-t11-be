# caregiver-respond

## Purpose

보호자가 초대를 수락하는 흐름을 검증한다.

## Input

```json
{
  "caregiverLinkId": "temporary-caregiver-link-id",
  "action": "accepted"
}
```

## Output

```json
{
  "caregiverLinkId": "temporary-caregiver-link-id",
  "status": "accepted",
  "consentedAt": "2026-05-23T14:19:56.861+09:00",
  "revokedAt": null
}
```

## Result

PASS. 보호자 연결 상태가 `accepted`로 변경됐다.
