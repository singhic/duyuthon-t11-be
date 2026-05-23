# google-ocr

## Purpose

Storage에 업로드된 처방전/약 이미지에서 Google OCR을 실행하고, OCR 텍스트와 약국 후보 정보를 `scan_sessions`에 저장한다.

## Success Input

```json
{
  "scanId": "temporary-scan-id",
  "uploadedPath": "{user_id}/{scan_id}/original.jpeg",
  "contentType": "image/jpeg",
  "localFile": "images/prescription_1.jpeg"
}
```

호출 권한: patient user JWT

## Success Output

```json
{
  "scanId": "temporary-scan-id",
  "ocrTextLength": 15,
  "confidence": 0.6132253799999999,
  "imageDeleted": true,
  "needsManualReview": true,
  "failureReason": "low_ocr_confidence",
  "pharmacyContact": null,
  "recommendedAction": "OCR 신뢰도가 낮습니다. 인식된 약 이름과 복용법을 사용자가 직접 확인해야 합니다."
}
```

## Error Input

```json
{
  "scanId": "temporary-scan-id",
  "imagePath": "{user_id}/{scan_id}/original.heic"
}
```

## Error Output

```json
{
  "status": 400,
  "error": "unsupported_image_type",
  "details": {
    "message": "jpg, jpeg, png 이미지만 OCR 처리할 수 있습니다.",
    "allowedExtensions": ["jpg", "jpeg", "png"]
  }
}
```

## Result

PASS. OCR 함수는 정상 호출됐고 원본 이미지는 삭제됐다. 테스트 이미지의 OCR confidence가 낮아 수동 확인 상태가 됐다. 지원하지 않는 확장자는 의도대로 차단됐다.
