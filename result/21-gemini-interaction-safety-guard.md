# gemini-chat Interaction Safety Guard

## Purpose

상호작용 질문에서 내부 DB 근거가 부족할 때 Gemini가 추측 답변을 생성하지 않는지 검증했다.

## Code Change

수정 파일:

- `supabase/functions/gemini-chat/index.ts`
- `supabase/functions/_shared/gemini.ts`

핵심 변경:

- 상호작용 질문 감지
- active medication + scan medication에서 공식 DB 매칭 약품 ID 수집
- 약품 2개 미만 또는 성분 정보 부족 시 `interactionEvidence.mode = "insufficient_context"` 반환
- 이 경우 Gemini 호출 없이 deterministic safety guard 응답 반환
- 상호작용 DB에 경고가 없더라도 `isConfirmedSafe = false` 유지

## Deployment

```text
Deployed Functions on project hygsrrmoawezonahnljn: gemini-chat
```

## Input

```json
{
  "question": "타이레놀과 이부프로펜 같이 먹어도 돼?"
}
```

조건:

- 임시 patient user
- 등록된 현재 복용약 없음
- scan context 없음

## Output

```json
{
  "chatSessionId": "7fbd899b-c877-4859-a33d-8673a109dbe7",
  "answer": "상호작용을 판단하려면 공식 DB에 매칭된 약이 2개 이상 필요합니다. 현재 정보만으로는 함께 복용 가능 여부를 답할 수 없습니다. AI 답변은 틀릴 수 있으니, 정확한 복약 가능 여부는 의사 또는 약사에게 확인하세요.",
  "safetyLevel": "caution",
  "needsDoctorOrPharmacist": true,
  "citedMedicationIds": [],
  "citedInteractionIds": [],
  "disclaimer": "이 정보는 참고용이며 AI 답변은 틀릴 수 있습니다. 정확한 복약 방법과 약물 상호작용은 의사 또는 약사에게 확인하세요.",
  "interactionEvidence": {
    "mode": "insufficient_context",
    "checkedMedicationIds": [],
    "interactions": [],
    "message": "상호작용을 판단하려면 공식 DB에 매칭된 약이 2개 이상 필요합니다. 현재 정보만으로는 함께 복용 가능 여부를 답할 수 없습니다.",
    "isConfirmedSafe": false
  }
}
```

## Result

PASS.

상호작용 질문에 대해 근거가 부족한 경우 Gemini 추론을 사용하지 않고, 함께 복용 가능 여부를 답하지 않는 정책이 원격에서 확인됐다.
