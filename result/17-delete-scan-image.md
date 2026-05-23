# delete-scan-image

## Purpose

스캔 이미지 삭제 함수가 Storage 객체와 `scan_sessions.image_path`를 정리하는지 검증한다.

## Input

```json
{
  "scanId": "temporary-scan-id"
}
```

테스트 파일:

```text
images/pill_1.jpg
```

## Output

```json
{
  "scanId": "temporary-scan-id",
  "deleted": true,
  "imagePath": null
}
```

## Result

PASS. 이미지 삭제가 정상 처리됐고 응답에서 `imagePath`가 `null`로 반환됐다.
