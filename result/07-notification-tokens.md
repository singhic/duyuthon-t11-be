# notification-tokens

## Purpose

사용자 FCM 토큰 저장 및 조회를 검증한다.

## Input

```json
{
  "token": "fake-fcm-token",
  "provider": "fcm",
  "platform": "android",
  "timezone": "Asia/Seoul"
}
```

## Output

```json
{
  "savedTokenId": "temporary-token-id",
  "provider": "fcm",
  "platform": "android",
  "enabled": true,
  "listedCount": 1
}
```

## Result

PASS. 토큰 저장과 목록 조회가 정상 동작했다.
