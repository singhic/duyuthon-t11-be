# redact-expired-sensitive-data

## Purpose

만료된 OCR/채팅 민감정보 정리 대상을 dry-run으로 확인한다.

## Input

```json
{
  "dryRun": true
}
```

호출 권한: admin user JWT

## Output

```json
{
  "dryRun": true,
  "scannedAt": "2026-05-23T05:20:00.497Z",
  "targets": {
    "scanOcrTextCount": 0,
    "ocrResultCount": 0,
    "chatMessageCount": 0
  },
  "message": "dryRun=true 이므로 실제 민감정보는 삭제하지 않았습니다."
}
```

## Result

PASS. dry-run 기준 삭제 대상은 없었다.
