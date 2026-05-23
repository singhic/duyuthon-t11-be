# suggest-medication-schedules

## Purpose

OCR 텍스트 또는 공공 DB 복용법에서 복약 일정 후보를 생성한다.

## Input

```json
{
  "userMedicationId": "temporary-user-medication-id",
  "scanId": "controlled-scan-id"
}
```

## Output

```json
{
  "medicationName": "타이레놀8시간이알서방정(아세트아미노펜)",
  "suggestionCount": 2,
  "needsUserConfirmation": true,
  "firstSuggestion": {
    "takeTime": "08:00:00",
    "timingRule": "after_meal",
    "doseAmount": 1,
    "doseUnit": "정",
    "daysOfWeek": [0, 1, 2, 3, 4, 5, 6],
    "source": "ocr",
    "confidence": "medium",
    "reason": "아침 복용 표현을 인식했습니다. 사용자가 실제 처방 지시와 맞는지 확인해야 합니다."
  }
}
```

## Result

PASS. 아침/저녁 식후 1정 후보가 생성됐다. 사용자가 확인해야 하는 흐름도 유지됐다.
