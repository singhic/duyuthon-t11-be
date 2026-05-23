# analyze-medication

## Purpose

OCR 텍스트에서 약품 후보를 추출하고, 내부 의약품 DB 및 공공 DB cache-aside를 통해 약품 정보를 매칭한다.

## Input

```json
{
  "scanId": "controlled-scan-id"
}
```

테스트 OCR 텍스트:

```text
타이레놀8시간이알서방정(아세트아미노펜)
아침 식후 1정
저녁 식후 1정
```

## Output

```json
{
  "resultMode": "review_required",
  "matchQuality": "high",
  "candidates": [
    "타이레놀8시간이알서방정(아세트아미노펜)",
    "타이레놀8시간이알서방정",
    "아침 식후 1정",
    "저녁 식후 1정"
  ],
  "unmatchedCandidates": [
    "아침 식후 1정",
    "저녁 식후 1정"
  ],
  "detectedCount": 4,
  "needsUserConfirmation": true,
  "publicLookup": {
    "attempted": false,
    "status": "not_needed",
    "queriedCandidates": [],
    "insertedMedicationCount": 0,
    "message": "공공 API 조회 조건을 만족하는 약품 후보가 없습니다."
  },
  "firstDetected": {
    "medicationName": "타이레놀8시간이알서방정(아세트아미노펜)",
    "match_quality": "high",
    "needs_confirmation": false,
    "dosagePresent": true,
    "precautionsPresent": true
  }
}
```

## Result

PASS. 약품명은 고품질로 매칭됐고 복용법/주의사항 데이터도 포함됐다. 복용 시간 문장도 후보로 잡혀 `review_required`가 됐는데, 이는 자동 등록 방지 관점에서 안전한 동작이다.
