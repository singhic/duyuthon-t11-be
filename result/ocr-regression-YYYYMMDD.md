# OCR Regression YYYYMMDD

## Purpose

프론트 실제 촬영/업로드 UX가 붙은 뒤 이미지 기반 OCR 품질을 반복 측정한다.

## Dataset Summary

| Type | Count |
|---|---:|
| prescription | 0 |
| pharmacy_bag | 0 |
| pill_package | 0 |
| blurry | 0 |
| dark | 0 |
| tilted | 0 |

## Metrics

| Metric | Value |
|---|---:|
| medication_name_recall | N/A |
| pharmacy_name_extraction_rate | N/A |
| pharmacy_phone_extraction_rate | N/A |
| low_confidence_rate | N/A |
| manual_review_rate | N/A |

## Case Results

| Case ID | Type | Expected Medications | Detected Medications | Confidence | Result | Notes |
|---|---|---|---|---:|---|---|

## Findings

- 실제 프론트 촬영 이미지가 들어오면 `ocr-test-cases/manifest.json`에 case를 추가한다.
- `needsManualReview=true` 또는 `failureReason`이 있는 케이스를 실패 유형별로 묶는다.
- 재촬영 안내 기준은 confidence와 약품명 recall을 함께 보고 조정한다.
