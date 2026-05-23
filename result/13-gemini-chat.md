# gemini-chat

## Purpose

복약 컨텍스트를 기반으로 사용자의 추가 질문에 답하는지 검증한다.

## Input

```json
{
  "question": "이거 밥먹고 먹어야해요?",
  "scanId": "controlled-scan-id"
}
```

## Output

```json
{
  "answer": "네, 스캔 결과에 따르면 타이레놀8시간이알서방정은 아침 식사 후 1정, 저녁 식사 후 1정 드시는 것으로 되어 있습니다. 밥 먹고 나서 드시면 됩니다.",
  "safetyLevel": "info",
  "needsDoctorOrPharmacist": false,
  "citedMedicationIds": ["detected-medication-id"],
  "citedInteractionIds": [],
  "disclaimer": "이 답변은 참고용이며, AI 답변은 틀릴 수 있습니다. 정확한 복약 정보는 반드시 의사 또는 약사에게 확인하세요."
}
```

## Result

PASS. OCR 컨텍스트의 “식후” 정보를 근거로 답변했고, disclaimer도 포함했다.
